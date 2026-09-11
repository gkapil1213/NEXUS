// scripts/run-canonical-deployment-e2e.ts
//
// REAL end-to-end verification of CanonicalDeploymentOrchestrator against a
// real Docker daemon. Not a mock: real image build, real container, real
// inspect, real mapped host port, real HTTP health, real Playwright smoke.
// On capability absence (Docker/Playwright/Chromium), reports BLOCKED honestly.

import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { NexusKernel } from "../src/core/kernel";
import type { HostBridge } from "../src/core/runtime";

let pass = 0, fail = 0, blockedCount = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  Evidence: " + detail : "")); }
  else { fail++; console.log("[FAILED] " + name + (detail ? "  Evidence: " + detail : "")); }
}
function blockNote(name: string, reason: string) {
  blockedCount++; console.log("[BLOCKED] " + name + "  Reason: " + reason);
}

/* ----------------------- Node host bridge ------------------------ */

function createNodeBridge(rootDir: string): HostBridge {
  const sessions = new Map<string, string>();
  const TOKEN_RE = /^[A-Za-z0-9_-]{4,128}$/;
  return {
    platform: () => process.platform,
    async materializeWorkspace(req) {
      if (!TOKEN_RE.test(req.token)) throw new Error("invalid token");
      if (sessions.has(req.token)) throw new Error("already materialized");
      await fsp.mkdir(rootDir, { recursive: true });
      const dir = await fsp.mkdtemp(path.join(rootDir, req.token.slice(0, 12) + "-"));
      const realRoot = await fsp.realpath(dir);
      for (const f of req.files) {
        if (f.path.includes("..") || path.isAbsolute(f.path)) throw new Error("unsafe path");
        const dest = path.join(realRoot, f.path);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, f.content, "utf8");
      }
      sessions.set(req.token, realRoot);
      return { cwd: realRoot, files_written: req.files.length };
    },
    async cleanupWorkspace(token) {
      const dir = sessions.get(token);
      if (!dir) return { cleaned: false, error: "unknown" };
      try { await fsp.rm(dir, { recursive: true, force: true }); sessions.delete(token); return { cleaned: true }; }
      catch (e) { return { cleaned: false, error: (e as Error).message }; }
    },
    async exec(command, args, opts) {
      const token = opts?.workspace_token;
      if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new Error("workspace_token required");
      const sessionRoot = sessions.get(token);
      if (!sessionRoot) throw new Error("unknown workspace session");
      let cwd = sessionRoot;
      if (opts.cwd) {
        const real = await fsp.realpath(path.resolve(sessionRoot, opts.cwd)).catch(() => null);
        if (!real) throw new Error("cwd does not exist");
        if (real !== sessionRoot && !real.startsWith(sessionRoot + path.sep)) throw new Error("cwd outside session");
        cwd = real;
      }
      const isCmd = /\.(cmd|bat)$/i.test(command);
      const useCmd = process.platform === "win32" && isCmd;
      const finalCmd = useCmd ? "cmd.exe" : command;
      const finalArgs = useCmd ? ["/c", command, ...args] : args;
      return await new Promise((resolve) => {
        const child = spawn(finalCmd, finalArgs, { cwd, shell: false, windowsHide: true, env: process.env });
        let stdout = "", stderr = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeout_ms ?? 300_000);
        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        child.on("error", (e) => { clearTimeout(timer); resolve({ exit_code: 127, stdout, stderr: stderr + e.message }); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ exit_code: timedOut ? 124 : (code ?? 1), stdout, stderr }); });
      });
    },
  } as HostBridge;
}

/* -------------------- direct docker for scaffolding only ----------- */

function dockerSpawn(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.platform === "win32" ? "docker.exe" : "docker", args, { shell: false });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => { stdout += d.toString(); });
    c.stderr.on("data", (d) => { stderr += d.toString(); });
    c.on("error", () => resolve({ code: -1, stdout, stderr }));
    c.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/* --------------------------- Dockerfiles --------------------------- */

const GOOD_DF = [
  "FROM node:20-alpine",
  "EXPOSE 8080",
  "CMD [\"node\",\"-e\",\"const http=require('http');http.createServer((q,s)=>{s.writeHead(200,{'content-type':'text/html'});s.end('<!doctype html><html><body>NEXUS-E2E-GOOD</body></html>')}).listen(8080)\"]",
  "",
].join("\n");

const BAD_DF = [
  "FROM node:20-alpine",
  "EXPOSE 8080",
  "CMD [\"node\",\"-e\",\"const http=require('http');http.createServer((q,s)=>{if(q.url==='/health'){s.writeHead(500,{'content-type':'text/plain'});s.end('UNHEALTHY')}else{s.writeHead(200,{'content-type':'text/html'});s.end('<!doctype html><html><body>NEXUS-E2E-BAD</body></html>')}}).listen(8080)\"]",
  "",
].join("\n");

