#!/usr/bin/env node
/**
 * NEXUS Windows Host Bridge (Phase 3 Pass 5 -> connection layer).
 *
 * Connects the browser RuntimeBridge (src/core/runtime.ts) to the REAL host
 * without ever exposing arbitrary command execution:
 *
 *   NEXUS UI (served from dist/ at http://localhost:3000)
 *        ->  window.__NEXUS_HOST__ (injected shim, Bearer-token authenticated)
 *   POST /v1/exec  -> structured { tool, args } ONLY; no free-form commands
 *        ->  server-side allowlist + argument validation + trusted-script hashes
 *   child_process.spawn(shell: false)  -> docker / trivy / git / node / npm / npx
 *
 * Security posture (all enforced HERE, in the trusted process -> the browser
 * is never trusted):
 *   -> binds 127.0.0.1 ONLY -> never 0.0.0.0
 *   -> per-boot random token injected into the served page; every API call
 *     requires `Authorization: Bearer <token>` (timing-safe compare)
 *   -> Origin must be http://localhost:<port>; Host header must be local
 *     (mitigates cross-site and DNS-rebinding invocation)
 *   -> no generic exec endpoint: tool + operation must match the exact
 *     allowlist mirrored from src/core/runtime.ts TOOL_OPERATIONS
 *   -> `node -e` is accepted ONLY when the script's sha256 matches the
 *     trusted-script registry below; the server executes its OWN canonical
 *     copy -> browser-supplied code is never run
 *   -> arguments are validated (no shell metacharacters, no "..", bounded)
 *   -> script URL arguments are restricted to http(s)://localhost|127.0.0.1
 *   -> cwd may only resolve inside the authenticated materialized workspace session
 *   -> child env is a curated allowlist -> AWS/Azure/GCP/GitHub/GitLab/Docker
 *     credentials, SSH keys and .env secrets are never inherited
 *   -> stdout/stderr are capped and secret-redacted before reaching the page
 *   -> per-command timeout with kill; structured exit codes (124 = timeout)
 *
 * Usage (on the Windows host):
 *   1. npm run build
 *   2. node scripts/nexus-host-bridge.mjs
 *   3. open http://localhost:3000 -> Control Plane -> re-detect
 *
 * Port override: NEXUS_BRIDGE_PORT=3000 (default). Never set the bind host ->
 * it is hardcoded to 127.0.0.1 by design.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fsp from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, "..");
const DIST = path.join(WORKSPACE, "dist");
const IS_WIN = process.platform === "win32";

const HOST = "127.0.0.1"; // HARD requirement -> never configurable to 0.0.0.0
const PORT = Number(process.env.NEXUS_BRIDGE_PORT || 3000);
const ALLOWED_ORIGIN = `http://localhost:${PORT}`;
const TOKEN = crypto.randomBytes(32).toString("hex"); // per-boot, page-injected

const MAX_OUTPUT_BYTES = 1_000_000; // per stream
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ARG_LEN = 512;
const RATE_LIMIT_PER_MIN = 240;

/* --------------------- host workspace materialization --------------------- */
/* Dedicated, port-scoped temp namespace owned entirely by this bridge process. */
const SESSION_TMP_ROOT = path.join(os.tmpdir(), `nexus-host-workspaces-${PORT}`);
/* token -> { dir: string|null, pending: boolean, createdAt: number } */
const WORKSPACE_SESSIONS = new Map();
const TOKEN_RE           = /^[A-Za-z0-9_-]{4,128}$/;
const MAX_WS_FILES       = 5_000;
const MAX_WS_FILE_BYTES  = 16 * 1024 * 1024;
const MAX_WS_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_WS_PATH_LEN    = 1_024;
const MAX_WS_SESSIONS    = 64;
const WS_BODY_MAX_BYTES  = MAX_WS_TOTAL_BYTES + 1 * 1024 * 1024;

/* ------------------------- mirrored policy tables ------------------------- */
/* Keep in exact sync with src/core/runtime.ts (TOOL_OPERATIONS + executables). */

const TOOL_OPS = {
  docker: ["version", "info", "build", "inspect", "run", "ps", "logs", "stop", "rm"],
  trivy: ["--version", "image", "filesystem"],
  git: ["--version", "status", "log", "rev-parse"],
  node: ["--version", "-e"],
  npm: ["--version", "ls"],
  npx: ["--version", "playwright"],
  playwright: ["--version"],
};

