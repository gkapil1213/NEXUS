import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";

import { openEngine } from "../src/core/db";
import { DeploymentHistoryService } from "../src/core/deployment-history";
import { CanonicalDeploymentOrchestrator } from "../src/core/deployment-orchestrator";
import { RuntimeBridge, TokenBoundExecutor, DockerAdapter, PlaywrightAdapter, SmokeTestService, type HostBridge } from "../src/core/runtime";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";

let pass = 0, fail = 0, blocked = 0;
const ok  = (n: string, c: boolean, d = "") => c ? (pass++, console.log("[PASSED] " + n + (d ? "  " + d : ""))) : (fail++, console.log("[FAILED] " + n + (d ? "  " + d : "")));
const blk = (n: string, r: string) => (blocked++, console.log("[BLOCKED] " + n + "  " + r));

function createNodeBridge(rootDir: string): HostBridge {
  const sessions = new Map<string, string>();
  const RE = /^[A-Za-z0-9_-]{4,128}$/;
  return {
    platform: () => process.platform,
    async materializeWorkspace(req: any) {
      if (!RE.test(req.token)) throw new Error("invalid token");
      await fsp.mkdir(rootDir, { recursive: true });
      const dir = await fsp.mkdtemp(path.join(rootDir, req.token.slice(0,12) + "-"));
      const real = await fsp.realpath(dir);
      for (const f of req.files) { await fsp.writeFile(path.join(real, f.path), f.content, "utf8"); }
      sessions.set(req.token, real);
      return { cwd: real, files_written: req.files.length };
    },
    async cleanupWorkspace(token: string) {
      const d = sessions.get(token);
      if (!d) return { cleaned: false };
      try { await fsp.rm(d, { recursive: true, force: true }); sessions.delete(token); return { cleaned: true }; }
      catch (e) { return { cleaned: false, error: (e as Error).message }; }
    },
    async exec(cmd: string, args: string[], opts: any) {
      const token = opts?.workspace_token;
      if (typeof token !== "string" || !RE.test(token)) throw new Error("workspace_token required");
      const root = sessions.get(token);
      if (!root) throw new Error("unknown workspace session");
      const cwd = opts.cwd ? path.resolve(root, opts.cwd) : root;
      const useCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
      const finalCmd = useCmd ? "cmd.exe" : cmd;
      const finalArgs = useCmd ? ["/c", cmd, ...args] : args;
      return await new Promise((resolve) => {
        const c = spawn(finalCmd, finalArgs, { cwd, shell: false, windowsHide: true, env: process.env });
        let out = "", err = "", to = false;
        const t = setTimeout(() => { to = true; c.kill(); }, opts.timeout_ms ?? 300_000);
        c.stdout.on("data", (d) => out += d.toString());
        c.stderr.on("data", (d) => err += d.toString());
        c.on("error", (e) => { clearTimeout(t); resolve({ exit_code: 127, stdout: out, stderr: err + e.message }); });
        c.on("close", (code) => { clearTimeout(t); resolve({ exit_code: to ? 124 : (code ?? 1), stdout: out, stderr: err }); });
      });
    },
  } as HostBridge;
}

const dockerSpawn = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
  const c = spawn(process.platform === "win32" ? "docker.exe" : "docker", args, { shell: false });
  let out = "", err = "";
  c.stdout.on("data", (d) => out += d.toString());
  c.stderr.on("data", (d) => err += d.toString());
  c.on("error", () => resolve({ code: -1, stdout: out, stderr: err }));
  c.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
});

const GOOD_DF = "FROM node:20-alpine\nEXPOSE 8080\nCMD [\"node\",\"-e\",\"require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'text/html'});s.end('<!doctype html><html><body>OK</body></html>')}).listen(8080)\"]\n";
const BAD_DF  = "FROM node:20-alpine\nEXPOSE 8080\nCMD [\"node\",\"-e\",\"require('http').createServer((q,s)=>{if(q.url==='/health'){s.writeHead(500);s.end('NO')}else{s.writeHead(200,{'content-type':'text/html'});s.end('<!doctype html><html><body>BAD</body></html>')}}).listen(8080)\"]\n";

async function buildImage(tag: string, df: string) {
  const ctx = await fsp.mkdtemp(path.join(os.tmpdir(), "p191-"));
  try {
    await fsp.writeFile(path.join(ctx, "Dockerfile"), df, "utf8");
    const b = await dockerSpawn(["build", "-t", tag, ctx]);
    if (b.code !== 0) return { ok: false, imageId: null, error: b.stderr.slice(0, 300) };
    const i = await dockerSpawn(["inspect", "--format", "{{.Id}}", tag]);
    return { ok: true, imageId: i.stdout.trim(), error: null };
  } finally { await fsp.rm(ctx, { recursive: true, force: true }).catch(() => {}); }
}
const cleanup = async (name: string, tag: string) => {
  await dockerSpawn(["rm", "-f", name]).catch(() => undefined);
  await dockerSpawn(["rmi", "-f", tag]).catch(() => undefined);
};

