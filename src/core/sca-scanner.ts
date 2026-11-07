import { nid, digestOf } from "./db";
import type { ProcessExecutor, ExecResult } from "./runtime";

export interface ScaVulnerability {
  id: string;
  package_name: string;
  version: string;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  title: string;
  description: string;
  fixed_version: string | null;
  source: string;
  fingerprint: string;
  cwe?: string[];
  advisory_url?: string | null;
}

export interface ScaScanResult {
  status: "PASSED" | "FAILED" | "BLOCKED";
  scanner: string;
  findings: ScaVulnerability[];
  blocked_reason: string | null;
  duration_ms: number;
}

function normalizeSeverity(raw: string | null | undefined): "critical" | "high" | "medium" | "low" | "unknown" {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s === "critical") return "critical";
  if (s === "high") return "high";
  if (s === "medium" || s === "moderate") return "medium";
  if (s === "low" || s === "info") return "low";
  return "unknown";
}

export class NpmAuditAdapter {
  readonly scanner = "npm-audit";

  constructor(private exec: ProcessExecutor) {}

  async scan(workspacePath: string): Promise<ScaScanResult> {
    const cap = this.exec.capability();
    if (!cap.available) {
      return {
        status: "BLOCKED",
        scanner: this.scanner,
        findings: [],
        blocked_reason: cap.reason ?? "process execution unavailable",
        duration_ms: 0,
      };
    }

    let res: ExecResult;
    try {
      res = await this.exec.run({
        tool: "npm",
        operation: "audit",
        args: ["--json"],
        timeout_ms: 180_000,
        cwd: workspacePath,
      });
    } catch {
      return {
        status: "BLOCKED",
        scanner: this.scanner,
        findings: [],
        blocked_reason: "scanner_invocation_rejected",
        duration_ms: 0,
      };
    }

    if (res.timed_out) {
      return { status: "BLOCKED", scanner: this.scanner, findings: [], blocked_reason: "scanner_timeout", duration_ms: res.duration_ms };
    }

    if (res.exit_code !== 0 && res.stdout.trim() === "") {
      return {
        status: "FAILED",
        scanner: this.scanner,
        findings: [],
        blocked_reason: "scanner_exit_failure",
        duration_ms: res.duration_ms,
      };
    }

    if (res.stdout.trim() === "") {
      return { status: "BLOCKED", scanner: this.scanner, findings: [], blocked_reason: "scanner_output_empty", duration_ms: res.duration_ms };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return { status: "BLOCKED", scanner: this.scanner, findings: [], blocked_reason: "scanner_output_invalid_json", duration_ms: res.duration_ms };
    }

    const root = parsed as Record<string, unknown>;
    const findings: ScaVulnerability[] = [];

    // npm audit v6 shape: { advisories: { [id]: { module_name, severity, title, ... } } }
    const advisories = (root.advisories ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, adv] of Object.entries(advisories)) {
      const sev = normalizeSeverity(String(adv.severity ?? ""));
      const cweRaw = adv.cwe;
      const cwe = Array.isArray(cweRaw) ? cweRaw.map(String) : typeof cweRaw === "string" ? [cweRaw] : [];
      findings.push({
        id: nid("sca"),
        package_name: String(adv.module_name ?? key),
        version: String(adv.version ?? ""),
        severity: sev,
        title: String(adv.title ?? "Vulnerability"),
        description: String(adv.overview ?? ""),
        fixed_version: typeof adv.fix_available === "object" && adv.fix_available !== null && "version" in adv.fix_available
          ? String((adv.fix_available as Record<string, unknown>).version ?? "") || null
          : null,
        source: "npm-audit",
        fingerprint: await digestOf(`${this.scanner}:${key}:${adv.version ?? ""}`),
        cwe,
        advisory_url: typeof adv.url === "string" ? adv.url : null,
      });
    }

    // npm audit v7+ shape: { vulnerabilities: { [pkg]: { severity, via: [{title,url,cwe},...], range, ... } } }
    const vulns = (root.vulnerabilities ?? {}) as Record<string, Record<string, unknown>>;
    for (const [pkg, v] of Object.entries(vulns)) {
      const viaRaw = v.via;
      const viaList = Array.isArray(viaRaw) ? viaRaw : [];
      const sev = normalizeSeverity(String(v.severity ?? ""));
      if (viaList.length === 0) {
        findings.push({
          id: nid("sca"),
          package_name: pkg,
          version: String(v.range ?? ""),
          severity: sev,
          title: `${pkg} vulnerability`,
          description: "",
          fixed_version: null,
          source: "npm-audit",
          fingerprint: await digestOf(`${this.scanner}:v7:${pkg}:${v.range ?? ""}`),
          cwe: [],
          advisory_url: null,
        });
        continue;
      }
      for (const via of viaList) {
        if (typeof via === "string") {
          findings.push({
            id: nid("sca"),
            package_name: pkg,
            version: String(v.range ?? ""),
            severity: sev,
            title: String(via),
            description: "",
            fixed_version: null,
            source: "npm-audit",
            fingerprint: await digestOf(`${this.scanner}:v7s:${pkg}:${v.range ?? ""}:${via}`),
            cwe: [],
            advisory_url: null,
          });
          continue;
        }
        const viaObj = via as Record<string, unknown>;
        const cweRaw = viaObj.cwe;
        const cwe = Array.isArray(cweRaw) ? cweRaw.map(String) : typeof cweRaw === "string" ? [cweRaw] : [];
        findings.push({
          id: nid("sca"),
          package_name: pkg,
          version: String(v.range ?? ""),
          severity: sev,
          title: String(viaObj.title ?? viaObj.name ?? `${pkg} vulnerability`),
          description: "",
          fixed_version: null,
          source: "npm-audit",
          fingerprint: await digestOf(`${this.scanner}:v7o:${pkg}:${v.range ?? ""}:${viaObj.url ?? ""}`),
          cwe,
          advisory_url: typeof viaObj.url === "string" ? viaObj.url : null,
        });
      }
    }

    const status = findings.some((f) => f.severity === "critical" || f.severity === "high") ? "FAILED" : "PASSED";
    return { status, scanner: this.scanner, findings, blocked_reason: null, duration_ms: res.duration_ms };
  }
}
