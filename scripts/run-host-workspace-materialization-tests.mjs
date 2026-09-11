#!/usr/bin/env node
/**
 * Focused host-workspace materialization tests.
 * Spawns a real nexus-host-bridge instance on an ephemeral loopback port,
 * drives it over HTTP exactly as the browser shim does, asserts on
 * filesystem state, then tears the process down.
 *
 * Exit code 0 = all passed, 1 = at least one failed.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const PORT = 39100 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const TMP_ROOT = path.join(os.tmpdir(), `nexus-host-workspaces-${PORT}`);

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; failures.push({ name, error: e }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

async function startBridge() {
  const child = spawn(process.execPath, [path.join(REPO, "scripts/nexus-host-bridge.mjs")], {
    cwd: REPO,
    env: { ...process.env, NEXUS_BRIDGE_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("bridge did not become ready in 8s")), 8000);
    child.stdout.on("data", (d) => { if (d.toString().includes("Status:    READY")) { clearTimeout(to); resolve(); } });
    child.on("exit", (c) => reject(new Error(`bridge exited early: code ${c}`)));
    child.on("error", reject);
  });
  return child;
}

async function fetchToken() {
  const html = await fetch(`${BASE}/`).then((r) => r.text());
  const m = html.match(/var TOKEN = "([A-Fa-f0-9]{16,})"/);
  if (!m) throw new Error("could not locate TOKEN in served page");
  return m[1];
}

async function post(pathname, body, token) {
  return fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
const newToken = () => "hws_" + Math.random().toString(36).slice(2, 18) + Date.now().toString(36);

const bridge = await startBridge();
const token = await fetchToken();
const sessions = new Set();

try {
  await test("materialization creates a real temp workspace", async () => {
    const t = newToken(); sessions.add(t);
    const r = await post("/v1/workspace/materialize", { token: t, files: [{ path: "hello.txt", content: "hi" }] }, token);
    assertEq(r.status, 200);
    const body = await r.json();
    assert(typeof body.cwd === "string" && body.cwd.length > 0, "cwd missing");
    assert(body.cwd.startsWith(TMP_ROOT + path.sep), "cwd not under session temp root");
    assert(fs.existsSync(body.cwd), "returned cwd does not exist");
    assertEq(body.files_written, 1);
    assertEq(await fsp.readFile(path.join(body.cwd, "hello.txt"), "utf8"), "hi");
    sessions.delete(t);
  });

  await test("nested directories are created and written", async () => {
    const t = newToken();
    const r = await post("/v1/workspace/materialize", {
      token: t,
      files: [
        { path: "src/a/b/c.txt", content: "deep" },
        { path: "package.json", content: '{"name":"x"}' },
      ],
    }, token);
    assertEq(r.status, 200);
    const b = await r.json();
    assertEq(b.files_written, 2);
    assertEq(await fsp.readFile(path.join(b.cwd, "src", "a", "b", "c.txt"), "utf8"), "deep");
    sessions.add(t);
  });

  let isoA, isoB;
  await test("token/session isolation works", async () => {
    isoA = newToken(); isoB = newToken();
    const ra = await post("/v1/workspace/materialize", { token: isoA, files: [{ path: "a.txt", content: "A" }] }, token);
    const rb = await post("/v1/workspace/materialize", { token: isoB, files: [{ path: "b.txt", content: "B" }] }, token);
    assertEq(ra.status, 200); assertEq(rb.status, 200);
    const ca = (await ra.json()).cwd, cb = (await rb.json()).cwd;
    assert(ca !== cb, "sessions shared a directory");
    assert(fs.existsSync(path.join(ca, "a.txt")), "A's file missing");
    assert(!fs.existsSync(path.join(ca, "b.txt")), "A saw B's file");
    sessions.add(isoA); sessions.add(isoB);
  });

  await test("cleanup of unknown token is rejected (not a false success)", async () => {
    const r = await post("/v1/workspace/cleanup", { token: newToken() }, token);
    assertEq(r.status, 404);
    const b = await r.json();
    assertEq(b.cleaned, false);
  });

  const reject = (name, pathStr) => test(name, async () => {
    const r = await post("/v1/workspace/materialize",
      { token: newToken(), files: [{ path: pathStr, content: "x" }] }, token);
    assertEq(r.status, 400, `expected 400, got ${r.status}`);
  });
  await reject("traversal '../' rejected",            "../escape.txt");
  await reject("absolute Windows path rejected",      "C:/Windows/System32/x.txt");
  await reject("absolute POSIX path rejected",        "/etc/passwd");
  await reject("UNC path rejected",                   "\\\\server\\share\\x.txt");
  await reject("mixed-separator traversal rejected",  "a\\..\\b.txt");
  await reject("encoded traversal rejected",          "%2e%2e/escape.txt");
  await reject("NUL byte rejected",                   "a\u0000b.txt");
  await reject("empty path rejected",                 "");
  await reject("oversized path rejected",             "a".repeat(2000) + ".txt");

  await test("oversized single file rejected with 413", async () => {
    const big = "x".repeat(17 * 1024 * 1024);
    const r = await post("/v1/workspace/materialize",
      { token: newToken(), files: [{ path: "big.txt", content: big }] }, token);
    assertEq(r.status, 413);
  });
  await test("too many files rejected with 413", async () => {
    const files = Array.from({ length: 6000 }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
    const r = await post("/v1/workspace/materialize", { token: newToken(), files }, token);
    assertEq(r.status, 413);
  });

  await test("cleanup removes the real workspace and is honest on repeat", async () => {
    const t = newToken();
    const m = await post("/v1/workspace/materialize", { token: t, files: [{ path: "x.txt", content: "x" }] }, token);
    const cwd = (await m.json()).cwd;
    assert(fs.existsSync(cwd));
    const c1 = await post("/v1/workspace/cleanup", { token: t }, token);
    assertEq(c1.status, 200);
    assertEq((await c1.json()).cleaned, true);
    assert(!fs.existsSync(cwd), "directory still present after cleanup");
    const c2 = await post("/v1/workspace/cleanup", { token: t }, token);
    assertEq(c2.status, 404);
    assertEq((await c2.json()).cleaned, false);
  });

  await test("cleanup cannot escape the bridge temp root", async () => {
    const canary = path.join(REPO, "package.json");
    assert(fs.existsSync(canary), "canary file missing before test");
    const r = await post("/v1/workspace/cleanup", { token: "../../package" }, token);
    assertEq(r.status, 400);
    assert(fs.existsSync(canary), "canary was deleted - containment breached");
  });

  await test("exec runs inside a materialized workspace", async () => {
    const t = newToken();
    const m = await post("/v1/workspace/materialize", { token: t, files: [{ path: "marker.txt", content: "ok" }] }, token);
    const cwd = (await m.json()).cwd;
    const r = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: t, cwd }, token);
    assertEq(r.status, 200);
    const b = await r.json();
    assertEq(b.exit_code, 0, "node --version failed inside materialized cwd");
    await post("/v1/workspace/cleanup", { token: t }, token);
  });

  await test("exec rejects a cwd outside the workspace boundary", async () => {
    const t = newToken();
    const m = await post("/v1/workspace/materialize", { token: t, files: [{ path: "x.txt", content: "x" }] }, token);
    const cwd = (await m.json()).cwd;
    const outside = path.dirname(cwd);
    const r = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: t, cwd: outside }, token);
    assert(r.status === 400 || r.status === 403, `expected 4xx for outside cwd, got ${r.status}`);
    await post("/v1/workspace/cleanup", { token: t }, token);
  });

  await test("/v1/exec auth still enforced", async () => {
    const r = await fetch(`${BASE}/v1/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "node", args: ["--version"] }),
    });
    assertEq(r.status, 401);
  });

  await test("no fake success on invalid materialize", async () => {
    const r = await post("/v1/workspace/materialize", { token: "bad token with spaces", files: [] }, token);
    assert(r.status >= 400, `expected 4xx, got ${r.status}`);
    const b = await r.json();
    assert(!("cwd" in b), "invalid request returned a cwd");
  });

  /* ======================================================================
   * NEW regression tests — host workspace security contract (hardening).
   * Contract read from scripts/nexus-host-bridge.mjs:
   *   - /v1/exec REQUIRES body.workspace_token referencing a session whose
   *     state === "ready". Missing/malformed -> 403; unknown -> 403.
   *   - Lifecycle: materializing -> ready -> cleaning -> deleted.
   *   - Materialization failure deletes the record (no usable session).
   *   - Cleanup during "materializing" -> 409 and does NOT delete.
   *   - Cleanup of unknown token -> 404.
   *   - /v1/exec cwd is resolved RELATIVE TO the session root; outside -> 403.
   *   - Omitting/empty cwd -> session root.
   * ====================================================================== */

  await test("exec requires a workspace_token (no anonymous exec)", async () => {
    const t = newToken();
    await post("/v1/workspace/materialize", { token: t, files: [{ path: "x.txt", content: "x" }] }, token);
    const r = await post("/v1/exec", { tool: "node", args: ["--version"] }, token);
    assertEq(r.status, 403, `expected 403 without workspace_token, got ${r.status}`);
    const b = await r.json();
    assert(/workspace_token/i.test(String(b.error)), `error did not mention workspace_token: ${b.error}`);
    await post("/v1/workspace/cleanup", { token: t }, token);
  });

  await test("exec rejects an unknown workspace_token", async () => {
    const r = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: newToken() }, token);
    assertEq(r.status, 403);
    assertEq((await r.json()).error, "unknown workspace session");
  });

  await test("exec rejects a malformed workspace_token", async () => {
    const r = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: "bad token with spaces" }, token);
    assertEq(r.status, 403);
  });

  await test("materialized session can execute with its workspace_token (default cwd)", async () => {
    const t = newToken();
    const m = await post("/v1/workspace/materialize", { token: t, files: [{ path: "marker.txt", content: "ok" }] }, token);
    assertEq(m.status, 200);
    const r = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: t }, token);
    assertEq(r.status, 200);
    assertEq((await r.json()).exit_code, 0, "node --version failed with default session cwd");
    await post("/v1/workspace/cleanup", { token: t }, token);
  });

  await test("default cwd is the session root, not the NEXUS workspace", async () => {
    // git rev-parse --show-toplevel succeeds in a worktree, fails outside one.
    // NEXUS workspace IS a git repo; session temp root is NOT.
    const t = newToken();
    await post("/v1/workspace/materialize", { token: t, files: [{ path: "marker.txt", content: "ok" }] }, token);
    const r = await post("/v1/exec", { tool: "git", args: ["rev-parse", "--show-toplevel"], workspace_token: t }, token);
    assertEq(r.status, 200);
    const b = await r.json();
    assert(b.exit_code !== 0, `expected git to fail outside a worktree; stdout=${JSON.stringify(b.stdout)}`);
    sessions.add(t);
  });

  await test("failed materialization leaves no usable session", async () => {
    const t = newToken();
    const bad = await post("/v1/workspace/materialize", {
      token: t,
      files: [
        { path: "ok.txt", content: "x" },
        { path: "../escape.txt", content: "y" },
      ],
    }, token);
    assert(bad.status >= 400, `expected failure, got ${bad.status}`);
    const e = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: t }, token);
    assertEq(e.status, 403, `expected 403 after failed materialize, got ${e.status}`);
    assertEq((await e.json()).error, "unknown workspace session");
    const cl = await post("/v1/workspace/cleanup", { token: t }, token);
    assertEq(cl.status, 404);
    const retry = await post("/v1/workspace/materialize", { token: t, files: [{ path: "ok.txt", content: "x" }] }, token);
    assertEq(retry.status, 200, "token slot not released after failed materialize");
    sessions.add(t);
  });

  await test("duplicate token is rejected with 409 (no silent overwrite)", async () => {
    const t = newToken();
    assertEq((await post("/v1/workspace/materialize", { token: t, files: [{ path: "a.txt", content: "a" }] }, token)).status, 200);
    const dup = await post("/v1/workspace/materialize", { token: t, files: [{ path: "b.txt", content: "b" }] }, token);
    assertEq(dup.status, 409);
    sessions.add(t);
  });

  await test("cleanup racing in-flight materialization never yields a cleaned-but-usable session", async () => {
    // Best-effort interleave. Invariant:
    //  - cleanup 200  -> materialize also completed 200, AND no usable session remains.
    //  - cleanup 404  -> not yet registered; materialize must still succeed.
    //  - cleanup 409  -> in progress;   materialize must still succeed.
    const t = newToken();
    const files = Array.from({ length: 1500 }, (_, i) => ({ path: `f${i}.txt`, content: "x".repeat(128) }));
    const matP  = post("/v1/workspace/materialize", { token: t, files }, token);
    const clean = await post("/v1/workspace/cleanup", { token: t }, token);
    const mat   = await matP;
    if (clean.status === 200) {
      assertEq(mat.status, 200, "cleanup 200 but materialize did not succeed");
      const e = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: t }, token);
      assertEq(e.status, 403, "session still usable after successful cleanup");
    } else {
      assert(clean.status === 404 || clean.status === 409, `unexpected cleanup status ${clean.status}`);
      assertEq(mat.status, 200, "materialization was interrupted");
      sessions.add(t);
    }
  });

  await test("cross-session: A cannot execute with B's cwd", async () => {
    const tA = newToken(), tB = newToken();
    const rA = await post("/v1/workspace/materialize", { token: tA, files: [{ path: "a.txt", content: "AAA" }] }, token);
    const rB = await post("/v1/workspace/materialize", { token: tB, files: [{ path: "b.txt", content: "BBB" }] }, token);
    assertEq(rA.status, 200); assertEq(rB.status, 200);
    const cwdB = (await rB.json()).cwd;
    const x = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: tA, cwd: cwdB }, token);
    assertEq(x.status, 403, `A was allowed to exec in B's cwd (status ${x.status})`);
    const y = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: tA, cwd: ".." }, token);
    assert(y.status === 403 || y.status === 400, `expected 4xx for '..' escape, got ${y.status}`);
    sessions.add(tA); sessions.add(tB);
  });

  await test("cross-session: B cannot execute with A's cwd (symmetric)", async () => {
    const tA = newToken(), tB = newToken();
    const rA = await post("/v1/workspace/materialize", { token: tA, files: [{ path: "a.txt", content: "AAA" }] }, token);
    const rB = await post("/v1/workspace/materialize", { token: tB, files: [{ path: "b.txt", content: "BBB" }] }, token);
    const cwdA = (await rA.json()).cwd;
    const x = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: tB, cwd: cwdA }, token);
    assertEq(x.status, 403, `B was allowed to exec in A's cwd (status ${x.status})`);
    sessions.add(tA); sessions.add(tB);
  });

  await test("cross-session: on-disk marker files are strictly isolated", async () => {
    const tA = newToken(), tB = newToken();
    const rA = await post("/v1/workspace/materialize", { token: tA, files: [{ path: "marker-A.txt", content: "AAAA" }] }, token);
    const rB = await post("/v1/workspace/materialize", { token: tB, files: [{ path: "marker-B.txt", content: "BBBB" }] }, token);
    const cwdA = (await rA.json()).cwd, cwdB = (await rB.json()).cwd;
    assert(cwdA !== cwdB, "sessions share a directory");
    const listA = await fsp.readdir(cwdA);
    const listB = await fsp.readdir(cwdB);
    assert(listA.includes("marker-A.txt"), "A marker missing");
    assert(!listA.includes("marker-B.txt"), "A directory contains B's marker");
    assert(listB.includes("marker-B.txt"), "B marker missing");
    assert(!listB.includes("marker-A.txt"), "B directory contains A's marker");
    assertEq(await fsp.readFile(path.join(cwdA, "marker-A.txt"), "utf8"), "AAAA");
    assertEq(await fsp.readFile(path.join(cwdB, "marker-B.txt"), "utf8"), "BBBB");
    sessions.add(tA); sessions.add(tB);
  });

  await test("cleanup invalidates the workspace session for future execution", async () => {
    const t = newToken();
    const m = await post("/v1/workspace/materialize", { token: t, files: [{ path: "x.txt", content: "x" }] }, token);
    assertEq(m.status, 200);
    const e1 = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: t }, token);
    assertEq(e1.status, 200, "exec failed before cleanup");
    const cl = await post("/v1/workspace/cleanup", { token: t }, token);
    assertEq(cl.status, 200);
    assertEq((await cl.json()).cleaned, true);
    const e2 = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: t }, token);
    assertEq(e2.status, 403, "exec succeeded after cleanup - session not invalidated");
    assertEq((await e2.json()).error, "unknown workspace session");
  });

  await test("cleaned token cannot be re-used for exec even with a stale cwd", async () => {
    const t = newToken();
    const m = await post("/v1/workspace/materialize", { token: t, files: [{ path: "x.txt", content: "x" }] }, token);
    const cwd = (await m.json()).cwd;
    await post("/v1/workspace/cleanup", { token: t }, token);
    const e = await post("/v1/exec", { tool: "node", args: ["--version"], workspace_token: t, cwd }, token);
    assertEq(e.status, 403);
    assert(!fs.existsSync(cwd), "session dir still present after cleanup");
  });
} finally {
  for (const t of sessions) await post("/v1/workspace/cleanup", { token: t }, token).catch(() => undefined);
  bridge.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  await fsp.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exitCode = 1; }