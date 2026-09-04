import { ExecutionStore } from "./execution-store";
import { ExecutionLease } from "./execution-models";

export class LeaseManager {
  constructor(private store: ExecutionStore) {}

  acquireLease(jobId: string, workerId: string, ttlMs: number, now: number = Date.now()): ExecutionLease {
    // Prevent duplicate active lease for same job
    const existing = this.store.getActiveLeaseForJob(jobId);
    if (existing) {
      throw new Error(`Job ${jobId} already has an active lease`);
    }

    const lease: ExecutionLease = {
      leaseId: `lease_${jobId}_${now}`,
      jobId,
      workerId,
      acquiredAt: now,
      expiresAt: now + ttlMs,
      status: "ACTIVE",
    };
    this.store.acquireLease(lease);
    return lease;
  }

  renewLease(leaseId: string, ttlMs: number, now: number = Date.now()): ExecutionLease {
    const lease = this.store.getLease(leaseId);
    if (!lease || lease.status !== "ACTIVE") {
      throw new Error(`Lease ${leaseId} is not active`);
    }
    if (lease.expiresAt <= now) {
      lease.status = "EXPIRED";
      this.store.updateLease(lease);
      throw new Error(`Lease ${leaseId} already expired`);
    }
    lease.renewedAt = now;
    lease.expiresAt = now + ttlMs;
    this.store.updateLease(lease);
    return lease;
  }

  validateLease(leaseId: string, workerId: string, now: number = Date.now()): boolean {
    const lease = this.store.getLease(leaseId);
    return !!(
      lease &&
      lease.status === "ACTIVE" &&
      lease.workerId === workerId &&
      lease.expiresAt > now
    );
  }

  releaseLease(leaseId: string, now: number = Date.now()): void {
    const lease = this.store.getLease(leaseId);
    if (lease && lease.status === "ACTIVE") {
      lease.releasedAt = now;
      lease.status = "RELEASED";
      this.store.updateLease(lease);
    }
  }

  expireLease(leaseId: string, now: number = Date.now()): void {
    const lease = this.store.getLease(leaseId);
    if (lease && lease.status === "ACTIVE" && lease.expiresAt <= now) {
      lease.status = "EXPIRED";
      this.store.updateLease(lease);
    }
  }

  recoverExpiredLeases(now: number = Date.now()): ExecutionLease[] {
    const expired = this.store.listExpiredLeases(now);
    for (const lease of expired) {
      lease.status = "EXPIRED";
      this.store.updateLease(lease);
    }
    return expired;
  }
}
