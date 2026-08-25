import { RealSecurityScanner, type SecurityFinding, type ScannerScanResult } from "./security-scanners";
import type { EventService } from "./events";
import type { AuditService } from "./audit";
import { nid } from "./db";

export interface SecurityPipelineReport {
  execution_id: string;
  started_at: number;
  completed_at: number;
  capabilities: Record<"SAST" | "SECRET" | "IAC" | "CONTAINER", { available: boolean; mode: string | null }>;
  results: ScannerScanResult[];
  findings: SecurityFinding[];
  verdict: "PASS" | "FAIL" | "BLOCKED";
  blocked_reason: string | null;
}

export class SecurityPipeline {
  constructor(
    private events: EventService,
    private audit: AuditService,
    private scanner = new RealSecurityScanner(),
  ) {}

  async run(workspacePath: string, actor = "system"): Promise<SecurityPipelineReport> {
    const execution_id = nid("secrun");
    const started_at = Date.now();

    await this.events.emit({
      type: "security.scan.started" as never,
      source: "SecurityPipeline",
      execution_id,
      payload: { workspace: workspacePath },
    });

    const { capabilities, results } = await this.scanner.runAll(workspacePath);

    const allFindings = results.flatMap((r) => r.findings);
    const blockedScanners = results.filter((r) => r.status === "BLOCKED");
    const failedScanners = results.filter((r) => r.status === "FAILED");

    for (const finding of allFindings) {
      await this.events.emit({
        type: "security.finding.created" as never,
        source: "SecurityPipeline",
        execution_id,
        payload: {
          id: finding.id,
          scanner: finding.scanner,
          category: finding.category,
          severity: finding.severity,
          fingerprint: finding.fingerprint,
          file: finding.file,
          line: finding.line,
        },
      });
    }

    await this.events.emit({
      type: "security.scan.completed" as never,
      source: "SecurityPipeline",
      execution_id,
      payload: {
        total_findings: allFindings.length,
        blocked: blockedScanners.length,
        failed: failedScanners.length,
      },
    });

    await this.audit.record({
      actor,
      action: "security.scan.completed",
      resource_type: "security_scan",
      resource_id: execution_id,
      result: failedScanners.length > 0 || allFindings.length > 0 ? "error" : "allow",
      metadata: {
        workspace: workspacePath,
        total_findings: allFindings.length,
        blocked_scanners: blockedScanners.map((r) => r.scanner),
      },
    });

    const verdict =
      failedScanners.length > 0 || allFindings.some((f) => f.severity === "critical")
        ? "FAIL"
        : blockedScanners.length > 0
          ? "BLOCKED"
          : "PASS";

    return {
      execution_id,
      started_at,
      completed_at: Date.now(),
      capabilities: {
        SAST: { available: capabilities.SAST.available, mode: capabilities.SAST.mode },
        SECRET: { available: capabilities.SECRET.available, mode: capabilities.SECRET.mode },
        IAC: { available: capabilities.IAC.available, mode: capabilities.IAC.mode },
        CONTAINER: { available: false, mode: null },
      },
      results,
      findings: allFindings,
      verdict,
      blocked_reason: blockedScanners.length > 0 ? blockedScanners.map((r) => `${r.scanner}: ${r.blocked_reason}`).join("; ") : null,
    };
  }
}
