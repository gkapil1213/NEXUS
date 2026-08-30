import { EventService } from "./events";

export class InfrastructureEventService {
  constructor(private events: EventService) {}

  emit(kind: string, executionId: string, payload: Record<string, unknown> = {}) {
    return this.events.emit({
      type: `infrastructure.${kind}` as any,
      source: "infrastructure",
      execution_id: executionId,
      payload,
    });
  }

  planStarted(executionId: string, planDigest: string, environment: string) {
    return this.emit("plan.started", executionId, { plan_digest: planDigest, environment });
  }

  applyStarted(executionId: string, planDigest: string) {
    return this.emit("apply.started", executionId, { plan_digest: planDigest });
  }

  applyCompleted(executionId: string, planDigest: string) {
    return this.emit("apply.completed", executionId, { plan_digest: planDigest });
  }

  failureDetected(executionId: string, failure: Record<string, unknown>) {
    return this.emit("failure.detected", executionId, failure);
  }

  recoveryStarted(executionId: string) {
    return this.emit("recovery.started", executionId, {});
  }

  recoveryCompleted(executionId: string) {
    return this.emit("recovery.completed", executionId, {});
  }

  driftDetected(executionId: string, drift: Record<string, unknown>) {
    return this.emit("drift.detected", executionId, drift);
  }
}