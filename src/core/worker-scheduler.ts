import Database from "better-sqlite3";
import { WorkerFleetStore, WorkerFleetState } from "./worker-fleet";
import { WorkerCapacityService } from "./worker-capacity";
import { RemoteWorkerStore } from "./remote-worker-store";
import { WorkerHealthStore } from "./worker-health";
import { WorkerTrustStore } from "./worker-trust";
import { WorkerCredentialService } from "./worker-credentials";
import { ExecutionStore } from "./execution-store";
import { LeaseManager } from "./lease-manager";

export type JobPriority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";

export interface JobRequirements {
  requiredCapabilities?: string[];
  requiredLabels?: Record<string, string>;
  requiredOs?: string;
  requiredArchitecture?: string;
  requiredRegion?: string;
  requiredEnvironment?: string;
  minMemory?: number;
  minCpu?: number;
  minDisk?: number;
  priority?: JobPriority;
}

export interface WorkerRejection {
  workerId: string;
  reason: string;
}

export interface SchedulingDecision {
  decisionId: string;
  selectedWorkerId?: string;
  reservationId?: string;
  leaseId?: string;
  rejections: WorkerRejection[];
  selectedReasons: string[];
}

export class WorkerScheduler {
  constructor(
    private db: Database.Database,
    private fleet: WorkerFleetStore,
    private capacity: WorkerCapacityService,
    private remoteWorkers: RemoteWorkerStore,
    private health: WorkerHealthStore,
    private trust: WorkerTrustStore,
    private credentials: WorkerCredentialService,
    private executionStore?: ExecutionStore,
    private leaseManager?: LeaseManager
  ) {}

  schedule(jobId: string, requirements: JobRequirements = {}): SchedulingDecision {
    const decisionId = `dec_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const rejections: WorkerRejection[] = [];

    for (const worker of this.fleet.listWorkers()) {
      if (worker.draining) { rejections.push({ workerId: worker.workerId, reason: "DRAINING" }); continue; }
      if (worker.maintenance) { rejections.push({ workerId: worker.workerId, reason: "MAINTENANCE" }); continue; }

      const healthSnap = this.health.getHealth(worker.workerId);
      if (!healthSnap || healthSnap.healthState !== "HEALTHY") {
        rejections.push({ workerId: worker.workerId, reason: "UNHEALTHY" });
        continue;
      }

      const trustRec = this.trust.getTrust(worker.workerId);
      if (!trustRec || trustRec.trustState !== "TRUSTED") {
        rejections.push({ workerId: worker.workerId, reason: "UNTRUSTED" });
        continue;
      }

      const latestCred = this.credentials.getLatestCredential(worker.workerId);
      if (!latestCred || latestCred.status !== "ACTIVE") {
        rejections.push({ workerId: worker.workerId, reason: "INVALID_CREDENTIAL" });
        continue;
      }

      const remoteWorker = this.remoteWorkers.getWorker(worker.workerId);
      const capabilities = remoteWorker?.capabilities?.operations || [];
      if (requirements.requiredCapabilities) {
        const missing = requirements.requiredCapabilities.filter((cap) => !capabilities.includes(cap));
        if (missing.length > 0) {
          rejections.push({ workerId: worker.workerId, reason: `MISSING_CAPABILITY: ${missing.join(",")}` });
          continue;
        }
      }

      if (requirements.requiredRegion && worker.region !== requirements.requiredRegion) {
        rejections.push({ workerId: worker.workerId, reason: "REGION_MISMATCH" });
        continue;
      }
      if (requirements.requiredEnvironment && worker.environment !== requirements.requiredEnvironment) {
        rejections.push({ workerId: worker.workerId, reason: "ENVIRONMENT_MISMATCH" });
        continue;
      }
      if (requirements.requiredOs && worker.os !== requirements.requiredOs) {
        rejections.push({ workerId: worker.workerId, reason: "OS_MISMATCH" });
        continue;
      }
      if (requirements.requiredArchitecture && worker.architecture !== requirements.requiredArchitecture) {
        rejections.push({ workerId: worker.workerId, reason: "ARCHITECTURE_MISMATCH" });
        continue;
      }

      const limit = worker.concurrencyLimit ?? 0;
      const used = this.capacity.getActiveConcurrency(worker.workerId);
      if (used >= limit) {
        rejections.push({ workerId: worker.workerId, reason: "INSUFFICIENT_CAPACITY" });
        continue;
      }

      // CPU capacity enforcement
      if (requirements.minCpu !== undefined) {
        const reservedCpu = this.capacity.getReservedCpu(worker.workerId);
        if (worker.cpuCapacity === undefined || worker.cpuCapacity - reservedCpu < requirements.minCpu) {
          rejections.push({ workerId: worker.workerId, reason: "INSUFFICIENT_CPU" });
          continue;
        }
      }

      // Memory capacity enforcement
      if (requirements.minMemory !== undefined) {
        const reservedMemory = this.capacity.getReservedMemory(worker.workerId);
        if (worker.memoryCapacity === undefined || worker.memoryCapacity - reservedMemory < requirements.minMemory) {
          rejections.push({ workerId: worker.workerId, reason: "INSUFFICIENT_MEMORY" });
          continue;
        }
      }

      // Disk capacity enforcement
      if (requirements.minDisk !== undefined) {
        const reservedDisk = this.capacity.getReservedDisk(worker.workerId);
        if (worker.diskCapacity === undefined || worker.diskCapacity - reservedDisk < requirements.minDisk) {
          rejections.push({ workerId: worker.workerId, reason: "INSUFFICIENT_DISK" });
          continue;
        }
      }

      // If we have lease/execution integration, try acquire lease before final selection
      let leaseId: string | undefined;
      if (this.executionStore && this.leaseManager) {
        const job = this.executionStore.getJob(jobId);
        if (!job) {
          rejections.push({ workerId: worker.workerId, reason: "JOB_NOT_FOUND" });
          continue;
        }
        try {
          const lease = this.leaseManager.acquireLease(jobId, worker.workerId, 60000);
          leaseId = lease.leaseId;
        } catch {
          rejections.push({ workerId: worker.workerId, reason: "LEASE_ACQUISITION_FAILED" });
          continue;
        }
      }

      // If we reached here, worker is eligible. Select it.
      const reservationId = `res_${jobId}_${Date.now()}`;
      this.capacity.reserve({
        reservationId,
        workerId: worker.workerId,
        jobId,
        leaseId,
        cpu: requirements.minCpu,
        memory: requirements.minMemory,
        disk: undefined,
        concurrency: 1,
        status: "ACTIVE",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
      });

      // Update active jobs count in fleet
      worker.activeJobs += 1;
      this.fleet.upsert(worker);

      return {
        decisionId,
        selectedWorkerId: worker.workerId,
        reservationId,
        leaseId,
        rejections,
        selectedReasons: ["HEALTHY", "TRUSTED", "CAPABILITY_MATCH", "RESOURCE_AVAILABLE", "LOW_LOAD"],
      };
    }

    return { decisionId, rejections, selectedReasons: [] };
  }
}
