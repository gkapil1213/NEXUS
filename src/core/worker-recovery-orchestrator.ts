import Database from "better-sqlite3";
import { WorkerRecoveryService } from "./worker-recovery";
import { WorkerCapacityService } from "./worker-capacity";
import { WorkerLeaseAnomalyDetector, LeaseAnomaly } from "./worker-lease-anomaly";
import { ExecutionStore } from "./execution-store";
import { LeaseManager } from "./lease-manager";
import { RemoteWorkerStore } from "./remote-worker-store";
import { WorkerHealthStore } from "./worker-health";
import { WorkerTrustStore } from "./worker-trust";
import { WorkerCredentialService } from "./worker-credentials";
import { WorkerFleetStore } from "./worker-fleet";
import { WorkerScheduler } from "./worker-scheduler";

export type RecoveryState =
  | "DETECTED"
  | "ASSESSING"
  | "BLOCKED"
  | "RECONCILING"
  | "REQUEUED"
  | "RESCHEDULING"
  | "DISPATCHING"
  | "VERIFYING"
  | "RECOVERED"
  | "FAILED"
  | "MANUAL_INTERVENTION_REQUIRED";

export class WorkerRecoveryOrchestrator {
  constructor(
    private db: Database.Database,
    private recovery: WorkerRecoveryService,
    private capacity: WorkerCapacityService,
    private anomalyDetector: WorkerLeaseAnomalyDetector,
    private executionStore: ExecutionStore,
    private leaseManager: LeaseManager,
    private remoteWorkers: RemoteWorkerStore,
    private health: WorkerHealthStore,
    private trust: WorkerTrustStore,
    private credentials: WorkerCredentialService,
    private fleet: WorkerFleetStore,
    private scheduler: WorkerScheduler
  ) {}

  async recoverJob(jobId: string, workerId: string, reason: string, idempotencyKey: string): Promise<RecoveryState> {
    const existing = this.db.prepare(
      "SELECT state FROM worker_recovery_operations WHERE idempotency_key = ?"
    ).get(idempotencyKey) as any;
    if (existing) return existing.state as RecoveryState;

    this.db.prepare(`
      INSERT INTO worker_recovery_operations (operation_id, job_id, worker_id, state, idempotency_key, evidence, created_at, updated_at)
      VALUES (?, ?, ?, 'DETECTED', ?, ?, ?, ?)
    `).run(
      `recovery_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      jobId,
      workerId,
      idempotencyKey,
      JSON.stringify({ reason }),
      Date.now(),
      Date.now()
    );

    const anomalies = this.anomalyDetector.detect();
    for (const anomaly of anomalies) {
      if (anomaly.classification === "EXPIRED_ACTIVE_LEASE" || anomaly.classification === "WORKER_UNAVAILABLE") {
        this.leaseManager.expireLease(anomaly.leaseId);
      }
    }

    const result = await this.recovery.recoverWorker(workerId, reason, idempotencyKey);
    let state: RecoveryState;
    switch (result.action) {
      case "RETRY":
        state = "REQUEUED";
        break;
      case "DEAD_LETTER":
        state = "FAILED";
        break;
      case "QUARANTINE":
        state = "BLOCKED";
        break;
      default:
        state = "MANUAL_INTERVENTION_REQUIRED";
    }

    this.db.prepare(`
      UPDATE worker_recovery_operations SET state = ?, updated_at = ? WHERE idempotency_key = ?
    `).run(state, Date.now(), idempotencyKey);
    return state;
  }

  isDuplicate(idempotencyKey: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM worker_recovery_operations WHERE idempotency_key = ?").get(idempotencyKey);
    return !!row;
  }
}
