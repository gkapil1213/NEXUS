import { createHash } from "crypto";

export interface FailureIncident {
  workerClass?: string;
  workloadClass?: string;
  failureDomain?: string;
  failureType?: string;
  sliDegradation?: number;
  sloImpact?: string;
  resourcePressure?: number;
  controlAction?: string;
  recoveryAction?: string;
}

export class WorkerFailureSignature {
  generate(incident: FailureIncident): string {
    const normalized: Record<string, string | number> = {
      worker_class: incident.workerClass ?? "unknown",
      workload_class: incident.workloadClass ?? "unknown",
      failure_domain: incident.failureDomain ?? "unknown",
      failure_type: incident.failureType ?? "unknown",
      sli_degradation: incident.sliDegradation ?? 0,
      slo_impact: incident.sloImpact ?? "UNKNOWN",
      resource_pressure: incident.resourcePressure ?? 0,
      control_action: incident.controlAction ?? "NONE",
      recovery_action: incident.recoveryAction ?? "NONE",
    };

    const canonical = Object.keys(normalized)
      .sort()
      .map((k) => `${k}:${normalized[k]}`)
      .join("|");

    return createHash("sha256").update(canonical).digest("hex");
  }
}
