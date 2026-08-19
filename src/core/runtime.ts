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

export type AllowedTool = "docker" | "trivy" | "git" | "node" | "npm" | "npx" | "playwright";

const EXECUTABLES: Record<AllowedTool, { win: string; posix: string }> = {
  docker: { win: "docker.exe", posix: "docker" },
  trivy: { win: "trivy.exe", posix: "trivy" },
  git: { win: "git.exe", posix: "git" },
  node: { win: "node.exe", posix: "node" },
  npm: { win: "npm.cmd", posix: "npm" },
  npx: { win: "npx.cmd", posix: "npx" },
  playwright: { win: "playwright.cmd", posix: "playwright" },
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
    return a;
  });
}

/** Per-tool operation allowlists. Only these operations may ever be invoked. */
const TOOL_OPERATIONS: Record<AllowedTool, readonly string[]> = {
  docker: ["version", "info", "build", "inspect", "run", "ps", "logs", "stop", "rm"],
  trivy: ["--version", "image", "filesystem"],
  git: ["--version", "status", "log", "rev-parse"],
  node: ["--version"],
  npm: ["--version", "ls"],
  npx: ["--version", "playwright"],
  playwright: ["--version"],
};

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
    const args = sanitizeArgs([cmd.operation, ...cmd.args]);
    const exe = resolveExecutable(this.bridge.platform(), cmd.tool);
    const t0 = performance.now();
    let timedOut = false;
    const timeout = cmd.timeout_ms ?? 120_000;

    const execP = this.bridge.exec(exe, args, { timeout_ms: timeout, cwd: cmd.cwd });
    const timerP = new Promise<never>((_, reject) =>
      window.setTimeout(() => {
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

  async detect(): Promise<{ playwright: boolean; chromium: boolean; reason: string | null }> {
    const cap = this.exec.capability();
    if (!cap.available) return { playwright: false, chromium: false, reason: cap.reason ?? "process execution unavailable" };
    const pw = await this.exec.run({ tool: "npx", operation: "playwright", args: ["--version"] }).catch(() => null);
    const playwright = !!pw && pw.exit_code === 0;
    // Browser presence requires a host-side check we cannot fake; report honestly.
    return { playwright, chromium: false, reason: playwright ? null : "Playwright not installed on host" };
  }

  /** Architecture for real smoke tests; BLOCKED unless a host can execute. */
  async smoke(url: string): Promise<SmokeTestOutcome> {
    const det = await this.detect();
    if (!det.playwright) {
      return { status: "BLOCKED", browser: null, url: null, http_status: null, console_errors: [], page_errors: [], screenshot_ref: null, blocked_reason: det.reason ?? "Playwright unavailable", duration_ms: null };
    }
    // A real host would drive Chromium here via the bridge. We do not simulate
    // navigation or invent results, so without a browser runner this remains
    // BLOCKED with the exact reason.
    return {
      status: "BLOCKED",
      browser: null,
      url,
      http_status: null,
      console_errors: [],
      page_errors: [],
      screenshot_ref: null,
      blocked_reason: "Chromium browser runner not available on this host — smoke test cannot execute",
      duration_ms: null,
    };
  }
}

/* ------------------------------ Runtime bridge ----------------------------- */

export interface RuntimeBridgeServices {
  events: EventService;
  audit: AuditService;
}

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
  private last: RuntimeStatus | null = null;

  constructor(private svc: RuntimeBridgeServices, executor?: ProcessExecutor) {
    this.executor = executor ?? createExecutor();
    this.docker = new DockerAdapter(this.executor);
    this.trivy = new TrivyAdapter(this.executor, this.docker);
    this.playwright = new PlaywrightAdapter(this.executor);
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