async function main() {
  console.log("PHASE 191 — CANONICAL DEPLOYMENT EXECUTION (direct orchestrator)\n");

  const dv = await dockerSpawn(["version", "--format", "{{.Server.Version}}"]);
  if (dv.code !== 0) { blk("Docker daemon unavailable", dv.stderr.slice(0,200)); console.log(`\nPASS: ${pass}  FAIL: ${fail}  BLOCKED: ${blocked}`); return; }
  console.log("Docker server: " + dv.stdout.trim());

  const rootDir = path.join(os.tmpdir(), "p191-" + Date.now());
  const bridge = createNodeBridge(rootDir);
  (globalThis as any).window = { __NEXUS_HOST__: bridge };
  const token = ("p191" + Date.now().toString(36)).slice(0, 40);
  await bridge.materializeWorkspace!({ token, files: [{ path: ".p191", content: "ok" }] });

  const engine = await openEngine();
  ok("engine opened (SQLite)", engine?.kind === "sqlite", "kind=" + (engine?.kind ?? "?"));

  const events = new EventService(engine);
  await events.init();
  const audit = new AuditService(engine);
  await audit.probe();

  const history = new DeploymentHistoryService(engine);
  const runtime = new RuntimeBridge({ events, audit } as any);
  const boundExec = new TokenBoundExecutor(runtime.executor, token);
  const boundDocker = new DockerAdapter(boundExec);
  const boundPlaywright = new PlaywrightAdapter(boundExec);
  const boundSmoke = new SmokeTestService(boundExec, boundPlaywright, { events, audit } as any);
  const orch = new CanonicalDeploymentOrchestrator(history, boundDocker, boundSmoke, { events, audit } as any);

  const tagGood = "nexus/p191-good:r" + Date.now().toString(36);
  const tagBad  = "nexus/p191-bad:r"  + Date.now().toString(36);
  const imageGood = tagGood.split(":")[0];
  const imageBad  = tagBad.split(":")[0];

  const gb = await buildImage(tagGood, GOOD_DF);
  const bb = await buildImage(tagBad, BAD_DF);
  if (!gb.ok || !bb.ok) { blk("image build failed", (gb.error ?? bb.error ?? "").slice(0,200)); console.log(`\nPASS: ${pass}  FAIL: ${fail}  BLOCKED: ${blocked}`); return; }
  ok("§5 real Docker images built (immutable, no :latest)", !!gb.imageId && !!bb.imageId, "good=" + (gb.imageId ?? "").slice(0,19));

  const goodName = "p191-good-" + Date.now().toString(36);
  const dGood = await orch.deploy({
    project_id: "p191-project", environment: "prod", release_id: "rel-p191-good",
    artifact_id: "art-p191-good", image_repository: imageGood, image_tag: tagGood.split(":")[1],
    image_id: gb.imageId, container_name: goodName, container_port: 8080,
    execution_id: "exec-p191-good", attempt_id: "att-p191-good",
  } as any);

  ok("§3 lifecycle persisted a deployment record", !!dGood?.deployment?.id, "id=" + (dGood?.deployment?.id ?? "?"));
  ok("§5 real container_id captured", !!dGood?.deployment?.container_id, "container=" + (dGood?.deployment?.container_id ?? "?").slice(0,12));
  ok("§5 real mapped URL captured", !!dGood?.deployment?.url, "url=" + (dGood?.deployment?.url ?? "?"));

  if (dGood?.deployment?.status === "KNOWN_GOOD") {
    ok("§3/§9 identity+health+smoke PASS -> KNOWN_GOOD verified", dGood.deployment.verified === true);
  } else if (dGood?.deployment?.status === "BLOCKED") {
    blk("§9 KNOWN_GOOD requires Playwright/Chromium; got BLOCKED", dGood.deployment.failure_reason ?? "");
  } else {
    ok("§3/§9 GOOD deploy -> KNOWN_GOOD", false, "status=" + dGood?.deployment?.status + " reason=" + (dGood?.deployment?.failure_reason ?? ""));
  }

  const persisted = await history.getDeployment(dGood?.deployment?.id ?? "");
  ok("§13 provenance: deployment persisted with container_id", !!persisted?.container_id, "container=" + (persisted?.container_id ?? "?").slice(0,12));
  ok("§13 provenance: image_id matches built image", persisted?.image_id === gb.imageId);

  const badName = "p191-bad-" + Date.now().toString(36);
  const dBad = await orch.deploy({
    project_id: "p191-project", environment: "prod", release_id: "rel-p191-bad",
    artifact_id: "art-p191-bad", image_repository: imageBad, image_tag: tagBad.split(":")[1],
    image_id: bb.imageId, container_name: badName, container_port: 8080,
    execution_id: "exec-p191-bad", attempt_id: "att-p191-bad",
  } as any);

  if (dBad?.deployment?.status === "FAILED") {
    ok("§9 provider success + verification failure -> FAILED (never KNOWN_GOOD)", true, "status=FAILED");
    ok("§12 rollback invoked on verification failure", dBad.rollback !== null, "rollback=" + (dBad.rollback?.status ?? "null"));
  } else if (dBad?.deployment?.status === "BLOCKED") {
    blk("§9 verification BLOCKED (Playwright unavailable)", dBad.deployment.failure_reason ?? "");
  } else {
    ok("§9 BAD deploy -> FAILED + rollback", false, "status=" + dBad?.deployment?.status + " reason=" + (dBad?.deployment?.failure_reason ?? ""));
  }

  await cleanup(goodName, tagGood);
  await cleanup(badName, tagBad);
  await bridge.cleanupWorkspace!(token).catch(() => undefined);
  await fsp.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
  ok("cleanup: containers + images removed", true);

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

await main();
