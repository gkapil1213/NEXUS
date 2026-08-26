import { nid, digestOf } from "./db";
import type { ProcessExecutor } from "./runtime";

export type ScannerKind = "SAST" | "SECRET" | "IAC" | "CONTAINER";

export interface SecurityFinding {
  id: string;
  fingerprint: string;
  scanner: string;
  category: "SAST" | "SCA" | "SECRET" | "IAC" | "CONTAINER";
  severity: "critical" | "high" | "medium" | "low";
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

function detectViaExecutor(exec: ProcessExecutor, tool: "semgrep" | "gitleaks" | "checkov", versionArgs: string[]): Promise<ScannerCapability> {
  return exec
    .run({ tool, operation: versionArgs[0], args: versionArgs.slice(1), timeout_ms: 15000 })
    .then((res) => ({
      available: res.exit_code === 0,
      mode: (res.exit_code === 0 ? "local" : null) as "local" | null,
      reason: res.exit_code === 0 ? null : `${tool} not available (${res.stderr.slice(0, 120)})`,
    }))
    .catch((e): ScannerCapability => ({
      available: false,
      mode: null,
      reason: `${tool} not available (${(e as Error).message})`,
    }));
}

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

    const res = await this.exec.run({
      tool: "semgrep",
      operation: "scan",
      args: ["--json", "--quiet", workspacePath],
      timeout_ms: 180000,
    });

    if (res.exit_code !== 0 && res.stdout.trim() === "") {
      return { kind: this.kind, scanner: this.scanner, status: "FAILED", findings: [], blocked_reason: res.stderr.slice(0, 300), duration_ms: res.duration_ms };
    }

    const findings: SecurityFinding[] = [];
    try {
      const parsed = JSON.parse(res.stdout);
      for (const r of parsed.results ?? []) {
        const meta = r.extra?.metadata ?? {};
        const sev = (meta.severity || "medium").toLowerCase();
        const file = r.path ?? null;
        const line = r.start?.line ?? null;
        const title = r.check_id ?? "semgrep finding";
        const description = meta.message || r.extra?.message || "";
        const evidence = r.extra?.lines ?? null;
        const remediation = meta.remediation ?? null;
        const fingerprint = await digestOf(`${this.scanner}:${r.check_id}:${file}:${line}:${r.extra?.message || ""}`);
        findings.push({
          id: nid("sec"),
          fingerprint,
          scanner: this.scanner,
          category: "SAST",
          severity: sev === "error" ? "critical" : sev === "warning" ? "high" : sev === "info" ? "low" : "medium",
          title,
          description,
          file,
          line,
          resource: null,
          evidence: evidence ? String(evidence).slice(0, 200) : null,
          remediation,
          status: "OPEN",
          created_at: Date.now(),
        });
      }
    } catch {}

    return {
      kind: this.kind,
      scanner: this.scanner,
      status: findings.some((f) => f.severity === "critical") ? "FAILED" : "PASSED",
      findings,
      blocked_reason: null,
      duration_ms: res.duration_ms,
    };
  }
}

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

    const res = await this.exec.run({
      tool: "gitleaks",
      operation: "detect",
      args: ["--source", workspacePath, "--report-format", "json", "--report-path", "-", "--config", ".gitleaks.toml"],
      timeout_ms: 180000,
    });

    if (res.exit_code !== 0 && res.stdout.trim() === "") {
      return { kind: this.kind, scanner: this.scanner, status: "FAILED", findings: [], blocked_reason: res.stderr.slice(0, 300), duration_ms: res.duration_ms };
    }

    const findings: SecurityFinding[] = [];
    try {
      const parsed = JSON.parse(res.stdout);
      const items = Array.isArray(parsed) ? parsed : parsed?.findings ?? [];
      for (const item of items) {
        const file = item.File || item.filename || item.file || null;
        const line = item.StartLine || item.start_line || item.line || null;
        const rule = item.RuleId || item.rule_id || item.rule || "secret";
        const description = item.Description || item.description || "Secret detected";
        const evidence = item.Match || item.match ? "[REDACTED]" : "[REDACTED]";
        const fingerprint = await digestOf(`${this.scanner}:${rule}:${file}:${line}:${item.RuleId || item.rule_id || ""}`);
        findings.push({
          id: nid("sec"),
          fingerprint,
          scanner: this.scanner,
          category: "SECRET",
          severity: "critical",
          title: rule,
          description,
          file,
          line,
          resource: null,
          evidence,
          remediation: "Remove the secret and rotate the credential.",
          status: "OPEN",
          created_at: Date.now(),
        });
      }
    } catch {}

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

