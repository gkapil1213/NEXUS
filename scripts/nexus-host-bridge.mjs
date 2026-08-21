#!/usr/bin/env node
/**
 * NEXUS Windows Host Bridge (Phase 3 Pass 5 ΓÇö connection layer).
 *
 * Connects the browser RuntimeBridge (src/core/runtime.ts) to the REAL host
 * without ever exposing arbitrary command execution:
 *
 *   NEXUS UI (served from dist/ at http://localhost:3000)
 *        Γåô  window.__NEXUS_HOST__ (injected shim, Bearer-token authenticated)
 *   POST /v1/exec  ΓÇö structured { tool, args } ONLY; no free-form commands
 *        Γåô  server-side allowlist + argument validation + trusted-script hashes
 *   child_process.spawn(shell: false)  ΓåÆ docker / trivy / git / node / npm / npx
 *
 * Security posture (all enforced HERE, in the trusted process ΓÇö the browser
 * is never trusted):
 *   ΓÇó binds 127.0.0.1 ONLY ΓÇö never 0.0.0.0
 *   ΓÇó per-boot random token injected into the served page; every API call
 *     requires `Authorization: Bearer <token>` (timing-safe compare)
 *   ΓÇó Origin must be http://localhost:<port>; Host header must be local
 *     (mitigates cross-site and DNS-rebinding invocation)
 *   ΓÇó no generic exec endpoint: tool + operation must match the exact
 *     allowlist mirrored from src/core/runtime.ts TOOL_OPERATIONS
 *   ΓÇó `node -e` is accepted ONLY when the script's sha256 matches the
 *     trusted-script registry below; the server executes its OWN canonical
 *     copy ΓÇö browser-supplied code is never run
 *   ΓÇó arguments are validated (no shell metacharacters, no "..", bounded)
 *   ΓÇó script URL arguments are restricted to http(s)://localhost|127.0.0.1
 *   ΓÇó cwd may only resolve inside the NEXUS workspace
 *   ΓÇó child env is a curated allowlist ΓÇö AWS/Azure/GCP/GitHub/GitLab/Docker
 *     credentials, SSH keys and .env secrets are never inherited
 *   ΓÇó stdout/stderr are capped and secret-redacted before reaching the page
 *   ΓÇó per-command timeout with kill; structured exit codes (124 = timeout)
 *
 * Usage (on the Windows host):
 *   1. npm run build
 *   2. node scripts/nexus-host-bridge.mjs
 *   3. open http://localhost:3000 ΓåÆ Control Plane ΓåÆ re-detect
 *
 * Port override: NEXUS_BRIDGE_PORT=3000 (default). Never set the bind host ΓÇö
 * it is hardcoded to 127.0.0.1 by design.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, "..");
const DIST = path.join(WORKSPACE, "dist");
const IS_WIN = process.platform === "win32";

const HOST = "127.0.0.1"; // HARD requirement ΓÇö never configurable to 0.0.0.0
const PORT = Number(process.env.NEXUS_BRIDGE_PORT || 3000);
const ALLOWED_ORIGIN = `http://localhost:${PORT}`;
const TOKEN = crypto.randomBytes(32).toString("hex"); // per-boot, page-injected

const MAX_OUTPUT_BYTES = 1_000_000; // per stream
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ARG_LEN = 512;
const RATE_LIMIT_PER_MIN = 240;

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

/* Shell metacharacters are rejected outright ΓÇö matches sanitizeArgs() in the UI. */
const SHELL_META = /[;&|`$<>(){}[\]!#*?~^"'\\\n\r]/;
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/[^\s]*)?$/;

/* --------------------- trusted scripts (canonical copy) -------------------- */
/* MUST remain byte-identical to src/core/runtime.ts ΓÇö the registry matches by
 * sha256 of the joined text, and the server executes THIS copy, never the
 * browser's string. Drift ΓçÆ hash mismatch ΓçÆ honest rejection. */

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

/** script sha256 ΓåÆ { name, text, urlArg: whether the script consumes a local URL arg } */
const TRUSTED = new Map();
for (const [name, text, urlArg] of [
  ["health-probe", HEALTH_SCRIPT, true],
  ["chromium-probe", CHROMIUM_PROBE_SCRIPT, false],
  ["playwright-smoke", SMOKE_SCRIPT, true],
]) {
  TRUSTED.set(crypto.createHash("sha256").update(text).digest("hex"), { name, text, urlArg });
}

/* ------------------------- environment sanitization ------------------------ */
/* Curated allowlist ΓÇö credentials (AWS_*, AZURE_*, GITHUB_TOKEN, GITLAB_TOKEN,
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

function resolveCwd(requested) {
  if (requested == null) return WORKSPACE;
  if (typeof requested !== "string") throw new Error("cwd must be a string");
  const abs = path.resolve(WORKSPACE, requested);
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) {
    throw new Error("cwd escapes the NEXUS workspace ΓÇö rejected");
  }
  return abs;
}

/* ------------------------------ command runner ------------------------------ */

function spawnTool(exe, argv, opts) {
  // .cmd/.bat shims (npm/npx/playwright on Windows) require cmd.exe as the
  // launcher; argv stays a structured array ΓÇö no string interpolation.
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

/* Shim injected into the served page ΓÇö the ONLY way the browser reaches the
 * bridge. It exposes window.__NEXUS_HOST__ exactly as src/core/runtime.ts
 * expects; all policy lives server-side. */
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
  if (rateLimited()) return json(res, 429, { error: "rate limit exceeded ΓÇö slow down" });

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
      if (!entry) return json(res, 403, { error: "script is not a registered trusted script ΓÇö rejected" });
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

  let cwd;
  try {
    cwd = resolveCwd(body.cwd ?? null);
  } catch (e) {
    return json(res, 403, { error: e.message });
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
  console.error("[nexus-bridge] dist/index.html not found ΓÇö run `npm run build` first.");
  process.exit(1);
}

process.title = "nexus-host-bridge";

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
  // Verifiable startup contract ΓÇö the exact lines the operator checks for.
  console.log("NEXUS HostBridge");
  console.log(`Listening: http://127.0.0.1:${PORT}`);
  console.log(`Origin:    ${ALLOWED_ORIGIN}`);
  console.log("Status:    READY");
  console.log("----");
  console.log(`[nexus-bridge] node ${process.version} ┬╖ platform ${process.platform} ┬╖ workspace ${WORKSPACE}`);
  console.log(`[nexus-bridge] bind: ${HOST}:${PORT} (loopback only ΓÇö never 0.0.0.0)`);
  console.log(`[nexus-bridge] trusted scripts: ${[...TRUSTED.values()].map((s) => s.name).join(", ")}`);
  console.log("[nexus-bridge] session token is per-boot, injected only into the served page");
  console.log("[nexus-bridge] next: open " + ALLOWED_ORIGIN + "/ ΓåÆ Control Plane ΓåÆ re-detect");
});
