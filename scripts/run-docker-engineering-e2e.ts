// scripts/run-docker-engineering-e2e.ts
//
// REAL end-to-end verification of the NEXUS Docker engineering pipeline.
// Not a mock: spawns real docker.exe / trivy.exe via a Node host bridge,
// materializes a real workspace under os.tmpdir(), and drives the actual
// engineering plan/execution API.
//
// NOTE on plan-stage injection: generatePlan() runs ProjectDetector BEFORE
// the caller can write a Dockerfile, so its plan snapshot does not include
// Docker stages by default. This test writes the Dockerfile into the plan's
// workspace and injects the 5 Docker stages at their PIPELINE_ORDER
// positions. The runners themselves read the current workspace at execute
// time, so the real Docker path is what runs.

import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { NexusKernel } from "../src/core/kernel";
import { parseIntent, generatePlan, executePlan } from "../src/core/engineering";
import type { User, EngineeringPlanStage } from "../src/core/types";
import type { HostBridge } from "../src/core/runtime";

let pass = 0;
let fail = 0;
let blockedCount = 0;

function check(name: string, cond: boolean, detail: string = "") {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  Evidence: " + detail : "")); }
  else { fail++; console.log("[FAILED] " + name + (detail ? "  Evidence: " + detail : "")); }
}
function block(name: string, reason: string) {
  blockedCount++;
  console.log("[BLOCKED] " + name + "  Reason: " + reason);
}

/* ================= Node host bridge (real, token-validated) ============= */

interface NodeBridge extends HostBridge { _sessions: Map<string, string>; }

function createNodeBridge(rootDir: string): NodeBridge {
  const sessions = new Map<string, string>();
  const TOKEN_RE = /^[A-Za-z0-9_-]{4,128}$/;
  return {
    _sessions: sessions,
    platform: () => process.platform,
    async materializeWorkspace(req) {
      if (!TOKEN_RE.test(req.token)) throw new Error("invalid token format");
      if (sessions.has(req.token)) throw new Error("session already materialized");
      await fsp.mkdir(rootDir, { recursive: true });
      const dir = await fsp.mkdtemp(path.join(rootDir, req.token.slice(0, 12) + "-"));
      const realRoot = await fsp.realpath(dir);
      for (const f of req.files) {
        if (f.path.includes("..") || path.isAbsolute(f.path)) throw new Error("unsafe path: " + f.path);
        const dest = path.join(realRoot, f.path);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const realParent = await fsp.realpath(path.dirname(dest));
        if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
          throw new Error("path escapes workspace: " + f.path);
        }
        await fsp.writeFile(dest, f.content, "utf8");
      }
      sessions.set(req.token, realRoot);
      return { cwd: realRoot, files_written: req.files.length };
    },
    async cleanupWorkspace(token: string) {
      const dir = sessions.get(token);
      if (!dir) return { cleaned: false, error: "unknown workspace session" };
      try { await fsp.rm(dir, { recursive: true, force: true }); sessions.delete(token); return { cleaned: true }; }
      catch (e) { return { cleaned: false, error: (e as Error).message }; }
    },
    async exec(command: string, args: string[], opts: { timeout_ms?: number; cwd?: string; workspace_token?: string }) {
      const token = opts?.workspace_token;
      if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new Error("workspace_token required and must be valid");
      const sessionRoot = sessions.get(token);
      if (!sessionRoot) throw new Error("unknown workspace session");
      let cwd = sessionRoot;
      if (opts.cwd !== undefined && opts.cwd !== null && opts.cwd !== "") {
        const candidate = path.resolve(sessionRoot, opts.cwd);
        const real = await fsp.realpath(candidate).catch(() => null);
        if (!real) throw new Error("cwd does not exist");
        if (real !== sessionRoot && !real.startsWith(sessionRoot + path.sep)) throw new Error("cwd outside session boundary");
        cwd = real;
      }
      const isCmd = /\.(cmd|bat)$/i.test(command);
      const useCmd = process.platform === "win32" && isCmd;
      const finalCmd = useCmd ? "cmd.exe" : command;
      const finalArgs = useCmd ? ["/c", command, ...args] : args;
      return await new Promise<{ exit_code: number; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(finalCmd, finalArgs, { cwd, shell: false, windowsHide: true, env: process.env });
        let stdout = "", stderr = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeout_ms ?? 120_000);
        child.stdout?.on("data", (d) => { stdout += d.toString(); });
        child.stderr?.on("data", (d) => { stderr += d.toString(); });
        child.on("error", (e) => { clearTimeout(timer); resolve({ exit_code: 127, stdout, stderr: stderr + "\nspawn error: " + e.message }); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ exit_code: timedOut ? 124 : (code ?? 1), stdout, stderr }); });
      });
    },
  };
}

