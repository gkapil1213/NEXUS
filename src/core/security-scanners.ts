import { NpmAuditAdapter } from "./sca-scanner";
import { nid, digestOf } from "./db";
import type { ProcessExecutor, ExecResult } from "./runtime";

export type ScannerKind = "SAST" | "SECRET" | "IAC" | "CONTAINER" | "SCA";

export interface SecurityFinding {
  id: string;
  fingerprint: string;
  scanner: string;
  category: "SAST" | "SCA" | "SECRET" | "IAC" | "CONTAINER";
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  title: string;
  description: string;
  file: string | null;
  line: number | null;
  resource: string | null;
  evidence: string | null;
  remediation: string | null;
  status: "OPEN" | "RESOLVED" | "HUMAN_REVIEW_REQUIRED";
  created_at: number;
}

export interface ScannerCapability {
  available: boolean;
  mode: "local" | "docker" | null;
  reason: string | null;
}

export interface ScannerScanResult {
  kind: ScannerKind;
  scanner: string;
  status: "PASSED" | "FAILED" | "BLOCKED";
  findings: SecurityFinding[];
  blocked_reason: string | null;
  duration_ms: number;
}

export function normalizeScannerSeverity(raw: string | null | undefined): "critical" | "high" | "medium" | "low" | "unknown" {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s === "critical") return "critical";
  if (s === "high") return "high";
  if (s === "medium" || s === "moderate" || s === "warning") return "medium";
  if (s === "low" || s === "info") return "low";
  if (s === "error") return "critical";
  return "unknown";
}

function detectViaExecutor(exec: ProcessExecutor, tool: "semgrep" | "gitleaks" | "checkov", versionArgs: string[]): Promise<ScannerCapability> {
  return exec
    .run({ tool, operation: versionArgs[0], args: versionArgs.slice(1), timeout_ms: 30000 })
    .then((res) => ({
      available: res.exit_code === 0,
      mode: (res.exit_code === 0 ? "local" : null) as "local" | null,
      reason: res.exit_code === 0 ? null : `${tool}_unavailable`,
    }))
    .catch((): ScannerCapability => ({ available: false, mode: null, reason: `${tool}_invocation_rejected` }));
}

/* ------------------------------ SAST ------------------------------ */
export class SemgrepAdapter {
  readonly kind: ScannerKind = "SAST";
  readonly scanner = "semgrep";

  constructor(private exec: ProcessExecutor) {}

  async detect(): Promise<ScannerCapability> {
    const cap = this.exec.capability();
    if (!cap.available) return { available: false, mode: null, reason: cap.reason };
    return detectViaExecutor(this.exec, "semgrep", ["--version"]);
  }

  async scan(workspacePath: string): Promise<ScannerScanResult> {
    const cap = await this.detect();
    if (!cap.available)
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: cap.reason, duration_ms: 0 };

    let res: ExecResult;
    try {
      res = await this.exec.run({ tool: "semgrep", operation: "scan", args: ["--json", "--quiet", workspacePath], timeout_ms: 180000 });
    } catch {
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: "scanner_invocation_rejected", duration_ms: 0 };
    }

    if (res.timed_out) {
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: "scanner_timeout", duration_ms: res.duration_ms };
    }

    if (res.exit_code !== 0 && res.stdout.trim() === "") {
      return { kind: this.kind, scanner: this.scanner, status: "FAILED", findings: [], blocked_reason: "scanner_exit_failure", duration_ms: res.duration_ms };
    }

    if (res.stdout.trim() === "") {
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: "scanner_output_empty", duration_ms: res.duration_ms };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: "scanner_output_invalid_json", duration_ms: res.duration_ms };
    }

    const p = parsed as Record<string, unknown>;
    const resultsArr = Array.isArray(p.results) ? p.results : [];
    const findings: SecurityFinding[] = [];
    for (const r of resultsArr) {
      const rr = r as Record<string, unknown>;
      const extra = (rr.extra ?? {}) as Record<string, unknown>;
      const meta = (extra.metadata ?? {}) as Record<string, unknown>;
      const severity = normalizeScannerSeverity(String(meta.severity ?? ""));
      const file = typeof rr.path === "string" ? rr.path : null;
      const start = rr.start as Record<string, unknown> | undefined;
      const line = start && typeof start.line === "number" ? start.line : null;
      const title = String(rr.check_id ?? "semgrep finding");
      const description = String(meta.message ?? extra.message ?? "");
      const evidence = extra.lines ? String(extra.lines).slice(0, 200) : null;
      const remediation = typeof meta.remediation === "string" ? meta.remediation : null;
      findings.push({
        id: nid("sec"),
        fingerprint: await digestOf(`${this.scanner}:${title}:${file}:${line}:${extra.message ?? ""}`),
        scanner: this.scanner,
        category: "SAST",
        severity,
        title,
        description,
        file,
        line,
        resource: null,
        evidence,
        remediation,
        status: "OPEN",
        created_at: Date.now(),
      });
    }

    return {
      kind: this.kind,
      scanner: this.scanner,
      status: findings.some((f) => f.severity === "critical" || f.severity === "high") ? "FAILED" : "PASSED",
      findings,
      blocked_reason: null,
      duration_ms: res.duration_ms,
    };
  }
}

