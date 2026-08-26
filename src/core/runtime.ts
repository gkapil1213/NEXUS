/**
 * NEXUS Phase 3 Pass 5 — Runtime Bridge.
 *
 * Connects NEXUS to a REAL execution environment without ever assuming one.
 *
 *   NEXUS application
 *        ↓
 *   Runtime Adapter (this module)
 *        ↓
 *   Controlled Process Executor (allowlisted tools + args only)
 *        ↓
 *   Host runtime  —  MANAGED_BROWSER_RUNTIME (this workspace: no child
 *                    processes, so every external capability is honestly
 *                    BLOCKED)  or  EXTERNAL_HOST_RUNTIME (a Node host that
 *                    injects `window.__NEXUS_HOST__`; capabilities are then
 *                    verified by actually executing probes).
 *
 * TRUTH RULE: nothing here infers availability from package.json or config.
 * A capability is AVAILABLE only after a real probe command exits 0. In the
 * managed browser runtime every external capability is BLOCKED with the exact
 * reason — it is never reported PASS/AVAILABLE, and no image id, scan count,
 * or browser result is ever fabricated.
 *
 * SECURITY: the executor accepts only allowlisted tools with sanitized
 * argument vectors. Arbitrary shell strings — especially model-generated
 * ones — can never be submitted. There is no /var/run/docker.sock or any
 * other Linux-only assumption; executable resolution is platform-aware
 * (Windows: docker.exe / trivy.exe / git.exe / node.exe / npm.cmd / npx.cmd).
 */

import type { AuditService } from "./audit";
import type { EventService } from "./events";
import { Err } from "./errors";
import { nid } from "./db";
import type { HealthCheckResult, QualityGateResult, SmokeTestResult, CiStageName, CiExecStageStatus } from "./types";

/* ------------------------------ Runtime modes ------------------------------ */

export type RuntimeKind = "MANAGED_BROWSER_RUNTIME" | "EXTERNAL_HOST_RUNTIME";

export type CapabilityStatus = "AVAILABLE" | "UNAVAILABLE" | "BLOCKED" | "UNKNOWN";

export type CapabilityName =
  | "processExecution"
  | "dockerCli"
  | "dockerDaemon"
  | "trivy"
  | "node"
  | "npm"
  | "git"
  | "playwright"
  | "chromium";

export interface CapabilityResult {
  name: CapabilityName;
  status: CapabilityStatus;
  /** Exact human-readable reason — never vague. */
  reason: string | null;
  /** Real evidence when a probe executed (version string, exit code…). */
  evidence: string | null;
  checked_at: number;
}

/** The exact shape the dashboard/API exposes (spec §16). */
export interface RuntimeStatus {
  runtime: RuntimeKind;
  platform: string;
  processExecution: CapabilityStatus;
  docker: CapabilityStatus; // CLI + daemon combined for the top-level view
  trivy: CapabilityStatus;
  playwright: CapabilityStatus;
  chromium: CapabilityStatus;
  node: CapabilityStatus;
  npm: CapabilityStatus;
  git: CapabilityStatus;
  capabilities: CapabilityResult[];
}

/* ------------------------------- Host bridge ------------------------------- */

/**
 * Contract a real Node host satisfies by injecting `window.__NEXUS_HOST__`.
 * In the managed browser workspace this global is absent — which is exactly
 * how the managed mode is detected (not assumed).
 */
export interface HostBridge {
  platform(): string; // "win32" | "linux" | "darwin" | …
  exec(
    command: string,
    args: string[],
    opts: { timeout_ms?: number; cwd?: string },
  ): Promise<{ exit_code: number; stdout: string; stderr: string }>;
}

declare global {
  interface Window {
    __NEXUS_HOST__?: HostBridge;
  }
}

function hostBridge(): HostBridge | null {
  if (typeof window !== "undefined" && window.__NEXUS_HOST__) return window.__NEXUS_HOST__;
  return null;
}

/* ----------------------- Windows-aware executable map ---------------------- */

export type AllowedTool = "docker" | "trivy" | "git" | "node" | "npm" | "npx" | "playwright" | "semgrep" | "gitleaks" | "checkov";

const EXECUTABLES: Record<AllowedTool, { win: string; posix: string }> = {
  docker: { win: "docker.exe", posix: "docker" },
  trivy: { win: "trivy.exe", posix: "trivy" },
  git: { win: "git.exe", posix: "git" },
  node: { win: "node.exe", posix: "node" },
  npm: { win: "npm.cmd", posix: "npm" },
  npx: { win: "npx.cmd", posix: "npx" },
  playwright: { win: "playwright.cmd", posix: "playwright" },
  semgrep: { win: "semgrep.cmd", posix: "semgrep" },
  gitleaks: { win: "gitleaks.exe", posix: "gitleaks" },
  checkov: { win: "checkov.cmd", posix: "checkov" },
};

/** Platform-aware resolution. Pure + deterministic — unit-testable. */
export function resolveExecutable(platform: string, tool: AllowedTool): string {
  return platform === "win32" ? EXECUTABLES[tool].win : EXECUTABLES[tool].posix;
}

/* --------------------------- Controlled executor --------------------------- */

