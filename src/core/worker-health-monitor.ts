import { WorkerHealthSnapshot, WorkerHealthState, WorkerHealthStore } from "./worker-health";

export interface HealthThresholds {
  staleAfterMs: number;
  unhealthyAfterMs: number;
  disconnectAfterMs: number;
}

export class WorkerHealthMonitor {
  constructor(private store: WorkerHealthStore, private thresholds: HealthThresholds) {}

  evaluate(snapshot: WorkerHealthSnapshot, now: number = Date.now()): WorkerHealthState {
    if (snapshot.healthState === "REVOKED") return "REVOKED";
    const age = snapshot.lastHeartbeatAt ? now - snapshot.lastHeartbeatAt : Number.MAX_SAFE_INTEGER;
    if (age >= this.thresholds.disconnectAfterMs) return "DISCONNECTED";
    if (age >= this.thresholds.unhealthyAfterMs) return "UNHEALTHY";
    if (age >= this.thresholds.staleAfterMs) return "STALE";
    if (snapshot.heartbeatFailures > 0) return "DEGRADED";
    return "HEALTHY";
  }

  updateHealth(snapshot: WorkerHealthSnapshot, now: number = Date.now()): void {
    const nextState = this.evaluate(snapshot, now);
    if (nextState !== snapshot.healthState) {
      snapshot.healthState = nextState;
      snapshot.updatedAt = now;
      this.store.upsertHealth(snapshot);
      this.store.recordHealthEvent({
        eventId: `he_${snapshot.workerId}_${now}`,
        workerId: snapshot.workerId,
        eventType: "HEALTH_CHANGED",
        payload: { from: snapshot.healthState, to: nextState },
        createdAt: now,
      });
    }
  }
}