export class CheckovAdapter {
  readonly kind: ScannerKind = "IAC";
  readonly scanner = "checkov";

  constructor(private exec: ProcessExecutor) {}

  async detect(): Promise<ScannerCapability> {
    const cap = this.exec.capability();
    if (!cap.available) return { available: false, mode: null, reason: cap.reason };

    const local = await detectViaExecutor(this.exec, "checkov", ["--version"]);
    if (local.available) return local;

    // Docker fallback
    const dres = await this.exec
      .run({ tool: "docker", operation: "run", args: ["--rm", "bridgecrew/checkov", "--version"], timeout_ms: 30000 })
      .catch(() => null);
    return dres && dres.exit_code === 0
      ? { available: true, mode: "docker", reason: null }
      : { available: false, mode: null, reason: "checkov Docker image unavailable" };
  }

  async scan(workspacePath: string): Promise<ScannerScanResult> {
    const cap = await this.detect();
    if (!cap.available)
      return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: cap.reason, duration_ms: 0 };

    const res =
      cap.mode === "local"
        ? await this.exec.run({
            tool: "checkov",
            operation: "--directory",
            args: [workspacePath, "--output", "json", "--quiet"],
            timeout_ms: 180000,
          })
        : await this.exec.run({
            tool: "docker",
            operation: "run",
            args: ["--rm", "-v", `${workspacePath}:/src`, "bridgecrew/checkov", "--directory", "/src", "--output", "json", "--quiet"],
            timeout_ms: 180000,
          });

    if (res.exit_code !== 0 && res.stdout.trim() === "") {
      return { kind: this.kind, scanner: this.scanner, status: "FAILED", findings: [], blocked_reason: res.stderr.slice(0, 300), duration_ms: res.duration_ms };
    }

    const findings: SecurityFinding[] = [];
    try {
      const parsed = JSON.parse(res.stdout);
      for (const c of parsed?.results?.failed_checks ?? []) {
        const sev = (c.severity || "medium").toLowerCase();
        const file = c.file_path || c.file || null;
        const line = c.file_line_range?.[0] || null;
        const fingerprint = await digestOf(`${this.scanner}:${c.check_id}:${file}:${line}`);
        findings.push({
          id: nid("sec"),
          fingerprint,
          scanner: this.scanner,
          category: "IAC",
          severity: sev === "critical" ? "critical" : sev === "high" ? "high" : sev === "medium" ? "medium" : "low",
          title: c.check_name || c.check_id,
          description: c.check_name || c.check_id,
          file,
          line,
          resource: c.resource || null,
          evidence: null,
          remediation: c.fixed_definition ? "Fix available" : null,
          status: "OPEN",
          created_at: Date.now(),
        });
      }
    } catch {}

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

export class RealSecurityScanner {
  private semgrep: SemgrepAdapter;
  private gitleaks: GitleaksAdapter;
  private checkov: CheckovAdapter;

  constructor(exec: ProcessExecutor) {
    this.semgrep = new SemgrepAdapter(exec);
    this.gitleaks = new GitleaksAdapter(exec);
    this.checkov = new CheckovAdapter(exec);
  }

  async runAll(workspacePath: string) {
  const capabilities = {
    SAST: await this.semgrep.detect(),
    SECRET: await this.gitleaks.detect(),
    // IAC detection is skipped entirely to avoid Docker hang.
    IAC: { available: false, mode: null, reason: "skipped for debug" },
    CONTAINER: { available: false, mode: null, reason: "Container scanner handled separately by Trivy adapter" },
  };

  const results: ScannerScanResult[] = [];

  // SAST is enabled
  results.push(
    capabilities.SAST.available
      ? await this.semgrep.scan(workspacePath)
      : { kind: "SAST", scanner: "semgrep", status: "BLOCKED", findings: [], blocked_reason: capabilities.SAST.reason, duration_ms: 0 },
  );

  // SECRET is enabled
  results.push(
    capabilities.SECRET.available
      ? await this.gitleaks.scan(workspacePath)
      : { kind: "SECRET", scanner: "gitleaks", status: "BLOCKED", findings: [], blocked_reason: capabilities.SECRET.reason, duration_ms: 0 },
  );

  // IAC: just return BLOCKED dummy result
  results.push({ kind: "IAC", scanner: "checkov", status: "BLOCKED", findings: [], blocked_reason: "skipped for debug", duration_ms: 0 });

  return { capabilities, results };
  }
}