import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { nid, digestOf } from "./db";

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

function runLocal(exe: string, args: string[], cwd: string, timeout = 180_000) {
  const t0 = Date.now();
  const res = spawnSync(exe, args, { cwd, encoding: "utf8", timeout, windowsHide: true, shell: false });
  return {
    ok: res.status === 0,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    duration_ms: Date.now() - t0,
  };
}

function firstSuccess(commands: string[][]): { ok: boolean; stdout: string; stderr: string } | null {
  for (const [exe, ...args] of commands) {
    const res = spawnSync(exe, args, { encoding: "utf8", windowsHide: true });
    if (res.status === 0) return { ok: true, stdout: res.stdout || "", stderr: res.stderr || "" };
  }
  return null;
}

function detectLocal(variants: string[][]): ScannerCapability {
  const res = firstSuccess(variants);
  return {
    available: !!res,
    mode: res ? "local" : null,
    reason: res ? null : `command not found or failed`,
  };
}

/* ---------------- Semgrep ---------------- */
export class SemgrepAdapter {
  readonly kind: ScannerKind = "SAST";
  readonly scanner = "semgrep";

  detect(): ScannerCapability {
    return detectLocal([["semgrep", "--version"], ["semgrep.cmd", "--version"]]);
  }

  async scan(workspacePath: string): Promise<ScannerScanResult> {
    const cap = this.detect();
    if (!cap.available) return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: cap.reason, duration_ms: 0 };
    const target = resolve(workspacePath);
    const res = runLocal("semgrep", ["--json", "--quiet", "."], target);
    if (!res.ok && res.stdout.trim() === "") {
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

/* ---------------- Gitleaks ---------------- */
export class GitleaksAdapter {
  readonly kind: ScannerKind = "SECRET";
  readonly scanner = "gitleaks";

  detect(): ScannerCapability {
    return detectLocal([["gitleaks", "version"], ["gitleaks.exe", "version"]]);
  }

  async scan(workspacePath: string): Promise<ScannerScanResult> {
    const cap = this.detect();
    if (!cap.available) return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: cap.reason, duration_ms: 0 };
    const target = resolve(workspacePath);
    const res = runLocal("gitleaks", ["detect", "--source", ".", "--report-format", "json", "--report-path", "-"], target);
    if (!res.ok && res.stdout.trim() === "") {
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
        const description = item.description || "Secret detected";
        const evidence = item.match ? "[REDACTED]" : "[REDACTED]";
        const fingerprint = await digestOf(`${this.scanner}:${rule}:${file}:${line}:${item.rule_id || item.rule || ""}`);
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

/* ---------------- Checkov ---------------- */
export class CheckovAdapter {
  readonly kind: ScannerKind = "IAC";
  readonly scanner = "checkov";

  detect(): ScannerCapability {
    const local = detectLocal([
      ["checkov", "--version"],
      ["checkov.cmd", "--version"],
      ["python", "-m", "checkov", "--version"],
      ["python3", "-m", "checkov", "--version"],
    ]);
    if (local.available) return local;

    // Docker fallback
    const docker = firstSuccess([["docker", "run", "--rm", "bridgecrew/checkov", "--version"]]);
    return {
      available: !!docker,
      mode: docker ? "docker" : null,
      reason: docker ? null : "checkov not installed locally and Docker image unavailable",
    };
  }

  async scan(workspacePath: string): Promise<ScannerScanResult> {
    const cap = this.detect();
    if (!cap.available) return { kind: this.kind, scanner: this.scanner, status: "BLOCKED", findings: [], blocked_reason: cap.reason, duration_ms: 0 };

    const target = resolve(workspacePath);
    const res = cap.mode === "local"
      ? runLocal("python", ["-m", "checkov", "--directory", ".", "--output", "json", "--quiet"], target)
      : runLocal("docker", ["run", "--rm", "-v", `${target}:/src`, "bridgecrew/checkov", "--directory", "/src", "--output", "json", "--quiet"], target);

    if (!res.ok && res.stdout.trim() === "") {
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

/* ---------------- Unified scanner ---------------- */
export class RealSecurityScanner {
  private semgrep = new SemgrepAdapter();
  private gitleaks = new GitleaksAdapter();
  private checkov = new CheckovAdapter();

  async runAll(workspacePath: string) {
    const capabilities = {
      SAST: this.semgrep.detect(),
      SECRET: this.gitleaks.detect(),
      IAC: this.checkov.detect(),
      CONTAINER: { available: false, mode: null, reason: "Container scanner handled separately by Trivy adapter" },
    };

    const results: ScannerScanResult[] = [];
    results.push(capabilities.SAST.available ? await this.semgrep.scan(workspacePath) : { kind: "SAST", scanner: "semgrep", status: "BLOCKED", findings: [], blocked_reason: capabilities.SAST.reason, duration_ms: 0 });
    results.push(capabilities.SECRET.available ? await this.gitleaks.scan(workspacePath) : { kind: "SECRET", scanner: "gitleaks", status: "BLOCKED", findings: [], blocked_reason: capabilities.SECRET.reason, duration_ms: 0 });
    results.push(capabilities.IAC.available ? await this.checkov.scan(workspacePath) : { kind: "IAC", scanner: "checkov", status: "BLOCKED", findings: [], blocked_reason: capabilities.IAC.reason, duration_ms: 0 });

    return { capabilities, results };
  }
}