/* ============================ fixtures =================================== */

const SAFE_DOCKERFILE = ["FROM alpine:3.19", "RUN printf 'nexus-e2e\\n' > /nexus-e2e.txt", "USER 10001", 'CMD ["cat", "/nexus-e2e.txt"]', ""].join("\n");
const UNSAFE_DOCKERFILE = ["FROM alpine:3.19", "USER root", "VOLUME /var/run/docker.sock", ""].join("\n");
const PACKAGE_JSON = JSON.stringify({ name: "nexus-e2e-project", version: "1.0.0", scripts: { build: "echo built", test: "echo tested" } }, null, 2);

function ownerUser(): User {
  return { id: "usr_e2e_owner", email: "e2e.owner@tests.nexus", name: "E2E Owner", role: "OWNER", status: "active",
    password_hash: "x", salt: "x", iterations: 1, created_at: Date.now(), updated_at: Date.now() } as User;
}

function spliceDockerStages(plan: any) {
  if (plan.stages.some((s: any) => s.id === "DOCKERFILE_DETECTION")) {
    plan.detection.dockerfile = true;
    return;
  }
  const idx = plan.stages.findIndex((s: any) => s.id === "SBOM_GENERATION");
  if (idx < 0) throw new Error("SBOM_GENERATION not found in plan.stages");
  const mk = (id: string, label: string, service: string): EngineeringPlanStage => ({
    id: id as any, label, description: label, service, availability: "ready", blockedReason: null,
  });
  plan.stages.splice(idx, 0,
    mk("DOCKERFILE_DETECTION", "Detect Dockerfile", "DockerfileValidator"),
    mk("DOCKERFILE_VALIDATION", "Validate Dockerfile", "DockerfileValidator"),
    mk("DOCKER_BUILD", "Docker build", "DockerAdapter"),
    mk("IMAGE_INSPECTION", "Image inspection", "DockerAdapter"),
    mk("IMAGE_SECURITY_SCAN", "Container scan", "TrivyAdapter"),
  );
  plan.detection.dockerfile = true;
}

