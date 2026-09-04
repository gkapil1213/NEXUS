import { WorkerBackpressureEngine, BackpressureState } from "./worker-backpressure";
import { WorkerFleetStore } from "./worker-fleet";
import { WorkerCapacityService } from "./worker-capacity";
import { WorkerScheduler, JobRequirements } from "./worker-scheduler";

export type AdmissionDecision = "ADMIT" | "DEFER" | "REJECT";

export interface AdmissionResult {
  decision: AdmissionDecision;
  jobId: string;
  workerId?: string;
  reasons: string[];
  reservationId?: string;
  leaseId?: string;
  correlationId?: string;
}

export class WorkerAdmissionEngine {
  constructor(
    private backpressure: WorkerBackpressureEngine,
    private fleet: WorkerFleetStore,
    private capacity: WorkerCapacityService,
    private scheduler: WorkerScheduler
  ) {}

  evaluate(jobId: string, requirements: JobRequirements, queueDepth: number, utilization: number, priority?: string): AdmissionResult {
    const backpressureState = this.backpressure.evaluate(queueDepth, utilization);

    // Critical backpressure: only CRITICAL jobs admitted, others deferred
    if (backpressureState === "CRITICAL") {
      if (priority !== "CRITICAL") {
        return { decision: "DEFER", jobId, reasons: ["CRITICAL_BACKPRESSURE"] };
      }
    }

    // High backpressure: low/normal priority deferred
    if (backpressureState === "HIGH") {
      if (priority === "LOW") {
        return { decision: "DEFER", jobId, reasons: ["HIGH_BACKPRESSURE"] };
      }
    }

    // Attempt to schedule (will enforce capacity/security)
    const scheduling = this.scheduler.schedule(jobId, requirements);
    if (scheduling.selectedWorkerId) {
      return {
        decision: "ADMIT",
        jobId,
        workerId: scheduling.selectedWorkerId,
        reasons: scheduling.selectedReasons,
        reservationId: scheduling.reservationId,
        leaseId: scheduling.leaseId,
        correlationId: jobId,
      };
    } else {
      // Determine whether to reject or defer based on whether any workers eligible but no capacity vs all rejected
      const hasCapacityIssue = scheduling.rejections.some(r => r.reason === "INSUFFICIENT_CAPACITY");
      if (hasCapacityIssue) {
        return { decision: "DEFER", jobId, reasons: ["NO_CAPACITY"] };
      }
      return { decision: "REJECT", jobId, reasons: scheduling.rejections.map(r => r.reason) };
    }
  }
}