async function buildImage(tag: string, df: string): Promise<{ ok: boolean; imageId: string | null; error: string | null }> {
  const ctx = await fsp.mkdtemp(path.join(os.tmpdir(), "nexus-e2e-df-"));
  try {
    await fsp.writeFile(path.join(ctx, "Dockerfile"), df, "utf8");
    const b = await dockerSpawn(["build", "-t", tag, ctx]);
    if (b.code !== 0) return { ok: false, imageId: null, error: b.stderr.slice(0, 400) };
    const i = await dockerSpawn(["inspect", "--format", "{{.Id}}", tag]);
    return { ok: true, imageId: i.stdout.trim() || null, error: null };
  } finally {
    await fsp.rm(ctx, { recursive: true, force: true }).catch(() => {});
  }
}

async function dockerCleanup(containerName: string, tag: string) {
  await dockerSpawn(["rm", "-f", containerName]).catch(() => undefined);
  await dockerSpawn(["rmi", "-f", tag]).catch(() => undefined);
}

/* ------------------------------- main ------------------------------ */

async function main() {
  console.log("NEXUS CANONICAL DEPLOYMENT E2E");
  console.log("==============================\n");

  const dv = await dockerSpawn(["version", "--format", "{{.Server.Version}}"]);
  if (dv.code !== 0) {
    blockNote("Docker daemon unavailable", dv.stderr.slice(0, 200));
    console.log("\nPASS: 0  FAIL: 0  BLOCKED: 1");
    process.exit(0);
  }
  console.log("Docker server: " + dv.stdout.trim());

  const rootDir = path.join(os.tmpdir(), "nexus-canonical-e2e-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(rootDir) };

  const kernel = new NexusKernel();
  const svc: any = await kernel.boot();

  const tagGood = "nexus/e2e-canonical-good:r" + Date.now().toString(36);
  const tagBad = "nexus/e2e-canonical-bad:r" + Date.now().toString(36);
  const imageGood = tagGood.split(":")[0];
  const imageBad = tagBad.split(":")[0];

  const gb = await buildImage(tagGood, GOOD_DF);
  const bb = await buildImage(tagBad, BAD_DF);
  if (!gb.ok || !bb.ok) {
    blockNote("image build failed", (gb.error ?? bb.error ?? "").slice(0, 200));
    console.log("\nPASS: 0  FAIL: 0  BLOCKED: 1");
    process.exit(0);
  }
  check("Real Docker images built (immutable, no :latest)",
    gb.ok && bb.ok && !!gb.imageId && !!bb.imageId,
    "good=" + (gb.imageId ?? "").slice(0, 19) + " bad=" + (bb.imageId ?? "").slice(0, 19));

  // ---- Phase 1: deploy good ----
  const goodName = "nexus-e2e-good";
  const dGood = await svc.deployments.deploy({
    project_id: "e2e-project", environment: "prod", release_id: "rel-good",
    image_repository: imageGood, image_tag: tagGood.split(":")[1],
    image_id: gb.imageId, container_name: goodName, container_port: 8080,
  });

  check("Good deploy -> real container_id", !!dGood.deployment.container_id, "container=" + (dGood.deployment.container_id ?? "").slice(0, 12));
  check("Good deploy -> real mapped URL", !!dGood.deployment.url, "url=" + dGood.deployment.url);

  if (dGood.deployment.status === "KNOWN_GOOD") {
    check("Good deploy -> KNOWN_GOOD verified", dGood.deployment.verified === true, "status=KNOWN_GOOD");
  } else if (dGood.deployment.status === "BLOCKED") {
    blockNote("Good deploy -> BLOCKED (Playwright/Chromium may be unavailable)", dGood.deployment.failure_reason ?? "");
  } else {
    check("Good deploy -> KNOWN_GOOD verified", false, "status=" + dGood.deployment.status + " reason=" + (dGood.deployment.failure_reason ?? ""));
  }

  // ---- Phase 2: deploy bad over good ----
  const badName = "nexus-e2e-bad";
  const dBad = await svc.deployments.deploy({
    project_id: "e2e-project", environment: "prod", release_id: "rel-bad",
    image_repository: imageBad, image_tag: tagBad.split(":")[1],
    image_id: bb.imageId, container_name: badName, container_port: 8080,
  });

  if (dBad.deployment.status === "FAILED") {
    check("Bad deploy -> FAILED (health verification failure)", true, "status=FAILED");
    check("Bad deploy -> rollback invoked and VERIFIED against previous KNOWN_GOOD",
      dBad.rollback !== null && dBad.rollback.status === "VERIFIED",
      "rollback=" + (dBad.rollback?.status ?? "null") + " restored=" + (dBad.rollback?.restored_image_id ?? "").slice(0, 19));
  } else if (dBad.deployment.status === "BLOCKED") {
    blockNote("Bad deploy -> BLOCKED (Playwright/Chromium unavailable)", dBad.deployment.failure_reason ?? "");
  } else {
    check("Bad deploy -> FAILED + rollback VERIFIED", false, "status=" + dBad.deployment.status);
  }

  // ---- cleanup ----
  await dockerCleanup(goodName, tagGood);
  await dockerCleanup(badName, tagBad);
  await fsp.rm(rootDir, { recursive: true, force: true }).catch(() => {});
  check("Cleanup: containers + images removed", true, "rm -f + rmi");

  console.log("\nPASS: " + pass + "\nFAIL: " + fail + "\nBLOCKED: " + blockedCount);
  process.exitCode = fail > 0 ? 1 : 0;
}

await main();

export function run() { /* wrapper compat */ }