/* ------------------------------ SECRET ------------------------------ */
export class GitleaksAdapter {
  readonly kind: ScannerKind = "SECRET";
  readonly scanner = "gitleaks";

  constructor(private exec: ProcessExecutor) {}

  async detect(): Promise<ScannerCapability> {
    const cap = this.exec.capability();
    if (!cap.available) return { available: false, mode: null, reason: cap.reason };
    return detectViaExecutor(this.exec, "gitleaks", ["version"]);
  }

  async scan(workspacePath: string): Promise<ScannerScanResult> {
    const cap = await this.detect();
    if (!cap.available)
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: cap.reason, duration_ms: 0 };

    let res: ExecResult;
    try {
      res = await this.exec.run({
        tool: "gitleaks",
        operation: "detect",
        args: ["--source", workspacePath, "--report-format", "json", "--report-path", "-", "--config", ".gitleaks.toml"],
        timeout_ms: 180000,
      });
    } catch {
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: "scanner_invocation_rejected", duration_ms: 0 };
    }

    if (res.timed_out) {
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: "scanner_timeout", duration_ms: res.duration_ms };
    }

    if (res.exit_code !== 0 && res.stdout.trim() === "") {
      return { kind: this.kind, scanner: this.scanner, status: "FAILED", findings: [], blocked_reason: "scanner_exit_failure", duration_ms: res.duration_ms };
    }

    if (res.stdout.trim() === "") {
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: "scanner_output_empty", duration_ms: res.duration_ms };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: "scanner_output_invalid_json", duration_ms: res.duration_ms };
    }

    const items: unknown[] = Array.isArray(parsed) ? parsed : ((parsed as Record<string, unknown>).findings as unknown[]) ?? [];
    const findings: SecurityFinding[] = [];
    for (const item of items) {
      const i = item as Record<string, unknown>;
      const file = typeof i.File === "string" ? i.File : typeof i.filename === "string" ? i.filename : typeof i.file === "string" ? i.file : null;
      const line = typeof i.StartLine === "number" ? i.StartLine : typeof i.start_line === "number" ? i.start_line : typeof i.line === "number" ? i.line : null;
      const rule = String(i.RuleId ?? i.rule_id ?? i.rule ?? "secret");
      const description = String(i.Description ?? i.description ?? "Secret detected");
      findings.push({
        id: nid("sec"),
        fingerprint: await digestOf(`${this.scanner}:${rule}:${file}:${line}`),
        scanner: this.scanner,
        category: "SECRET",
        severity: "critical",
        title: rule,
        description,
        file,
        line,
        resource: null,
        evidence: "[REDACTED]",
        remediation: "Remove the secret and rotate the credential.",
        status: "OPEN",
        created_at: Date.now(),
      });
    }

    return {
      kind: this.kind,
      scanner: this.scanner,
      status: findings.length > 0 ? "FAILED" : "PASSED",
      findings,
      blocked_reason: null,
      duration_ms: res.duration_ms,
    };
  }
}

/* ------------------------------ IAC (Checkov) ------------------------------ */
export class CheckovAdapter {
  readonly kind: ScannerKind = "IAC";
  readonly scanner = "checkov";

  constructor(private exec: ProcessExecutor) {}

  async detect(): Promise<ScannerCapability> {
    const cap = this.exec.capability();
    if (!cap.available) return { available: false, mode: null, reason: cap.reason };
    const local = await detectViaExecutor(this.exec, "checkov", ["--version"]);
    if (local.available) return local;
    return { available: false, mode: null, reason: "checkov_unavailable" };
  }

  async scan(workspacePath: string): Promise<ScannerScanResult> {
    const cap = await this.detect();
    if (!cap.available)
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: cap.reason, duration_ms: 0 };

