export class WorkerReleaseVerification {
  verify(availability: number, latency: number, errorRate: number, sloState: string, telemetryFresh: boolean): "HEALTHY" | "DEGRADED" | "STALE" | "INSUFFICIENT" {
    if (!telemetryFresh) return "STALE";
    if (!Number.isFinite(availability) || !Number.isFinite(latency) || !Number.isFinite(errorRate)) return "INSUFFICIENT";
    if (sloState === "CRITICAL" || errorRate > 0.1) return "DEGRADED";
    return "HEALTHY";
  }
}
