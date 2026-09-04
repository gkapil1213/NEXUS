import { WorkerTelemetryStore, TelemetryEvent, TelemetryEventType } from "./worker-telemetry";
import { WorkerAuditStore, AuditEvent } from "./worker-audit";

export class WorkerObservabilityService {
  constructor(
    private telemetry: WorkerTelemetryStore,
    private audit: WorkerAuditStore
  ) {}

  recordTelemetry(event: TelemetryEvent): void {
    this.telemetry.persist(event);
  }

  recordAudit(event: AuditEvent): void {
    this.audit.append(event);
  }

  recordExecution(
    event: {
      workerId: string;
      sessionId?: string;
      jobId?: string;
      attemptId?: string;
      dispatchId?: string;
      leaseId?: string;
      eventType: TelemetryEventType;
      payload: Record<string, any>;
    }
  ): void {
    const eventId = `tel_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.recordTelemetry({
      eventId,
      eventType: event.eventType,
      timestamp: Date.now(),
      workerId: event.workerId,
      sessionId: event.sessionId,
      jobId: event.jobId,
      attemptId: event.attemptId,
      dispatchId: event.dispatchId,
      leaseId: event.leaseId,
      correlationId: event.jobId,
      payload: event.payload,
    });
    this.recordAudit({
      eventId: `aud_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      eventType: event.eventType,
      timestamp: Date.now(),
      workerId: event.workerId,
      sessionId: event.sessionId,
      jobId: event.jobId,
      attemptId: event.attemptId,
      dispatchId: event.dispatchId,
      leaseId: event.leaseId,
      correlationId: event.jobId,
      payload: event.payload,
    });
  }
}