export interface AllowlistedCommand {
  tool: AllowedTool;
  /** Operation within the tool, from a per-tool allowlist (never free-form). */
  operation: string;
  args: string[];
  timeout_ms?: number;
  cwd?: string;
  /**
   * Optional raw (unsanitized) arguments — permitted ONLY when every entry is
   * a registered TRUSTED_SCRIPT. Used for `node -e <script>`. Dynamic values
   * (URLs, tags…) must always go through `args`, which is sanitized.
   */
  rawArgs?: string[];
}

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

export interface ExecutorCapability {
  available: boolean;
  kind: RuntimeKind;
  reason: string | null;
}

const SHELL_META = /[;&|`$<>(){}[\]!#*?~^"'\\\n\r]/;
const MAX_ARG_LEN = 512;

/**
 * Validate an argument vector. Rejects shell metacharacters, traversal and
 * over-long args. Flags (`--format`) and plain values pass; anything that
 * could escape the argument vector fails closed.
 */
export function sanitizeArgs(args: string[]): string[] {
  return args.map((a) => {
    if (typeof a !== "string" || a.length === 0) throw Err.validation("EMPTY_ARG", "empty argument is not allowed");
    if (a.length > MAX_ARG_LEN) throw Err.validation("ARG_TOO_LONG", `argument exceeds ${MAX_ARG_LEN} characters`);
    if (SHELL_META.test(a)) throw Err.security("ARG_REJECTED", `argument contains shell metacharacters and was rejected`);
    if (a.includes("..")) throw Err.security("TRAVERSAL_REJECTED", "path traversal ('..') is not allowed in arguments");
    if (/[\x00-\x1f\x7f]/.test(a)) throw Err.security("CONTROL_CHAR_REJECTED", "argument contains control characters");
    if (a.includes("\\")) throw Err.security("BACKSLASH_REJECTED", "backslashes are not allowed in arguments");
    if (/\s/.test(a) && /^(rm|curl|wget|sh|bash|zsh|dash|sudo|chmod|dd|mkfs|killall)\b/.test(a.trim())) {
      throw Err.security("ARG_REJECTED", "argument contains shell metacharacters or unsafe command");
    }
    return a;
  });
}

/** Per-tool operation allowlists. Only these operations may ever be invoked. */
const TOOL_OPERATIONS: Record<AllowedTool, readonly string[]> = {
  docker: ["version", "info", "build", "inspect", "run", "ps", "logs", "stop", "rm"],
  trivy: ["--version", "image", "filesystem"],
  git: ["--version", "status", "log", "rev-parse"],
  // `-e` is permitted ONLY with a registered trusted script (see TRUSTED_SCRIPTS).
  node: ["--version", "-e"],
  npm: ["--version", "ls"],
  npx: ["--version", "playwright"],
  playwright: ["--version"],
  semgrep: ["--version", "scan"],
  gitleaks: ["version", "detect"],
  checkov: ["--version", "--directory"],
};

/* ------------------------- Trusted inline scripts -------------------------- */
/*
 * Fixed, compile-time-constant Node scripts used for host-side probes. They are
 * the ONLY strings allowed to bypass argument sanitization (they contain shell
 * metacharacters by nature). Model- or user-supplied text can never be placed
 * here: the executor rejects any rawArg that is not a member of this registry.
 * Each prints one JSON line after the sentinel; adapters parse real output and
 * never invent values.
 */

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

/** Registry of scripts the executor may run via `node -e`. Membership is the
 *  only way a raw string reaches the host bridge. */
export const TRUSTED_SCRIPTS: ReadonlySet<string> = new Set([HEALTH_SCRIPT, CHROMIUM_PROBE_SCRIPT, SMOKE_SCRIPT]);

export const TRUSTED_SCRIPT_NAME = new Map<string, string>([
  [HEALTH_SCRIPT, "health-probe"],
  [CHROMIUM_PROBE_SCRIPT, "chromium-probe"],
  [SMOKE_SCRIPT, "playwright-smoke"],
]);

export interface ProcessExecutor {
  capability(): ExecutorCapability;
  run(cmd: AllowlistedCommand): Promise<ExecResult>;
}

/**
 * Managed browser executor: has NO child-process capability. Every run()
 * reports BLOCKED — it never pretends to have executed anything.
 */
export class BrowserProcessExecutor implements ProcessExecutor {
  capability(): ExecutorCapability {
    return {
      available: false,
      kind: "MANAGED_BROWSER_RUNTIME",
      reason: "process execution unavailable in the managed browser workspace (no child-process spawn)",
    };
  }
  async run(_cmd: AllowlistedCommand): Promise<ExecResult> {
    throw Err.runtime(
      "EXECUTOR_BLOCKED",
      "process execution unavailable in the managed browser workspace — external runtime capability is BLOCKED, not simulated",
    );
  }
}

/**
 * Host executor: delegates to the injected Node host bridge. Only reachable
 * when a real host has provided `window.__NEXUS_HOST__`; commands are still
 * allowlist-validated before they ever reach the bridge.
 */
export class HostProcessExecutor implements ProcessExecutor {
  constructor(private bridge: HostBridge) {}

  capability(): ExecutorCapability {
    return { available: true, kind: "EXTERNAL_HOST_RUNTIME", reason: null };
  }

  async run(cmd: AllowlistedCommand): Promise<ExecResult> {
    const allowed = TOOL_OPERATIONS[cmd.tool];
    if (!allowed.includes(cmd.operation)) {
      throw Err.security("OPERATION_NOT_ALLOWED", `operation '${cmd.operation}' is not allowlisted for tool '${cmd.tool}'`);
    }
    // Trusted scripts: only registered constants may bypass sanitization.
    const raw: string[] = [];
    for (const r of cmd.rawArgs ?? []) {
      if (!TRUSTED_SCRIPTS.has(r)) {
        throw Err.security(
  "UNTRUSTED_SCRIPT_REJECTED",
  "raw argument is not a registered trusted script; trusted scripts may only be used with 'node -e'"
);
      }
      raw.push(r);
    }
    if (raw.length > 0 && !(cmd.tool === "node" && cmd.operation === "-e")) {
      throw Err.security("RAW_ARGS_NOT_ALLOWED", "trusted scripts may only be used with 'node -e'");
    }
    const args = [cmd.operation, ...raw, ...sanitizeArgs(cmd.args)];
    const exe = resolveExecutable(this.bridge.platform(), cmd.tool);
    const t0 = performance.now();
    let timedOut = false;
    const timeout = cmd.timeout_ms ?? 120_000;

    const execP = this.bridge.exec(exe, args, { timeout_ms: timeout, cwd: cmd.cwd });
        const timerP = new Promise<never>((_, reject) =>
      globalThis.setTimeout(() => {
        timedOut = true;
        reject(Err.runtime("EXEC_TIMEOUT", `command timed out after ${timeout}ms`));
      }, timeout),
    );

    try {
      const res = await Promise.race([execP, timerP]);
      return {
        exit_code: res.exit_code,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        duration_ms: Math.round((performance.now() - t0) * 10) / 10,
        timed_out: false,
      };
    } catch (e) {
      if (timedOut) {
        return { exit_code: 124, stdout: "", stderr: (e as Error).message, duration_ms: timeout, timed_out: true };
      }
      throw e;
    }
  }
}

/** Create the correct executor for the current environment. */
export function createExecutor(): ProcessExecutor {
  const bridge = hostBridge();
  return bridge ? new HostProcessExecutor(bridge) : new BrowserProcessExecutor();
}

/* ------------------------------ Docker adapter ----------------------------- */

export type DockerOp =
  | { kind: "version" }
  | { kind: "info" }
  | { kind: "build"; context: string; tag: string }
  | { kind: "inspect"; image: string }
  | { kind: "run"; image: string; name: string; ports: { host: number; container: number }[]; detach: boolean }
  | { kind: "ps"; filter?: string }
  | { kind: "logs"; container: string }
  | { kind: "stop"; container: string }
  | { kind: "rm"; container: string; force?: boolean };

export interface DockerResult {
  status: "SUCCEEDED" | "FAILED" | "BLOCKED";
  command: string; // the allowlisted command (tool + operation), never a shell string
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number | null;
  blocked_reason: string | null;
}

export class DockerAdapter {
  constructor(private exec: ProcessExecutor) {}

  /** Build the structured command; no free-form shell is ever assembled. */
  private toCommand(op: DockerOp): AllowlistedCommand {
    switch (op.kind) {
      case "version":
        return { tool: "docker", operation: "version", args: ["--format", "json"] };
      case "info":
        return { tool: "docker", operation: "info", args: ["--format", "json"] };
      case "build":
        // Immutable tag required by caller; no implicit :latest.
        return { tool: "docker", operation: "build", args: ["-t", op.tag, op.context], timeout_ms: 600_000 };
      case "inspect":
        return { tool: "docker", operation: "inspect", args: ["--format", "json", op.image] };
      case "run": {
        const args: string[] = [];
        if (op.detach) args.push("-d");
        for (const p of op.ports) args.push("-p", `${p.host}:${p.container}`);
        args.push("--name", op.name, op.image);
        // Deliberately NO --privileged, NO host mounts, NO socket mounts.
        return { tool: "docker", operation: "run", args };
      }
      case "ps":
        return { tool: "docker", operation: "ps", args: op.filter ? ["--filter", op.filter, "--format", "json"] : ["--format", "json"] };
      case "logs":
        return { tool: "docker", operation: "logs", args: [op.container] };
      case "stop":
        return { tool: "docker", operation: "stop", args: [op.container] };
      case "rm":
        return { tool: "docker", operation: "rm", args: op.force ? ["-f", op.container] : [op.container] };
    }
  }

  private blocked(reason: string): DockerResult {
    return { status: "BLOCKED", command: "docker", exit_code: null, stdout: "", stderr: "", duration_ms: null, blocked_reason: reason };
  }

  async run(op: DockerOp): Promise<DockerResult> {
    const cap = this.exec.capability();
    if (!cap.available) return this.blocked(cap.reason ?? "process execution unavailable");
    const cmd = this.toCommand(op);
    try {
      const res = await this.exec.run(cmd);
      if (res.exit_code === 0) {
        return { status: "SUCCEEDED", command: `docker ${cmd.operation}`, exit_code: 0, stdout: res.stdout, stderr: res.stderr, duration_ms: res.duration_ms, blocked_reason: null };
      }
      return { status: "FAILED", command: `docker ${cmd.operation}`, exit_code: res.exit_code, stdout: res.stdout, stderr: res.stderr, duration_ms: res.duration_ms, blocked_reason: null };
    } catch (e) {
      return { status: "BLOCKED", command: `docker ${cmd.operation}`, exit_code: null, stdout: "", stderr: (e as Error).message, duration_ms: null, blocked_reason: (e as Error).message };
    }
  }
}

/* ------------------------------ Trivy adapter ------------------------------ */

export interface TrivyScanResult {
  status: "PASS" | "FAIL" | "BLOCKED";
  scanner: string | null; // "trivy" when a real scan ran
  target: string | null;
  critical: number;
  high: number;
  medium: number;
  low: number;
  findings: { severity: string; pkg: string; installed: string; fixed: string | null }[];
  blocked_reason: string | null;
  duration_ms: number | null;
}

export class TrivyAdapter {
  constructor(private exec: ProcessExecutor, private docker: DockerAdapter) {}

  /** Detect native Trivy first, then the Trivy-via-Docker strategy. */
  async detect(): Promise<{ strategy: "native" | "docker-image" | null; reason: string | null }> {
    const cap = this.exec.capability();
    if (!cap.available) return { strategy: null, reason: cap.reason ?? "process execution unavailable" };
    const native = await this.exec.run({ tool: "trivy", operation: "--version", args: [] }).catch(() => null);
    if (native && native.exit_code === 0) return { strategy: "native", reason: null };
    // Fall back to the Trivy Docker image when a daemon exists.
    const dv = await this.docker.run({ kind: "version" });
    if (dv.status === "SUCCEEDED") return { strategy: "docker-image", reason: null };
    return { strategy: null, reason: "Trivy not installed and Docker daemon unavailable — cannot scan" };
  }

  async scanImage(image: string): Promise<TrivyScanResult> {
    const det = await this.detect();
    if (!det.strategy) {
      return { status: "BLOCKED", scanner: null, target: null, critical: 0, high: 0, medium: 0, low: 0, findings: [], blocked_reason: det.reason, duration_ms: null };
    }

    const cmd: AllowlistedCommand =
      det.strategy === "native"
        ? { tool: "trivy", operation: "image", args: ["--format", "json", "--scanners", "vuln", image], timeout_ms: 300_000 }
        : { tool: "docker", operation: "run", args: ["--rm", "aquasec/trivy", "image", "--format", "json", "--scanners", "vuln", image], timeout_ms: 600_000 };

    let res: ExecResult;
    try {
      res = await this.exec.run(cmd);
    } catch (e) {
      return { status: "BLOCKED", scanner: null, target: image, critical: 0, high: 0, medium: 0, low: 0, findings: [], blocked_reason: (e as Error).message, duration_ms: null };
    }

    if (res.exit_code !== 0) {
      // Trivy exits non-zero on findings only with --exit-code; treat as FAIL evidence.
      return { status: "BLOCKED", scanner: "trivy", target: image, critical: 0, high: 0, medium: 0, low: 0, findings: [], blocked_reason: `trivy exited ${res.exit_code}: ${res.stderr.slice(0, 200)}`, duration_ms: res.duration_ms };
    }

    // Parse REAL output; never invent counts.
    const parsed = this.parseReport(res.stdout);
    if (!parsed) {
      return { status: "BLOCKED", scanner: "trivy", target: image, critical: 0, high: 0, medium: 0, low: 0, findings: [], blocked_reason: "could not parse trivy JSON output", duration_ms: res.duration_ms };
    }
    return { ...parsed, target: image, duration_ms: res.duration_ms };
  }

  private parseReport(json: string): Omit<TrivyScanResult, "target" | "duration_ms"> | null {
    try {
      const doc = JSON.parse(json) as { Results?: { Vulnerabilities?: { Severity: string; PkgName: string; InstalledVersion: string; FixedVersion?: string }[] }[] };
      const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
      const findings: TrivyScanResult["findings"] = [];
      for (const r of doc.Results ?? []) {
        for (const v of r.Vulnerabilities ?? []) {
          const sev = (v.Severity ?? "UNKNOWN").toUpperCase();
          if (sev in counts) counts[sev as keyof typeof counts] += 1;
          findings.push({ severity: sev, pkg: v.PkgName ?? "?", installed: v.InstalledVersion ?? "?", fixed: v.FixedVersion ?? null });
        }
      }
      return {
        status: counts.CRITICAL > 0 ? "FAIL" : "PASS",
        scanner: "trivy",
        critical: counts.CRITICAL,
        high: counts.HIGH,
        medium: counts.MEDIUM,
        low: counts.LOW,
        findings,
        blocked_reason: null,
      };
    } catch {
      return null;
    }
  }
}

/* ---------------------------- Playwright adapter --------------------------- */

export interface SmokeTestOutcome {
  status: "PASSED" | "FAILED" | "BLOCKED";
  browser: string | null;
  url: string | null;
  http_status: number | null;
  console_errors: string[];
  page_errors: string[];
  screenshot_ref: string | null;
  blocked_reason: string | null;
  duration_ms: number | null;
}

export class PlaywrightAdapter {
  constructor(private exec: ProcessExecutor) {}

  /** Parse the single JSON payload a trusted script prints after the sentinel. */
  private parseSentinel<T>(stdout: string): T | null {
    const idx = stdout.indexOf(SENTINEL);
    if (idx === -1) return null;
    try {
      return JSON.parse(stdout.slice(idx + SENTINEL.length).trim().split("\n")[0]) as T;
    } catch {
      return null;
    }
  }

  /**
   * REAL detection: `npx playwright --version`, then a trusted host-side probe
   * for the Chromium executable. In the managed browser runtime the executor
   * itself is unavailable, so this honestly reports BLOCKED — never faked.
   */
  async detect(): Promise<{ playwright: boolean; chromium: boolean; reason: string | null }> {
    const cap = this.exec.capability();
    if (!cap.available) return { playwright: false, chromium: false, reason: cap.reason ?? "process execution unavailable" };

    const pw = await this.exec.run({ tool: "npx", operation: "playwright", args: ["--version"] }).catch(() => null);
    if (!pw || pw.exit_code !== 0) {
      return { playwright: false, chromium: false, reason: `Playwright not installed on host${pw ? ` (npx playwright --version exited ${pw.exit_code})` : ""}` };
    }

    const probe = await this.exec
      .run({ tool: "node", operation: "-e", args: [], rawArgs: [CHROMIUM_PROBE_SCRIPT] })
      .catch(() => null);
    const parsed = probe ? this.parseSentinel<{ path: string | null; exists: boolean; error?: string }>(probe.stdout) : null;
    const chromium = !!parsed && parsed.exists === true;
    const reason = chromium ? null : parsed?.error ? `Chromium probe: ${parsed.error}` : "Chromium executable not found (run: npx playwright install chromium)";
    return { playwright: true, chromium, reason };
  }

  /**
   * REAL smoke test. On an external host runtime this launches Chromium via a
   * trusted script, navigates to the URL, captures HTTP status, console and
   * page errors and a screenshot, then closes the browser. Results are parsed
   * from actual output — nothing is simulated.
   *
   * State semantics (kept distinct):
   *   PASSED — browser launched, page loaded with a 2xx/3xx status, no page errors
   *   FAILED — browser launched but the application failed (bad status / page errors)
   *   BLOCKED — browser could not start / runtime unavailable (never a fake pass)
   */
  async smoke(url: string): Promise<SmokeTestOutcome> {
    const det = await this.detect();
    if (!det.playwright) {
      return { status: "BLOCKED", browser: null, url: null, http_status: null, console_errors: [], page_errors: [], screenshot_ref: null, blocked_reason: det.reason ?? "Playwright unavailable", duration_ms: null };
    }
    if (!det.chromium) {
      return { status: "BLOCKED", browser: null, url, http_status: null, console_errors: [], page_errors: [], screenshot_ref: null, blocked_reason: det.reason ?? "Chromium unavailable", duration_ms: null };
    }

    let res: ExecResult;
    try {
      // URL is dynamic → sanitized args. Script is trusted → rawArgs registry.
      res = await this.exec.run({ tool: "node", operation: "-e", args: [url], rawArgs: [SMOKE_SCRIPT], timeout_ms: 90_000 });
    } catch (e) {
      return { status: "BLOCKED", browser: null, url, http_status: null, console_errors: [], page_errors: [], screenshot_ref: null, blocked_reason: `smoke test could not execute: ${(e as Error).message}`, duration_ms: null };
    }

    const out = this.parseSentinel<{
      launched: boolean;
      status: number | null;
      console_errors: string[];
      page_errors: string[];
      screenshot: string | null;
      error: string | null;
    }>(res.stdout);

    if (!out) {
      return { status: "BLOCKED", browser: null, url, http_status: null, console_errors: [], page_errors: [], screenshot_ref: null, blocked_reason: `no structured result from browser runner (exit ${res.exit_code}): ${res.stderr.slice(0, 200)}`, duration_ms: res.duration_ms };
    }
    if (!out.launched) {
      const chromiumMissing = /executable doesn't exist|browserType\.launch/i.test(out.error ?? "");
      return {
        status: "BLOCKED",
        browser: null,
        url,
        http_status: null,
        console_errors: [],
        page_errors: [],
        screenshot_ref: null,
        blocked_reason: chromiumMissing ? "Chromium failed to start — browser not installed or not launchable" : `browser failed to start: ${out.error ?? "unknown"}`,
        duration_ms: res.duration_ms,
      };
    }

    const okStatus = out.status !== null && out.status >= 200 && out.status < 400;
    const failed = !okStatus || out.page_errors.length > 0;
    return {
      status: failed ? "FAILED" : "PASSED",
      browser: "chromium",
      url,
      http_status: out.status,
      console_errors: out.console_errors,
      page_errors: out.page_errors,
      screenshot_ref: out.screenshot,
      blocked_reason: null,
      duration_ms: res.duration_ms,
    };
  }
}

/* ------------------------------ Smoke test service -------------------------- */

export interface RuntimeBridgeServices {
  events: EventService;
  audit: AuditService;
}

export interface SmokeRunInput {
  execution_id: string | null;
  /** Base URL of the deployed staging application, e.g. http://localhost:8080 */
  staging_url: string;
  /** Health endpoint; defaults to <staging_url>/health */
  health_url?: string;
}

export interface SmokeRunResult {
  health: HealthCheckResult;
  smoke: SmokeTestResult;
  /** PASS only when BOTH real checks succeeded. FAIL/BLOCKED stay distinct. */
  verdict: "PASS" | "FAIL" | "BLOCKED";
  reason: string | null;
}

/**
 * Orchestrates a REAL staging verification: health probe first, then the
 * Playwright smoke test. Uses the controlled executor only; in the managed
 * browser runtime every result is honestly BLOCKED.
 */
export class SmokeTestService {
  constructor(
    private exec: ProcessExecutor,
    private playwright: PlaywrightAdapter,
    private svc: RuntimeBridgeServices,
  ) {}

  /** REAL HTTP health probe via a trusted host-side script. */
  async checkHealth(executionId: string | null, url: string, attempts = 1): Promise<HealthCheckResult> {
    const base: HealthCheckResult = {
      id: nid("hc"),
      execution_id: executionId ?? "runtime-check",
      endpoint: url,
      status_code: null,
      response_time_ms: null,
      attempts,
      ok: false,
      error: null,
      checked_at: Date.now(),
    };
    const cap = this.exec.capability();
    if (!cap.available) {
      base.error = cap.reason ?? "process execution unavailable";
      return base;
    }
    let res: ExecResult | null = null;
    try {
      res = await this.exec.run({ tool: "node", operation: "-e", args: [url], rawArgs: [HEALTH_SCRIPT], timeout_ms: 30_000 });
    } catch (e) {
      base.error = `health probe could not execute: ${(e as Error).message}`;
      return base;
    }
    const idx = res.stdout.indexOf(SENTINEL);
    if (idx === -1) {
      base.error = `no structured result from health probe (exit ${res.exit_code}): ${res.stderr.slice(0, 200)}`;
      return base;
    }
    try {
      const parsed = JSON.parse(res.stdout.slice(idx + SENTINEL.length).trim().split("\n")[0]) as {
        ok: boolean;
        status: number | null;
        ms: number | null;
        error?: string;
      };
      base.ok = parsed.ok === true;
      base.status_code = parsed.status;
      base.response_time_ms = parsed.ms;
      base.error = parsed.ok ? null : parsed.error ?? `HTTP ${parsed.status}`;
    } catch {
      base.error = "could not parse health probe output";
    }
    return base;
  }

  /** Full staging verification: health → smoke. Emits real events + audit. */
  async run(input: SmokeRunInput): Promise<SmokeRunResult> {
    const executionId = input.execution_id ?? "runtime-check";
    const healthUrl = input.health_url ?? `${input.staging_url.replace(/\/$/, "")}/health`;

    await this.svc.events.emit({
      type: "health.started" as never,
      source: "SmokeTestService",
      execution_id: input.execution_id,
      payload: { endpoint: healthUrl },
    });
    const health = await this.checkHealth(input.execution_id, healthUrl);
    await this.svc.events.emit({
      type: "health.completed" as never,
      source: "SmokeTestService",
      execution_id: input.execution_id,
      payload: { endpoint: healthUrl, ok: health.ok, status_code: health.status_code, error: health.error },
    });

    await this.svc.events.emit({
      type: "smoke.started" as never,
      source: "SmokeTestService",
      execution_id: input.execution_id,
      payload: { target: input.staging_url },
    });
    const outcome = await this.playwright.smoke(input.staging_url);
    const smoke: SmokeTestResult = {
      id: nid("smk"),
      execution_id: executionId,
      target: input.staging_url,
      ok: outcome.status === "PASSED",
      status: outcome.status,
      detail:
        outcome.status === "PASSED"
          ? `HTTP ${outcome.http_status} · ${outcome.console_errors.length} console error(s) · screenshot=${outcome.screenshot_ref ?? "none"}`
          : outcome.blocked_reason ?? `HTTP ${outcome.http_status} · ${outcome.page_errors.length} page error(s)`,
      ran_at: Date.now(),
    };
    await this.svc.events.emit({
      type: "smoke.completed" as never,
      source: "SmokeTestService",
      execution_id: input.execution_id,
      payload: { target: input.staging_url, status: outcome.status, http_status: outcome.http_status },
    });

    let verdict: SmokeRunResult["verdict"];
    let reason: string | null = null;
    if (health.error && !health.ok && health.status_code === null && health.response_time_ms === null) {
      verdict = "BLOCKED";
      reason = `health probe unavailable: ${health.error}`;
    } else if (outcome.status === "BLOCKED") {
      verdict = "BLOCKED";
      reason = outcome.blocked_reason;
    } else if (!health.ok) {
      verdict = "FAIL";
      reason = `health check failed: ${health.error ?? `HTTP ${health.status_code}`}`;
    } else if (outcome.status === "FAILED") {
      verdict = "FAIL";
      reason = `smoke test failed: HTTP ${outcome.http_status}, ${outcome.page_errors.length} page error(s)`;
    } else {
      verdict = "PASS";
    }

    if (verdict !== "PASS") {
      await this.svc.audit.record({
        actor: "system",
        action: verdict === "BLOCKED" ? "smoke.blocked" : "smoke.failed",
        resource_type: "smoke-test",
        resource_id: smoke.id,
        result: verdict === "BLOCKED" ? "info" : "error",
        metadata: { target: input.staging_url, reason, http_status: outcome.http_status },
      });
    }
    return { health, smoke, verdict, reason };
  }
}

/* ------------------------------ Quality gate ------------------------------- */

export type GateStage = "BUILD" | "TEST" | "SECURITY" | "SBOM" | "DOCKER" | "STAGING" | "HEALTH" | "SMOKE";
export type GateStatus = "PASS" | "FAIL" | "BLOCKED";

export interface GateEvidence {
  status: GateStatus;
  reason: string | null;
}

export const GATE_STAGES: GateStage[] = ["BUILD", "TEST", "SECURITY", "SBOM", "DOCKER", "STAGING", "HEALTH", "SMOKE"];

const GATE_TO_CI: Record<GateStage, CiStageName> = {
  BUILD: "BUILD",
  TEST: "TEST",
  SECURITY: "SECURITY",
  SBOM: "SBOM",
  DOCKER: "DOCKER",
  STAGING: "STAGING",
  HEALTH: "HEALTH",
  SMOKE: "SMOKE",
};

const GATE_TO_EXEC: Record<GateStatus, CiExecStageStatus> = { PASS: "PASSED", FAIL: "FAILED", BLOCKED: "BLOCKED" };

/**
 * Evidence-based gate. A block NEVER silently becomes a pass:
 *   any FAIL  → FAILED
 *   any BLOCKED (and no FAIL) → BLOCKED
 *   all PASS  → VERIFIED
 */
export class QualityGateService {
  constructor(private svc: RuntimeBridgeServices) {}

  async evaluate(executionId: string | null, evidence: Partial<Record<GateStage, GateEvidence>>): Promise<QualityGateResult> {
    const blocking: QualityGateResult["blocking_stages"] = [];
    let passed = 0;
    let hasFail = false;
    let hasBlock = false;

    for (const stage of GATE_STAGES) {
      const ev = evidence[stage];
      // Missing evidence is treated as BLOCKED — never assumed PASS.
      const status: GateStatus = ev?.status ?? "BLOCKED";
      const reason = ev?.status ? ev.reason : ev === undefined ? "no evidence supplied for this stage" : ev.reason;
      if (status === "PASS") passed += 1;
      else {
        if (status === "FAIL") hasFail = true;
        else hasBlock = true;
        blocking.push({ stage: GATE_TO_CI[stage], status: GATE_TO_EXEC[status], reason: reason ?? null });
      }
    }

    const verdict: QualityGateResult["verdict"] = hasFail ? "FAILED" : hasBlock ? "BLOCKED" : "VERIFIED";
    const result: QualityGateResult = {
      id: nid("qg"),
      execution_id: executionId ?? "runtime-check",
      verdict,
      required_passed: passed,
      required_total: GATE_STAGES.length,
      blocking_stages: blocking,
      evaluated_at: Date.now(),
    };

    await this.svc.events.emit({
      type: "quality_gate.completed" as never,
      source: "QualityGateService",
      execution_id: executionId,
      payload: { verdict, required_passed: passed, required_total: GATE_STAGES.length, blocking: blocking.length },
    });
    await this.svc.audit.record({
      actor: "system",
      action: "quality_gate.evaluated",
      resource_type: "quality-gate",
      resource_id: result.id,
      result: verdict === "VERIFIED" ? "allow" : verdict === "FAILED" ? "error" : "info",
      metadata: { verdict, required_passed: passed, required_total: GATE_STAGES.length, blocking_stages: blocking.map((b) => `${b.stage}:${b.status}`) },
    });
    return result;
  }
}

/* ------------------------------ Runtime bridge ----------------------------- */

/**
 * Aggregates capability detection across the executor + adapters and exposes
 * a structured runtime status. Emits `runtime.capability.checked` events and
 * records `*.blocked` audit entries — never a false SUCCESS.
 */
export class RuntimeBridge {
  readonly executor: ProcessExecutor;
  readonly docker: DockerAdapter;
  readonly trivy: TrivyAdapter;
  readonly playwright: PlaywrightAdapter;
  readonly smoke: SmokeTestService;
  readonly qualityGate: QualityGateService;
  private last: RuntimeStatus | null = null;

  constructor(private svc: RuntimeBridgeServices, executor?: ProcessExecutor) {
    this.executor = executor ?? createExecutor();
    this.docker = new DockerAdapter(this.executor);
    this.trivy = new TrivyAdapter(this.executor, this.docker);
    this.playwright = new PlaywrightAdapter(this.executor);
    this.smoke = new SmokeTestService(this.executor, this.playwright, svc);
    this.qualityGate = new QualityGateService(svc);
  }

  kind(): RuntimeKind {
    return this.executor.capability().kind;
  }

  platform(): string {
    const bridge = hostBridge();
    return bridge ? bridge.platform() : typeof navigator !== "undefined" ? "browser" : "unknown";
  }

  private result(name: CapabilityName, status: CapabilityStatus, reason: string | null, evidence: string | null): CapabilityResult {
    return { name, status, reason, evidence, checked_at: Date.now() };
  }

  /**
   * Detect every capability with a REAL probe when a host executor exists.
   * In the managed browser runtime this short-circuits to honest BLOCKED.
   */
  async detect(): Promise<RuntimeStatus> {
    const cap = this.executor.capability();
    const results: CapabilityResult[] = [];

    if (!cap.available) {
      const r = cap.reason ?? "process execution unavailable";
      for (const name of ["processExecution", "dockerCli", "dockerDaemon", "trivy", "node", "npm", "git", "playwright", "chromium"] as CapabilityName[]) {
        results.push(this.result(name, "BLOCKED", r, null));
      }
    } else {
      const probe = async (tool: AllowedTool, operation: string, args: string[] = []): Promise<{ ok: boolean; evidence: string | null; reason: string | null }> => {
        const res = await this.executor.run({ tool, operation, args }).catch((e) => ({ exit_code: -1, stdout: "", stderr: (e as Error).message, duration_ms: 0, timed_out: false }));
        if (res.exit_code === 0) return { ok: true, evidence: (res.stdout || "exit 0").trim().split("\n")[0].slice(0, 120), reason: null };
        return { ok: false, evidence: null, reason: `${tool} ${operation} exited ${res.exit_code}: ${(res.stderr || res.stdout).slice(0, 120)}` };
      };

      results.push(this.result("processExecution", "AVAILABLE", null, "host bridge present"));

      const node = await probe("node", "--version");
      results.push(this.result("node", node.ok ? "AVAILABLE" : "UNAVAILABLE", node.reason, node.evidence));
      const npm = await probe("npm", "--version");
      results.push(this.result("npm", npm.ok ? "AVAILABLE" : "UNAVAILABLE", npm.reason, npm.evidence));
      const git = await probe("git", "--version");
      results.push(this.result("git", git.ok ? "AVAILABLE" : "UNAVAILABLE", git.reason, git.evidence));

      const dockerCli = await probe("docker", "version");
      results.push(this.result("dockerCli", dockerCli.ok ? "AVAILABLE" : "UNAVAILABLE", dockerCli.reason, dockerCli.evidence));
      const daemonReachable = dockerCli.ok && /"Server"|Server:/i.test(dockerCli.evidence ?? "") || (await this.docker.run({ kind: "info" })).status === "SUCCEEDED";
      results.push(this.result("dockerDaemon", daemonReachable ? "AVAILABLE" : "BLOCKED", daemonReachable ? null : "Docker daemon unavailable", null));

      const trivyDet = await this.trivy.detect();
      results.push(this.result("trivy", trivyDet.strategy ? "AVAILABLE" : "BLOCKED", trivyDet.reason, trivyDet.strategy ? `strategy=${trivyDet.strategy}` : null));

      const pwDet = await this.playwright.detect();
      results.push(this.result("playwright", pwDet.playwright ? "AVAILABLE" : "BLOCKED", pwDet.reason, null));
      results.push(this.result("chromium", pwDet.chromium ? "AVAILABLE" : "UNKNOWN", pwDet.chromium ? null : "Chromium presence requires host-side verification", null));
    }

    const get = (n: CapabilityName) => results.find((r) => r.name === n)!;
    const dockerStatus = get("dockerCli").status === "AVAILABLE" && get("dockerDaemon").status === "AVAILABLE" ? "AVAILABLE" : get("dockerDaemon").status === "BLOCKED" ? "BLOCKED" : "UNAVAILABLE";

    const status: RuntimeStatus = {
      runtime: this.kind(),
      platform: this.platform(),
      processExecution: get("processExecution").status,
      docker: dockerStatus,
      trivy: get("trivy").status,
      playwright: get("playwright").status,
      chromium: get("chromium").status,
      node: get("node").status,
      npm: get("npm").status,
      git: get("git").status,
      capabilities: results,
    };

    this.last = status;
    await this.recordResults(status);
    return status;
  }

  /** Emit events + audit for each capability; blocked states are logged, never SUCCESS. */
  private async recordResults(status: RuntimeStatus): Promise<void> {
    for (const c of status.capabilities) {
      await this.svc.events.emit({
        type: "runtime.capability.checked" as never,
        source: "RuntimeBridge",
        execution_id: null,
        payload: { capability: c.name, status: c.status, reason: c.reason, evidence: c.evidence },
      });
      if (c.status === "BLOCKED") {
        await this.svc.audit.record({
          actor: "system",
          action: `${c.name}.blocked`,
          resource_type: "runtime",
          resource_id: c.name,
          result: "info",
          metadata: { reason: c.reason, runtime: status.runtime },
        });
      }
    }
  }

  /** Cached status (call detect() to refresh). */
  status(): RuntimeStatus | null {
    return this.last;
  }
}