    let res: ExecResult;
    try {
      res = await this.exec.run({ tool: "checkov", operation: "--directory", args: [workspacePath, "--output", "json", "--quiet"], timeout_ms: 300000 });
    } catch {
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: "scanner_invocation_rejected", duration_ms: 0 };
    }

    if (res.timed_out) {
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: "scanner_timeout", duration_ms: res.duration_ms };
    }

    if (res.exit_code !== 0 && res.stdout.trim() === "") {
      return { kind: this.kind, scanner: this.scanner, status: "FAILED", findings: [], blocked_reason: "scanner_exit_failure", duration_ms: res.duration_ms };
    }

    if (res.stdout.trim() === "") {
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: "scanner_output_empty", duration_ms: res.duration_ms };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: "scanner_output_invalid_json", duration_ms: res.duration_ms };
    }

    const blocks: Record<string, unknown>[] = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [parsed as Record<string, unknown>];
    const findings: SecurityFinding[] = [];
    for (const block of blocks) {
      const resultsBlock = (block.results ?? {}) as Record<string, unknown>;
      const failed = Array.isArray(resultsBlock.failed_checks) ? resultsBlock.failed_checks : [];
      for (const c of failed) {
        const cc = c as Record<string, unknown>;
        const severity = normalizeScannerSeverity(cc.severity as string | null | undefined);
        const file = typeof cc.file_path === "string" ? cc.file_path : typeof cc.file === "string" ? cc.file : null;
        const lineRange = cc.file_line_range as unknown;
        const line = Array.isArray(lineRange) && typeof lineRange[0] === "number" ? lineRange[0] : null;
        const checkId = String(cc.check_id ?? "checkov_check");
        const checkName = String(cc.check_name ?? checkId);
        findings.push({
          id: nid("sec"),
          fingerprint: await digestOf(`${this.scanner}:${checkId}:${file}:${line}`),
          scanner: this.scanner,
          category: "IAC",
          severity,
          title: checkName,
          description: checkName,
          file,
          line,
          resource: typeof cc.resource === "string" ? cc.resource : null,
          evidence: null,
          remediation: cc.fixed_definition ? "Fix available" : null,
          status: "OPEN",
          created_at: Date.now(),
        });
      }
    }

    return {
      kind: this.kind,
      scanner: this.scanner,
      status: findings.length > 0 ? "FAILED" : "PASSED",
      findings,
      blocked_reason: null,
      duration_ms: res.duration_ms,
    };
  }
}

/* ------------------------------ SCA ------------------------------ */
export class ScaAdapter {
  readonly kind: ScannerKind = "SCA";
  readonly scanner = "npm-audit";
  private adapter: NpmAuditAdapter;

  constructor(private exec: ProcessExecutor) {
    this.adapter = new NpmAuditAdapter(exec);
  }

  async detect(): Promise<ScannerCapability> {
    const cap = this.exec.capability();
    return cap.available
      ? { available: true, mode: "local", reason: null }
      : { available: false, mode: null, reason: cap.reason ?? "process_execution_unavailable" };
  }

  async scan(workspacePath: string): Promise<ScannerScanResult> {
    const res = await this.adapter.scan(workspacePath);
    return {
      kind: "SCA",
      scanner: "npm-audit",
      status: res.status,
      findings: res.findings.map((v) => ({
        id: v.id,
        fingerprint: v.fingerprint,
        scanner: "npm-audit",
        category: "SCA",
        severity: v.severity,
        title: v.title,
        description: v.description,
        file: null,
        line: null,
        resource: v.package_name,
        version: v.version,
        fixed_version: v.fixed_version,
        cwe: Array.isArray(v.cwe) ? v.cwe.join(", ") : (typeof v.cwe === "string" ? v.cwe : undefined),
        evidence: v.advisory_url ?? null,
        remediation: v.fixed_version ? `Upgrade to ${v.fixed_version}` : null,
        status: "OPEN",
        created_at: Date.now(),
      })),
      blocked_reason: res.blocked_reason,
      duration_ms: res.duration_ms,
    };
  }
}

/* ------------------------------ Unified Scanner ------------------------------ */
export class RealSecurityScanner {
  private semgrep: SemgrepAdapter;
  private gitleaks: GitleaksAdapter;
  private checkov: CheckovAdapter;
  private sca: ScaAdapter;

  constructor(exec: ProcessExecutor) {
    this.semgrep = new SemgrepAdapter(exec);
    this.gitleaks = new GitleaksAdapter(exec);
    this.checkov = new CheckovAdapter(exec);
    this.sca = new ScaAdapter(exec);
  }

  async runAll(workspacePath: string) {
    const capabilities = {
      SAST: await this.semgrep.detect(),
      SECRET: await this.gitleaks.detect(),
      IAC: await this.checkov.detect(),
      SCA: await this.sca.detect(),
      CONTAINER: { available: false, mode: null, reason: "container_scanner_not_configured" },
    };

    const results: ScannerScanResult[] = [];
    results.push(
      capabilities.SAST.available
        ? await this.semgrep.scan(workspacePath)
        : { kind: "SAST", scanner: "semgrep", status: "BLOCKED", findings: [], blocked_reason: capabilities.SAST.reason, duration_ms: 0 },
    );
    results.push(
      capabilities.SECRET.available
        ? await this.gitleaks.scan(workspacePath)
        : { kind: "SECRET", scanner: "gitleaks", status: "BLOCKED", findings: [], blocked_reason: capabilities.SECRET.reason, duration_ms: 0 },
    );
    results.push(
      capabilities.IAC.available
        ? await this.checkov.scan(workspacePath)
        : { kind: "IAC", scanner: "checkov", status: "BLOCKED", findings: [], blocked_reason: capabilities.IAC.reason, duration_ms: 0 },
    );
    results.push(
      capabilities.SCA.available
        ? await this.sca.scan(workspacePath)
        : { kind: "SCA", scanner: "npm-audit", status: "BLOCKED", findings: [], blocked_reason: capabilities.SCA.reason, duration_ms: 0 },
    );

    return { capabilities, results };
  }
}