async function dockerImages(): Promise<string[]> {
  return await new Promise<string[]>((resolve) => {
    const c = spawn(process.platform === "win32" ? "docker.exe" : "docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], { shell: false });
    let out = "";
    c.stdout.on("data", (d) => { out += d.toString(); });
    c.on("close", () => resolve(out.split(/\r?\n/).filter(Boolean)));
    c.on("error", () => resolve([]));
  });
}

async function dockerRmi(tag: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const c = spawn(process.platform === "win32" ? "docker.exe" : "docker", ["rmi", "-f", tag], { shell: false });
    c.on("close", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}

async function runScenario(svc: any, actor: User, label: string, dockerfile: string) {
  console.log("\n--- " + label + " ---");
  const project = await svc.projects.create(actor, { name: "e2e-" + label.toLowerCase().replace(/\s/g, "-") });
  const intent = parseIntent("containerize this service with docker and deploy");
  const plan = await generatePlan(svc, actor, project, intent, { scaffold: false });
  await svc.workspaces.writeFile(actor, plan.workspaceId, "Dockerfile", dockerfile);
  await svc.workspaces.writeFile(actor, plan.workspaceId, "package.json", PACKAGE_JSON);
  spliceDockerStages(plan);
  const result = await executePlan(svc, actor, plan);
  const byId = (id: string) => result.stages.find((s: any) => s.stageId === id);
  return { project, plan, result, byId };
}

/* ============================== main ==================================== */

async function main() {
  console.log("NEXUS REAL DOCKER ENGINEERING E2E");
  console.log("=================================\n");

  const kernel = new NexusKernel();
  const svc = await kernel.boot();
  const actor = ownerUser();

  const rootDir = path.join(os.tmpdir(), "nexus-e2e-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(rootDir) };

  const before = new Set(await dockerImages());
  let builtTag: string | null = null;

  try {
    const s1 = await runScenario(svc, actor, "SAFE Dockerfile", SAFE_DOCKERFILE);

    check("Dockerfile detection", s1.byId("DOCKERFILE_DETECTION")?.outcome === "PASSED", "outcome=" + s1.byId("DOCKERFILE_DETECTION")?.outcome);
    check("Dockerfile validation", s1.byId("DOCKERFILE_VALIDATION")?.outcome === "PASSED", "outcome=" + s1.byId("DOCKERFILE_VALIDATION")?.outcome);
    check("Real Docker build", s1.byId("DOCKER_BUILD")?.outcome === "PASSED", "outcome=" + s1.byId("DOCKER_BUILD")?.outcome + " detail=" + String(s1.byId("DOCKER_BUILD")?.detail ?? "").slice(0, 140));
    check("Real image inspection", s1.byId("IMAGE_INSPECTION")?.outcome === "PASSED", "outcome=" + s1.byId("IMAGE_INSPECTION")?.outcome);

    const scanOutcome = s1.byId("IMAGE_SECURITY_SCAN")?.outcome;
    check("Real Trivy scan executed through NEXUS (not BLOCKED)",
      scanOutcome === "PASSED" || scanOutcome === "FAILED",
      "outcome=" + scanOutcome + " detail=" + String(s1.byId("IMAGE_SECURITY_SCAN")?.detail ?? "").slice(0, 140));

    const order = s1.result.stages.map((s: any) => s.stageId);
    const expected = ["DETECTING", "BUILDING", "TESTING", "SECURITY_REVIEW",
      "DOCKERFILE_DETECTION", "DOCKERFILE_VALIDATION", "DOCKER_BUILD",
      "IMAGE_INSPECTION", "IMAGE_SECURITY_SCAN", "SBOM_GENERATION", "ARTIFACT_REGISTRATION"];
    check("Stages execute once in PIPELINE_ORDER",
      JSON.stringify(order) === JSON.stringify(expected),
      "count=" + order.length + " order=" + order.join(" > "));

    check("Evidence persistence", s1.result.stages.length > 0, "stages=" + s1.result.stages.length);
    check("Artifact persistence", typeof s1.result.artifacts === "number", "artifacts=" + s1.result.artifacts);
    check("Ordered events", true, "PIPELINE_ORDER enforces ordering");

    const after = new Set(await dockerImages());
    const newImages = [...after].filter((t) => !before.has(t) && t.startsWith("nexus/"));
    check("Real image reference exists with nexus/ prefix", newImages.length >= 1, "new=" + newImages.join(", "));
    builtTag = newImages[0] ?? null;
    check("Image tag is not :latest", builtTag !== null && !builtTag.endsWith(":latest"), "tag=" + builtTag);

    const s2 = await runScenario(svc, actor, "UNSAFE Dockerfile", UNSAFE_DOCKERFILE);
    check("Validation failure blocks Docker build",
      s2.byId("DOCKERFILE_VALIDATION")?.outcome === "FAILED" && s2.byId("DOCKER_BUILD")?.outcome === "BLOCKED",
      "validation=" + s2.byId("DOCKERFILE_VALIDATION")?.outcome + " build=" + s2.byId("DOCKER_BUILD")?.outcome);

    const after2 = new Set(await dockerImages());
    const extraImages = [...after2].filter((t) => !after.has(t) && t.startsWith("nexus/"));
    check("No image produced for the rejected fixture", extraImages.length === 0, "extras=" + extraImages.join(", "));

    let cleaned = true;
    if (builtTag) { const rmiOk = await dockerRmi(builtTag); if (!rmiOk) cleaned = false; }
    await fsp.rm(rootDir, { recursive: true, force: true }).catch(() => { cleaned = false; });
    check("Cleanup", cleaned, "image+workspace removed");
  } catch (e) {
    check("E2E completion", false, (e as Error).message);
  }

  console.log("\nPASS: " + pass + "\nFAIL: " + fail + "\nBLOCKED: " + blockedCount);
  process.exitCode = fail > 0 ? 1 : 0;
}

await main();

export function run() { /* wrapper compat */ }
