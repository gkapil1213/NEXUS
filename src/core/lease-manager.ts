import { ExecutionStore } from "./execution-store";
import { ExecutionLease } from "./execution-models";

export class LeaseManager {
  constructor(private store: ExecutionStore) {}

  acquireLease(jobId: string, workerId: string, durationMs: number): ExecutionLease {
    const now = Date.now();
    const leaseId = `lease_${jobId}_${now}_${workerId}`;
    const lease: ExecutionLease = {
      leaseId,
      jobId,
      workerId,
      acquiredAt: now,
      expiresAt: now + durationMs,
      renewedAt: undefined,
      releasedAt: undefined,
      status: "ACTIVE",
    };
    const result = this.store.acquireLease(lease);
    if (result.acquired) {
      return lease;
    }
    if (result.existingLease) {
      if (result.existingLease.workerId === workerId) {
        return result.existingLease;
      }
      throw new Error(`Lease already held by another worker for job ${jobId}`);
    }
    throw new Error(`Lease acquisition failed for job ${jobId}`);
  }

  /**
   * Phase 126: renewing requires caller to prove ownership.
   * A worker that no longer owns the lease receives an explicit error
   * rather than silently renewing another worker's lease.
   */
  renewLease(leaseId: string, workerId: string, ttlMs: number, now: number = Date.now()): ExecutionLease {
    const lease = this.store.getLease(leaseId);
    if (!lease || lease.status !== "ACTIVE") {
      throw new Error(`Lease ${leaseId} is not active`);
    }
    // Phase 127: expiry check must precede ownership check.  Otherwise a
    // wrong-worker renewal on an expired lease throws "owned by" and leaves
    // the row in (ACTIVE, expires_at < now), blocking reacquisition until
    // the next recovery sweep.
    if (lease.expiresAt <= now) {
      lease.status = "EXPIRED";
      this.store.updateLease(lease);
      throw new Error(`Lease ${leaseId} already expired`);
    }
    if (lease.workerId !== workerId) {
      throw new Error(`Lease ${leaseId} is owned by ${lease.workerId}, not ${workerId}`);
    }

    const renewedAt = now;
    const expiresAt = now + ttlMs;
    const renewed = this.store.renewLeaseAsOwner(
      leaseId,
      workerId,
      renewedAt,
      expiresAt,
      now
    );

    if (!renewed) {
      throw new Error(`Lease ${leaseId} ownership was lost during renewal`);
    }

    lease.renewedAt = renewedAt;
    lease.expiresAt = expiresAt;
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

  getActiveLeaseForJob(jobId: string): ExecutionLease | undefined {
    return this.store.getActiveLeaseForJob(jobId);
  }

  releaseLease(leaseId: string, now: number = Date.now()): void {
    const lease = this.store.getLease(leaseId);
    if (lease && lease.status === "ACTIVE") {
      lease.releasedAt = now;
      lease.status = "RELEASED";
      this.store.updateLease(lease);
      this.store.clearJobLeaseByLeaseId(leaseId);
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
