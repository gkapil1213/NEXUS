import type { InfrastructureResource } from "./infrastructure-state";

export interface DriftChange {
  type: "RESOURCE_ADDED" | "RESOURCE_REMOVED" | "RESOURCE_CHANGED" | "CONFIGURATION_CHANGED" | "PROVIDER_CHANGED" | "REGION_CHANGED" | "UNKNOWN_DRIFT";
  resource?: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";
  details?: string;
}

export interface DriftDetectionResult {
  status: "NO_DRIFT" | "DRIFTED" | "BLOCKED" | "UNKNOWN";
  severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";
  changes: DriftChange[];
  desired_hash?: string;
  observed_hash?: string;
  detected_at: string;
  reason?: string;
}

export class DriftDetectionService {
  detect(desired: InfrastructureResource[], observed: InfrastructureResource[]): DriftDetectionResult {
    if (!desired.length && !observed.length) {
      return { status: "NO_DRIFT", changes: [], detected_at: new Date().toISOString() };
    }

    const changes: DriftChange[] = [];
    const desiredMap = new Map(desired.map(r => [r.address, r]));
    const observedMap = new Map(observed.map(r => [r.address, r]));

    // Resources removed
    for (const addr of desiredMap.keys()) {
      if (!observedMap.has(addr)) {
        changes.push({
          type: "RESOURCE_REMOVED",
          resource: addr,
          severity: "HIGH",
          details: "Resource exists in desired state but missing in observed state",
        });
      }
    }

    // Resources added
    for (const addr of observedMap.keys()) {
      if (!desiredMap.has(addr)) {
        changes.push({
          type: "RESOURCE_ADDED",
          resource: addr,
          severity: "MEDIUM",
          details: "Resource exists in observed state but not in desired state",
        });
      }
    }

    // Resource changed
    for (const addr of desiredMap.keys()) {
      const d = desiredMap.get(addr);
      const o = observedMap.get(addr);
      if (d && o) {
        if (d.attributes_hash !== o.attributes_hash || d.status !== o.status) {
          changes.push({
            type: "RESOURCE_CHANGED",
            resource: addr,
            severity: "MEDIUM",
            details: "Resource attributes or status differ",
          });
        }
      }
    }

    if (changes.length === 0) {
      return { status: "NO_DRIFT", changes: [], detected_at: new Date().toISOString() };
    }

    const severity = changes.some(c => c.severity === "CRITICAL")
      ? "CRITICAL"
      : changes.some(c => c.severity === "HIGH")
        ? "HIGH"
        : changes.some(c => c.severity === "MEDIUM")
          ? "MEDIUM"
          : "LOW";

    return {
      status: "DRIFTED",
      severity,
      changes,
      detected_at: new Date().toISOString(),
      desired_hash: this.hash(desired),
      observed_hash: this.hash(observed),
    };
  }

  private hash(resources: InfrastructureResource[]): string {
    return `sha256:${resources.map(r => r.attributes_hash).sort().join(":")}`;
  }
}