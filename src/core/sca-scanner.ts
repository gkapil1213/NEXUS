import { nid, digestOf } from "./db";
import type { ProcessExecutor } from "./runtime";

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
}

export interface ScaScanResult {
  status: "PASSED" | "FAILED" | "BLOCKED";
  scanner: string;
  findings: ScaVulnerability[];
  blocked_reason: string | null;
  duration_ms: number;
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

    const res = await this.exec.run({
      tool: "npm",
      operation: "audit",
      args: ["--json"],
      timeout_ms: 180_000,
      cwd: workspacePath,
    });

    if (res.exit_code !== 0 && res.stdout.trim() === "") {
      return {
        status: "FAILED",
        scanner: this.scanner,
        findings: [],
        blocked_reason: res.stderr.slice(0, 300),
        duration_ms: res.duration_ms,
      };
    }

    const findings: ScaVulnerability[] = [];
    try {
      const parsed = JSON.parse(res.stdout);
      const advisories = parsed.advisories ?? {};
      for (const [key, adv] of Object.entries<any>(advisories)) {
        const sev = (adv.severity || "unknown").toLowerCase();
        findings.push({
          id: nid("sca"),
          package_name: adv.module_name || key,
          version: adv.version || "",
          severity: sev === "critical" ? "critical" : sev === "high" ? "high" : sev === "moderate" ? "medium" : sev === "low" ? "low" : "unknown",
          title: adv.title || "Vulnerability",
          description: adv.overview || "",
          fixed_version: adv.fix_available?.version ?? null,
          source: "npm-audit",
          fingerprint: await digestOf(`${this.scanner}:${key}:${adv.version}`),
        });
      }
    } catch {}

    return {
      status: findings.some((f) => f.severity === "critical" || f.severity === "high") ? "FAILED" : "PASSED",
      scanner: this.scanner,
      findings,
      blocked_reason: null,
      duration_ms: res.duration_ms,
    };
  }
}