const EXECUTABLES = {
  docker: IS_WIN ? "docker.exe" : "docker",
  trivy: IS_WIN ? "trivy.exe" : "trivy",
  git: IS_WIN ? "git.exe" : "git",
  node: IS_WIN ? "node.exe" : "node",
  npm: IS_WIN ? "npm.cmd" : "npm",
  npx: IS_WIN ? "npx.cmd" : "npx",
  playwright: IS_WIN ? "playwright.cmd" : "playwright",
};

/* Shell metacharacters are rejected outright -> matches sanitizeArgs() in the UI. */
const SHELL_META = /[;&|`$<>(){}[\]!#*?~^"'\\\n\r]/;
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/[^\s]*)?$/;

/* --------------------- trusted scripts (canonical copy) -------------------- */
/* MUST remain byte-identical to src/core/runtime.ts -> the registry matches by
 * sha256 of the joined text, and the server executes THIS copy, never the
 * browser's string. Drift -> hash mismatch -> honest rejection. */

const SENTINEL = "::NEXUS_RESULT::";

const HEALTH_SCRIPT = [
  "const url = process.argv[process.argv.length - 1];",
  "const t0 = Date.now();",
  "fetch(url).then((r) => {",
  `  console.log("${SENTINEL}" + JSON.stringify({ ok: r.ok, status: r.status, ms: Date.now() - t0 }));`,
  "}).catch((e) => {",
  `  console.log("${SENTINEL}" + JSON.stringify({ ok: false, status: null, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 300) }));`,
  "});",
].join("\n");

const CHROMIUM_PROBE_SCRIPT = [
  "try {",
  "  const { chromium } = require('playwright');",
  "  const p = chromium.executablePath();",
  "  const exists = require('fs').existsSync(p);",
  `  console.log("${SENTINEL}" + JSON.stringify({ path: p, exists }));`,
  "} catch (e) {",
  `  console.log("${SENTINEL}" + JSON.stringify({ path: null, exists: false, error: String((e && e.message) || e).slice(0, 300) }));`,
  "}",
].join("\n");

const SMOKE_SCRIPT = [
  "const url = process.argv[process.argv.length - 1];",
  "const os = require('os'); const path = require('path');",
  "const shot = path.join(os.tmpdir(), 'nexus-smoke-' + Date.now() + '.png');",
  "(async () => {",
  "  const out = { launched: false, status: null, console_errors: [], page_errors: [], screenshot: null, error: null };",
  "  let browser = null;",
  "  try {",
  "    const { chromium } = require('playwright');",
  "    browser = await chromium.launch();",
  "    out.launched = true;",
  "    const ctx = await browser.newContext();",
  "    const page = await ctx.newPage();",
  "    page.on('console', (m) => { if (m.type() === 'error') out.console_errors.push(String(m.text()).slice(0, 300)); });",
  "    page.on('pageerror', (e) => out.page_errors.push(String((e && e.message) || e).slice(0, 300)));",
  "    const res = await page.goto(url, { waitUntil: 'load', timeout: 30000 });",
  "    out.status = res ? res.status() : null;",
  "    try { await page.screenshot({ path: shot }); out.screenshot = shot; } catch (_) {}",
  "    await ctx.close();",
  "  } catch (e) {",
  "    out.error = String((e && e.message) || e).slice(0, 500);",
  "  } finally {",
  "    if (browser) await browser.close().catch(() => {});",
  "  }",
  `  console.log("${SENTINEL}" + JSON.stringify(out));`,
  "})();",
].join("\n");

/** script sha256 -> { name, text, urlArg: whether the script consumes a local URL arg } */
const TRUSTED = new Map();
for (const [name, text, urlArg] of [
  ["health-probe", HEALTH_SCRIPT, true],
  ["chromium-probe", CHROMIUM_PROBE_SCRIPT, false],
  ["playwright-smoke", SMOKE_SCRIPT, true],
]) {
  TRUSTED.set(crypto.createHash("sha256").update(text).digest("hex"), { name, text, urlArg });
}

/* ------------------------- environment sanitization ------------------------ */
/* Curated allowlist -> credentials (AWS_*, AZURE_*, GITHUB_TOKEN, GITLAB_TOKEN,
 * DOCKER_*, SSH keys, arbitrary .env values) are simply never inherited. */

const ENV_ALLOWLIST = [
  "PATH", "SystemRoot", "SystemDrive", "USERPROFILE", "HOMEDRIVE", "HOME",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)",
  "ProgramW6432", "CommonProgramFiles", "LANG", "LC_ALL", "TZ",
];

function sanitizedEnv() {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.NEXUS_HOST_BRIDGE = "1";
  return env;
}

/* --------------------------- secret redaction ------------------------------ */

const SECRET_PATTERNS = [
  [/ghp_[A-Za-z0-9]{20,}/g, "[REDACTED:github token]"],
  [/gho_[A-Za-z0-9]{20,}/g, "[REDACTED:github oauth token]"],
  [/sk-[A-Za-z0-9]{16,}/g, "[REDACTED:provider api key]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws access key]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private key]"],
  [/(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}["']?/gi, "[REDACTED:embedded credential]"],
];

function redact(text) {
  let out = text;
  for (const [re, label] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, label);
  }
  return out;
}

function cap(text) {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return text.slice(0, MAX_OUTPUT_BYTES) + "\n...[output truncated at 1MB]";
}

/* ---------------------------- argument validation --------------------------- */

function validateArg(a) {
  if (typeof a !== "string" || a.length === 0) throw new Error("empty argument is not allowed");
  if (a.length > MAX_ARG_LEN) throw new Error(`argument exceeds ${MAX_ARG_LEN} characters`);
  if (SHELL_META.test(a)) throw new Error("argument contains shell metacharacters and was rejected");
  if (a.includes("..")) throw new Error("path traversal ('..') is not allowed in arguments");
  return a;
}


/* ------------------------------ command runner ------------------------------ */

function spawnTool(exe, argv, opts) {
  // .cmd/.bat shims (npm/npx/playwright on Windows) require cmd.exe as the
  // launcher; argv stays a structured array -> no string interpolation.
  if (IS_WIN && /\.(cmd|bat)$/i.test(exe)) {
    return spawn("cmd.exe", ["/c", exe, ...argv], opts);
  }
  return spawn(exe, argv, opts);
}

function runCommand(tool, argv, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;

    const child = spawnTool(EXECUTABLES[tool], argv, {
      shell: false,
      cwd,
      env: sanitizedEnv(),
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const finish = (exit_code, extraErr) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const duration_ms = Date.now() - t0;
      if (extraErr) stderr = (stderr + "\n" + extraErr).trim();
      resolve({
        exit_code: timedOut ? 124 : exit_code,
        stdout: redact(cap(stdout)),
        stderr: redact(cap(stderr)),
        duration_ms,
        timed_out: timedOut,
      });
    };

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => finish(timedOut ? 124 : 127, `spawn error: ${e.message}`));
    child.on("close", (code) => finish(timedOut ? 124 : (code ?? 1), timedOut ? `timed out after ${timeoutMs}ms` : null));
  });
}

/* ------------------------------- HTTP service ------------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

let rateCount = 0;
let rateWindow = Date.now();

function rateLimited() {
  const now = Date.now();
  if (now - rateWindow > 60_000) {
    rateWindow = now;
    rateCount = 0;
  }
  rateCount += 1;
  return rateCount > RATE_LIMIT_PER_MIN;
}

function authorized(req) {
  // Origin: only the NEXUS page itself (same-origin). Host: local only.
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== ALLOWED_ORIGIN) return false;
  const host = req.headers.host;
  if (host !== `localhost:${PORT}` && host !== `127.0.0.1:${PORT}`) return false;
  const auth = req.headers.authorization || "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const expected = Buffer.from(TOKEN, "utf8");
  const got = Buffer.from(presented, "utf8");
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/* Shim injected into the served page -> the ONLY way the browser reaches the
 * bridge. It exposes window.__NEXUS_HOST__ exactly as src/core/runtime.ts
 * expects; all policy lives server-side. */
/* --------------------- workspace materialization ------------------------- */

function validateWorkspaceRelPath(rel) {
  if (typeof rel !== "string" || rel.length === 0) throw new Error("path must be a non-empty string");
  if (rel.length > MAX_WS_PATH_LEN) throw new Error("path exceeds maximum length");
  if (/[\u0000-\u001f\u007f]/.test(rel)) throw new Error("path contains control characters");
  if (rel.includes("\\")) throw new Error("backslashes are not allowed");
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) throw new Error("absolute paths are not allowed");
  if (/^[A-Za-z]:/.test(rel)) throw new Error("drive-letter paths are not allowed");
  if (/%2e%2e|%2f|%5c/i.test(rel)) throw new Error("encoded traversal/separators detected");
  const kept = [];
  for (const s of rel.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") throw new Error("path traversal ('..') is not allowed");
    kept.push(s);
  }
  if (kept.length === 0) throw new Error("path resolves to an empty destination");
  return kept.join("/");
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) { fail(new Error("request body exceeds limit")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(new Error("malformed JSON: " + e.message)); }
    });
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("request aborted")));
  });
}

async function handleWorkspaceMaterialize(req, res) {
  let body;
  try { body = await readJsonBody(req, WS_BODY_MAX_BYTES); }
  catch (e) { return json(res, 400, { error: e.message }); }
  if (!body || typeof body !== "object") return json(res, 400, { error: "malformed request" });

  const { token, files } = body;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return json(res, 400, { error: "invalid token format" });
  if (!Array.isArray(files) || files.length === 0) return json(res, 400, { error: "files must be a non-empty array" });
  if (files.length > MAX_WS_FILES) return json(res, 413, { error: "too many files" });

  if (WORKSPACE_SESSIONS.has(token)) return json(res, 409, { error: "session already materialized" });
  if (WORKSPACE_SESSIONS.size >= MAX_WS_SESSIONS) return json(res, 429, { error: "too many active sessions" });

  // Lifecycle: materializing -> ready -> cleaning -> deleted. The record is
  // mutated in place; the token is never deleted and recreated mid-flight.
  const record = { dir: null, state: "materializing", createdAt: Date.now() };
  WORKSPACE_SESSIONS.set(token, record);

  const fail = (status, error) => {
    if (WORKSPACE_SESSIONS.get(token) === record) WORKSPACE_SESSIONS.delete(token);
    return json(res, status, { error });
  };

  const normalized = [];
  const seen = new Set();
  let totalBytes = 0;
  for (let i = 0; i < files.length; i++) {
    const rec = files[i];
    if (!rec || typeof rec !== "object") return fail(400, `file[${i}] malformed`);
    if (typeof rec.content !== "string") return fail(400, `file[${i}] content must be a string`);
    const bytes = Buffer.byteLength(rec.content, "utf8");
    if (bytes > MAX_WS_FILE_BYTES) return fail(413, `file[${i}] exceeds maximum size`);
    totalBytes += bytes;
    if (totalBytes > MAX_WS_TOTAL_BYTES) return fail(413, "request exceeds maximum total bytes");
    let safe;
    try { safe = validateWorkspaceRelPath(rec.path); }
    catch (e) { return fail(400, `file[${i}] invalid path: ${e.message}`); }
    if (seen.has(safe)) return fail(400, `duplicate path '${safe}'`);
    seen.add(safe);
    normalized.push({ rel: safe, content: rec.content });
  }

  const sessionName = crypto.randomBytes(16).toString("hex");
  const dir = path.join(SESSION_TMP_ROOT, sessionName);
  try {
    await fsp.mkdir(SESSION_TMP_ROOT, { recursive: true });
    await fsp.mkdir(dir, { recursive: false });
  } catch {
    return fail(500, "failed to create workspace session");
  }

  const realRoot = await fsp.realpath(dir);

  try {
    for (const { rel, content } of normalized) {
      const parent = path.dirname(path.resolve(dir, rel));
      await fsp.mkdir(parent, { recursive: true });
      const realParent = await fsp.realpath(parent);
      if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
        throw new Error("path escapes workspace via symlink");
      }
      const finalAbs = path.join(realParent, path.basename(rel));
      await fsp.writeFile(finalAbs, content, { encoding: "utf8", flag: "w" });
    }
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return fail(400, e.message);
  }

  // Ownership re-check: only transition materializing -> ready if this call
  // still owns the slot. If anything removed it mid-flight, do not resurrect.
  if (WORKSPACE_SESSIONS.get(token) !== record) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return json(res, 409, { error: "materialization was cancelled" });
  }
  record.dir = realRoot;
  record.state = "ready";
  return json(res, 200, { cwd: realRoot, files_written: normalized.length });
}

async function handleWorkspaceCleanup(req, res) {
  let body;
  try { body = await readJsonBody(req, 64 * 1024); }
  catch (e) { return json(res, 400, { error: e.message }); }
  if (!body || typeof body !== "object") return json(res, 400, { error: "malformed request" });

  const { token } = body;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return json(res, 400, { error: "invalid token format" });

  const session = WORKSPACE_SESSIONS.get(token);
  if (!session) return json(res, 404, { cleaned: false, error: "unknown workspace session" });
  if (session.state === "materializing") {
    return json(res, 409, { cleaned: false, error: "materialization is in progress" });
  }
  if (session.state === "cleaning") {
    return json(res, 409, { cleaned: false, error: "cleanup is already in progress" });
  }
  if (session.state !== "ready" || !session.dir) {
    return json(res, 500, { cleaned: false, error: "session is in an unexpected state" });
  }

  // Reserve the session before touching disk so a second cleanup call cannot
  // race this one to the rm.
  session.state = "cleaning";

  const rootReal = await fsp.realpath(SESSION_TMP_ROOT).catch(() => null);
  const dirReal  = await fsp.realpath(session.dir).catch(() => null);
  if (!rootReal || !dirReal || !dirReal.startsWith(rootReal + path.sep)) {
    if (WORKSPACE_SESSIONS.get(token) === session) WORKSPACE_SESSIONS.delete(token);
    return json(res, 500, { cleaned: false, error: "session directory invalid" });
  }

  try { await fsp.rm(dirReal, { recursive: true, force: true }); }
  catch {
    session.state = "ready";
    return json(res, 500, { cleaned: false, error: "cleanup failed" });
  }

  if (WORKSPACE_SESSIONS.get(token) === session) WORKSPACE_SESSIONS.delete(token);
  return json(res, 200, { cleaned: true });
}

function shimHtml() {
  const exeMap = JSON.stringify(
    Object.fromEntries(Object.entries(EXECUTABLES).map(([tool, exe]) => [exe, tool])),
  );
  return [
    "<script>",
    "(function () {",
    `  var TOKEN = ${JSON.stringify(TOKEN)};`,
    `  var PLATFORM = ${JSON.stringify(process.platform)};`,
    `  var EXE_TO_TOOL = ${exeMap};`,
    "  window.__NEXUS_HOST__ = {",
    "    platform: function () { return PLATFORM; },",
    "    materializeWorkspace: function (req) {",
    '      return fetch("/v1/workspace/materialize", {',
    '        method: "POST",',
    '        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN },',
    '        body: JSON.stringify({ token: req.token, files: req.files })',
    "      }).then(function (r) {",
    '        if (!r.ok) return r.json().then(function (b) { throw new Error((b && b.error) || ("HTTP " + r.status)); }, function () { throw new Error("HTTP " + r.status); });',
    "        return r.json();",
    "      });",
    "    },",
    "    cleanupWorkspace: function (token) {",
    '      return fetch("/v1/workspace/cleanup", {',
    '        method: "POST",',
    '        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN },',
    '        body: JSON.stringify({ token: token })',
    "      }).then(function (r) {",
    '        return r.json().catch(function () { return { cleaned: false, error: "HTTP " + r.status }; });',
    "      });",
    "    },",
    "    exec: function (command, args, opts) {",
    "      var tool = EXE_TO_TOOL[command];",
    '      if (!tool) return Promise.reject(new Error("tool not allowlisted: " + command));',
    '      return fetch("/v1/exec", {',
    '        method: "POST",',
    '        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN },',
    "        body: JSON.stringify({",
    "          tool: tool,",
    "          args: Array.prototype.slice.call(args || []),",
    "          timeout_ms: (opts && opts.timeout_ms) || 120000,",
    "          workspace_token: (opts && opts.workspace_token) || null,",
    "          cwd: (opts && opts.cwd) || null",
    "        })",
    "      }).then(function (r) {",
    '        if (!r.ok) throw new Error("bridge rejected request: HTTP " + r.status);',
    "        return r.json();",
    "      }).then(function (j) {",
    '        if (j.error) throw new Error(j.error);',
    '        return { exit_code: j.exit_code, stdout: j.stdout || "", stderr: j.stderr || "" };',
    "      });",
    "    }",
    "  };",
    "})();",
    "</script>",
  ].join("\n");
}

async function handleExec(req, res) {
  if (rateLimited()) return json(res, 429, { error: "rate limit exceeded -> slow down" });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "invalid JSON body" });
  }

  const tool = body.tool;
  const args = Array.isArray(body.args) ? body.args : null;
  if (!tool || !TOOL_OPS[tool]) return json(res, 403, { error: `tool not allowlisted: ${String(tool).slice(0, 40)}` });
  if (!args || args.length === 0) return json(res, 400, { error: "args must be a non-empty array" });

  const operation = args[0];
  if (typeof operation !== "string" || !TOOL_OPS[tool].includes(operation)) {
    return json(res, 403, { error: `operation not allowlisted: ${tool} ${String(operation).slice(0, 40)}` });
  }

  let argv;
  let scriptName = null;
  try {
    if (tool === "node" && operation === "-e") {
      // Trusted-script gate: the script text must hash to a registered entry;
      // the server then runs its OWN canonical copy.
      const presented = args[1];
      if (typeof presented !== "string") return json(res, 400, { error: "node -e requires exactly one trusted script argument" });
      const hash = crypto.createHash("sha256").update(presented).digest("hex");
      const entry = TRUSTED.get(hash);
      if (!entry) return json(res, 403, { error: "script is not a registered trusted script -> rejected" });
      const rest = args.slice(2).map(validateArg);
      if (entry.urlArg) {
        if (rest.length !== 1 || !LOCAL_URL.test(rest[0])) {
          return json(res, 403, { error: "script URL argument must be a local http(s)://localhost|127.0.0.1 address" });
        }
      } else if (rest.length !== 0) {
        return json(res, 400, { error: `${entry.name} accepts no arguments` });
      }
      argv = ["-e", entry.text, ...rest];
      scriptName = entry.name;
    } else {
      argv = args.map(validateArg);
    }
  } catch (e) {
    return json(res, 400, { error: e.message });
  }

  let timeoutMs = Number(body.timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
  timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);

  // Bind execution to a materialized workspace session. The workspace token
  // is independent of the global bridge Authorization token: auth proves the
  // caller is this page, the workspace token scopes execution to one session.
  const wsToken = body.workspace_token;
  if (typeof wsToken !== "string" || !TOKEN_RE.test(wsToken)) {
    return json(res, 403, { error: "workspace_token is required and must be a valid token" });
  }
  const wsSession = WORKSPACE_SESSIONS.get(wsToken);
  if (!wsSession) return json(res, 403, { error: "unknown workspace session" });
  if (wsSession.state !== "ready" || !wsSession.dir) {
    return json(res, 403, { error: "workspace session is not ready for execution" });
  }
  const wsRoot = await fsp.realpath(wsSession.dir).catch(() => null);
  if (!wsRoot) return json(res, 403, { error: "workspace session directory is unavailable" });

  let cwd;
  if (body.cwd === null || body.cwd === undefined || body.cwd === "") {
    cwd = wsRoot;
  } else {
    if (typeof body.cwd !== "string") return json(res, 400, { error: "cwd must be a string" });
    const candidate = path.resolve(wsRoot, body.cwd);
    const realCandidate = await fsp.realpath(candidate).catch(() => null);
    if (!realCandidate) return json(res, 400, { error: "cwd does not exist" });
    if (realCandidate !== wsRoot && !realCandidate.startsWith(wsRoot + path.sep)) {
      return json(res, 403, { error: "cwd is outside the workspace session boundary" });
    }
    cwd = realCandidate;
  }

  const t0 = Date.now();
  const result = await runCommand(tool, argv, timeoutMs, cwd);
  console.log(
    `[nexus-bridge] ${new Date().toISOString()} tool=${tool} op=${operation}${scriptName ? ` script=${scriptName}` : ""} ` +
      `exit=${result.exit_code} ${result.duration_ms}ms${result.timed_out ? " TIMED_OUT" : ""}`,
  );
  return json(res, 200, result);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, ALLOWED_ORIGIN);

    if (url.pathname.startsWith("/v1/")) {
      if (!authorized(req)) {
        console.log(`[nexus-bridge] rejected unauthorized ${req.method} ${url.pathname} origin=${req.headers.origin ?? "-"} host=${req.headers.host ?? "-"}`);
        return json(res, 401, { error: "unauthorized" });
      }
      if (req.method === "GET" && url.pathname === "/v1/status") {
        return json(res, 200, {
          service: "nexus-host-bridge",
          version: "1.0.0",
          platform: process.platform,
          workspace: WORKSPACE,
          port: PORT,
          uptime_s: Math.round(process.uptime()),
          trusted_scripts: [...TRUSTED.values()].map((s) => s.name),
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/exec") {
        return await handleExec(req, res);
      }
      if (req.method === "POST" && url.pathname === "/v1/workspace/materialize") {
        return await handleWorkspaceMaterialize(req, res);
      }
      if (req.method === "POST" && url.pathname === "/v1/workspace/cleanup") {
        return await handleWorkspaceCleanup(req, res);
      }
      return json(res, 404, { error: "unknown endpoint" });
    }

    // Static serving of the built NEXUS UI (same origin as the bridge).
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    let file = path.normalize(path.join(DIST, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(DIST + path.sep) && file !== DIST) return json(res, 403, { error: "forbidden" });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html"); // SPA fallback
    let content = fs.readFileSync(file);
    if (file.endsWith("index.html")) {
      const html = content.toString("utf8");
      content = html.replace("</head>", shimHtml() + "\n</head>");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=300",
      "Content-Length": content.length,
    });
    res.end(req.method === "HEAD" ? undefined : content);
  } catch (e) {
    return json(res, 500, { error: "internal bridge error" });
  }
});

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("[nexus-bridge] dist/index.html not found -> run `npm run build` first.");
  process.exit(1);
}

process.title = "nexus-host-bridge";

/* Initialize the workspace temp root; drop stale sessions from prior boots. */
try {
  fs.rmSync(SESSION_TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(SESSION_TMP_ROOT, { recursive: true });
} catch (e) {
  console.error("[nexus-bridge] FATAL: cannot initialize workspace temp root: " + e.message);
  process.exit(1);
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("[nexus-bridge] FATAL: port " + PORT + " is already in use on 127.0.0.1.");
    console.error("[nexus-bridge]   Close the process using it, or start with a different port:");
    console.error("[nexus-bridge]     $env:NEXUS_BRIDGE_PORT=3001; node scripts/nexus-host-bridge.mjs");
    console.error("[nexus-bridge]   (The NEXUS UI must then be opened from the SAME port the bridge serves.)");
  } else if (err.code === "EACCES") {
    console.error("[nexus-bridge] FATAL: permission denied binding 127.0.0.1:" + PORT + ".");
  } else {
    console.error("[nexus-bridge] FATAL: " + (err.message || err.code || "unknown server error"));
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // Verifiable startup contract -> the exact lines the operator checks for.
  console.log("NEXUS HostBridge");
  console.log(`Listening: http://127.0.0.1:${PORT}`);
  console.log(`Origin:    ${ALLOWED_ORIGIN}`);
  console.log("Status:    READY");
  console.log("----");
  console.log(`[nexus-bridge] node ${process.version} -> platform ${process.platform} -> workspace ${WORKSPACE}`);
  console.log(`[nexus-bridge] bind: ${HOST}:${PORT} (loopback only -> never 0.0.0.0)`);
  console.log(`[nexus-bridge] trusted scripts: ${[...TRUSTED.values()].map((s) => s.name).join(", ")}`);
  console.log("[nexus-bridge] session token is per-boot, injected only into the served page");
  console.log("[nexus-bridge] next: open " + ALLOWED_ORIGIN + "/ -> Control Plane -> re-detect");
});

/* --------------------------- graceful shutdown --------------------------- */
async function gracefulShutdown(signal) {
  console.log("[nexus-bridge] " + signal + " - cleaning " + WORKSPACE_SESSIONS.size + " workspace session(s)");
  for (const s of WORKSPACE_SESSIONS.values()) {
    if (s && s.dir) { try { await fsp.rm(s.dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  WORKSPACE_SESSIONS.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT",  () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
