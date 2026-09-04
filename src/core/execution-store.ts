import Database from "better-sqlite3";
import {
  ExecutionJob,
  ExecutionAttempt,
  ExecutionWorker,
  ExecutionLease,
  ArtifactRecord,
  ReleaseRecord,
  DeploymentRecord,
  ApprovalRequest,
  ExecutionEvent,
} from "./execution-models";

export class ExecutionStore {
  constructor(private db: Database.Database) {}

  // ---------- Jobs ----------
  createJob(job: ExecutionJob): void {
    this.db.prepare(`
      INSERT INTO execution_jobs (
        id, idempotency_key, job_type, payload, status, retry_policy,
        timeout_ms, created_at, updated_at, last_attempt_at, next_attempt_at,
        current_lease_id, cancellation_requested, cancellation_acknowledged
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      job.idempotencyKey,
      job.jobType,
      job.payload ? JSON.stringify(job.payload) : null,
      job.status,
      job.retryPolicy ? JSON.stringify(job.retryPolicy) : null,
      job.timeoutMs,
      job.createdAt,
      job.updatedAt,
      job.lastAttemptAt,
      job.nextAttemptAt,
      job.currentLeaseId,
      job.cancellationRequested ? 1 : 0,
      job.cancellationAcknowledged ? 1 : 0
    );
  }

  getJob(id: string): ExecutionJob | undefined {
    const row = this.db.prepare("SELECT * FROM execution_jobs WHERE id = ?").get(id);
    return row ? this.mapJob(row) : undefined;
  }

  getJobByIdempotencyKey(key: string): ExecutionJob | undefined {
    const row = this.db.prepare("SELECT * FROM execution_jobs WHERE idempotency_key = ?").get(key);
    return row ? this.mapJob(row) : undefined;
  }

  updateJob(job: ExecutionJob): void {
    this.db.prepare(`
      UPDATE execution_jobs SET
        payload = ?, status = ?, retry_policy = ?, timeout_ms = ?,
        updated_at = ?, last_attempt_at = ?, next_attempt_at = ?,
        current_lease_id = ?, cancellation_requested = ?, cancellation_acknowledged = ?
      WHERE id = ?
    `).run(
      job.payload ? JSON.stringify(job.payload) : null,
      job.status,
      job.retryPolicy ? JSON.stringify(job.retryPolicy) : null,
      job.timeoutMs,
      job.updatedAt,
      job.lastAttemptAt,
      job.nextAttemptAt,
      job.currentLeaseId,
      job.cancellationRequested ? 1 : 0,
      job.cancellationAcknowledged ? 1 : 0,
      job.id
    );
  }

  listJobsByStatus(status: string): ExecutionJob[] {
    return this.db.prepare("SELECT * FROM execution_jobs WHERE status = ?").all(status).map(this.mapJob);
  }

  listJobsDueForRetry(now: number): ExecutionJob[] {
    return this.db.prepare(
      "SELECT * FROM execution_jobs WHERE status = 'RETRY_SCHEDULED' AND next_attempt_at <= ?"
    ).all(now).map(this.mapJob);
  }

  // ---------- Attempts ----------
  createAttempt(attempt: ExecutionAttempt): void {
    this.db.prepare(`
      INSERT INTO execution_attempts (
        id, job_id, attempt_number, status, worker_id, lease_id,
        started_at, completed_at, error, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.id,
      attempt.jobId,
      attempt.attemptNumber,
      attempt.status,
      attempt.workerId,
      attempt.leaseId,
      attempt.startedAt,
      attempt.completedAt,
      attempt.error,
      attempt.evidence ? JSON.stringify(attempt.evidence) : null,
      attempt.createdAt
    );
  }

  updateAttempt(attempt: ExecutionAttempt): void {
    this.db.prepare(`
      UPDATE execution_attempts SET
        status = ?, worker_id = ?, lease_id = ?, started_at = ?,
        completed_at = ?, error = ?, evidence = ?
      WHERE id = ?
    `).run(
      attempt.status,
      attempt.workerId,
      attempt.leaseId,
      attempt.startedAt,
      attempt.completedAt,
      attempt.error,
      attempt.evidence ? JSON.stringify(attempt.evidence) : null,
      attempt.id
    );
  }

  getAttempt(id: string): ExecutionAttempt | undefined {
    const row = this.db.prepare("SELECT * FROM execution_attempts WHERE id = ?").get(id);
    return row ? this.mapAttempt(row) : undefined;
  }

  listAttemptsForJob(jobId: string): ExecutionAttempt[] {
    return this.db.prepare(
      "SELECT * FROM execution_attempts WHERE job_id = ? ORDER BY attempt_number"
    ).all(jobId).map(this.mapAttempt);
  }

  // ---------- Workers ----------
  registerWorker(worker: ExecutionWorker): void {
    this.db.prepare(`
      INSERT INTO execution_workers (
        worker_id, hostname, capabilities, status, last_heartbeat_at,
        current_job_id, registered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      worker.workerId,
      worker.hostname,
      worker.capabilities ? JSON.stringify(worker.capabilities) : null,
      worker.status,
      worker.lastHeartbeatAt,
      worker.currentJobId,
      worker.registeredAt
    );
  }

  updateWorker(worker: ExecutionWorker): void {
    this.db.prepare(`
      UPDATE execution_workers SET
        hostname = ?, capabilities = ?, status = ?,
        last_heartbeat_at = ?, current_job_id = ?
      WHERE worker_id = ?
    `).run(
      worker.hostname,
      worker.capabilities ? JSON.stringify(worker.capabilities) : null,
      worker.status,
      worker.lastHeartbeatAt,
      worker.currentJobId,
      worker.workerId
    );
  }

  getWorker(workerId: string): ExecutionWorker | undefined {
    const row = this.db.prepare("SELECT * FROM execution_workers WHERE worker_id = ?").get(workerId);
    return row ? this.mapWorker(row) : undefined;
  }

  listWorkers(): ExecutionWorker[] {
    return this.db.prepare("SELECT * FROM execution_workers").all().map(this.mapWorker);
  }

  listWorkersByStatus(status: string): ExecutionWorker[] {
    return this.db.prepare("SELECT * FROM execution_workers WHERE status = ?").all(status).map(this.mapWorker);
  }

  // ---------- Leases ----------
  acquireLease(lease: ExecutionLease): void {
    this.db.prepare(`
      INSERT INTO execution_leases (
        lease_id, job_id, worker_id, acquired_at, expires_at,
        renewed_at, released_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      lease.leaseId,
      lease.jobId,
      lease.workerId,
      lease.acquiredAt,
      lease.expiresAt,
      lease.renewedAt,
      lease.releasedAt,
      lease.status
    );
  }

  updateLease(lease: ExecutionLease): void {
    this.db.prepare(`
      UPDATE execution_leases SET
        renewed_at = ?, released_at = ?, status = ?, expires_at = ?
      WHERE lease_id = ?
    `).run(
      lease.renewedAt ?? null,
      lease.releasedAt ?? null,
      lease.status,
      lease.expiresAt,
      lease.leaseId
    );
  }

  getLease(leaseId: string): ExecutionLease | undefined {
    const row = this.db.prepare("SELECT * FROM execution_leases WHERE lease_id = ?").get(leaseId);
    return row ? this.mapLease(row) : undefined;
  }

  getActiveLeaseForJob(jobId: string): ExecutionLease | undefined {
    const row = this.db.prepare(
      "SELECT * FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'"
    ).get(jobId);
    return row ? this.mapLease(row) : undefined;
  }

  listExpiredLeases(now: number): ExecutionLease[] {
    return this.db.prepare(
      "SELECT * FROM execution_leases WHERE status = 'ACTIVE' AND expires_at <= ?"
    ).all(now).map(this.mapLease);
  }

  // ---------- Artifacts ----------
  addArtifact(artifact: ArtifactRecord): void {
    this.db.prepare(`
      INSERT INTO execution_artifacts (
        artifact_id, job_id, release_id, name, type, size_bytes,
        checksum, storage_ref, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.artifactId,
      artifact.jobId,
      artifact.releaseId,
      artifact.name,
      artifact.type,
      artifact.sizeBytes,
      artifact.checksum,
      artifact.storageRef,
      artifact.metadata ? JSON.stringify(artifact.metadata) : null,
      artifact.createdAt
    );
  }

  getArtifact(artifactId: string): ArtifactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM execution_artifacts WHERE artifact_id = ?").get(artifactId);
    return row ? this.mapArtifact(row) : undefined;
  }

  // ---------- Releases ----------
  addRelease(release: ReleaseRecord): void {
    this.db.prepare(`
      INSERT INTO execution_releases (
        release_id, version, build_info, artifact_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      release.releaseId,
      release.version,
      release.buildInfo ? JSON.stringify(release.buildInfo) : null,
      release.artifactId,
      release.status,
      release.createdAt,
      release.updatedAt
    );
  }

  updateRelease(release: ReleaseRecord): void {
    this.db.prepare(`
      UPDATE execution_releases SET
        build_info = ?, artifact_id = ?, status = ?, updated_at = ?
      WHERE release_id = ?
    `).run(
      release.buildInfo ? JSON.stringify(release.buildInfo) : null,
      release.artifactId,
      release.status,
      release.updatedAt,
      release.releaseId
    );
  }

  getRelease(releaseId: string): ReleaseRecord | undefined {
    const row = this.db.prepare("SELECT * FROM execution_releases WHERE release_id = ?").get(releaseId);
    return row ? this.mapRelease(row) : undefined;
  }

  // ---------- Deployments ----------
  addDeployment(deployment: DeploymentRecord): void {
    this.db.prepare(`
      INSERT INTO execution_deployments (
        deployment_id, release_id, environment, status, created_at,
        updated_at, rollback_deployment_id, evidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deployment.deploymentId,
      deployment.releaseId,
      deployment.environment,
      deployment.status,
      deployment.createdAt,
      deployment.updatedAt,
      deployment.rollbackDeploymentId,
      deployment.evidence ? JSON.stringify(deployment.evidence) : null
    );
  }

  updateDeployment(deployment: DeploymentRecord): void {
    this.db.prepare(`
      UPDATE execution_deployments SET
        status = ?, updated_at = ?, rollback_deployment_id = ?, evidence = ?
      WHERE deployment_id = ?
    `).run(
      deployment.status,
      deployment.updatedAt,
      deployment.rollbackDeploymentId,
      deployment.evidence ? JSON.stringify(deployment.evidence) : null,
      deployment.deploymentId
    );
  }

  getDeployment(deploymentId: string): DeploymentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM execution_deployments WHERE deployment_id = ?").get(deploymentId);
    return row ? this.mapDeployment(row) : undefined;
  }

  // ---------- Approvals ----------
  addApproval(approval: ApprovalRequest): void {
    this.db.prepare(`
      INSERT INTO execution_approvals (
        approval_id, deployment_id, release_id, environment, requested_action,
        decision, decided_at, decided_by, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      approval.approvalId,
      approval.deploymentId,
      approval.releaseId,
      approval.environment,
      approval.requestedAction,
      approval.decision,
      approval.decidedAt,
      approval.decidedBy,
      approval.reason,
      approval.createdAt
    );
  }

  updateApproval(approval: ApprovalRequest): void {
    this.db.prepare(`
      UPDATE execution_approvals SET
        decision = ?, decided_at = ?, decided_by = ?, reason = ?
      WHERE approval_id = ?
    `).run(
      approval.decision,
      approval.decidedAt,
      approval.decidedBy,
      approval.reason,
      approval.approvalId
    );
  }

  getApproval(approvalId: string): ApprovalRequest | undefined {
    const row = this.db.prepare("SELECT * FROM execution_approvals WHERE approval_id = ?").get(approvalId);
    return row ? this.mapApproval(row) : undefined;
  }

  // ---------- Events ----------
  addEvent(event: ExecutionEvent): void {
    this.db.prepare(`
      INSERT INTO execution_events (event_id, job_id, deployment_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.jobId,
      event.deploymentId,
      event.eventType,
      event.payload ? JSON.stringify(event.payload) : null,
      event.createdAt
    );
  }

  // ---------- Mapping Helpers ----------
  private mapJob(row: any): ExecutionJob {
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      jobType: row.job_type,
      payload: row.payload ? JSON.parse(row.payload) : undefined,
      status: row.status,
      retryPolicy: row.retry_policy ? JSON.parse(row.retry_policy) : undefined,
      timeoutMs: row.timeout_ms,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAttemptAt: row.last_attempt_at,
      nextAttemptAt: row.next_attempt_at,
      currentLeaseId: row.current_lease_id,
      cancellationRequested: !!row.cancellation_requested,
      cancellationAcknowledged: !!row.cancellation_acknowledged,
    };
  }

  private mapAttempt(row: any): ExecutionAttempt {
    return {
      id: row.id,
      jobId: row.job_id,
      attemptNumber: row.attempt_number,
      status: row.status,
      workerId: row.worker_id,
      leaseId: row.lease_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
      evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
      createdAt: row.created_at,
    };
  }

  private mapWorker(row: any): ExecutionWorker {
    return {
      workerId: row.worker_id,
      hostname: row.hostname,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : undefined,
      status: row.status,
      lastHeartbeatAt: row.last_heartbeat_at,
      currentJobId: row.current_job_id,
      registeredAt: row.registered_at,
    };
  }

  private mapLease(row: any): ExecutionLease {
    return {
      leaseId: row.lease_id,
      jobId: row.job_id,
      workerId: row.worker_id,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      renewedAt: row.renewed_at,
      releasedAt: row.released_at,
      status: row.status,
    };
  }

  private mapArtifact(row: any): ArtifactRecord {
    return {
      artifactId: row.artifact_id,
      jobId: row.job_id,
      releaseId: row.release_id,
      name: row.name,
      type: row.type,
      sizeBytes: row.size_bytes,
      checksum: row.checksum,
      storageRef: row.storage_ref,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
    };
  }

  private mapRelease(row: any): ReleaseRecord {
    return {
      releaseId: row.release_id,
      version: row.version,
      buildInfo: row.build_info ? JSON.parse(row.build_info) : undefined,
      artifactId: row.artifact_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapDeployment(row: any): DeploymentRecord {
    return {
      deploymentId: row.deployment_id,
      releaseId: row.release_id,
      environment: row.environment,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      rollbackDeploymentId: row.rollback_deployment_id,
      evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
    };
  }

  private mapApproval(row: any): ApprovalRequest {
    return {
      approvalId: row.approval_id,
      deploymentId: row.deployment_id,
      releaseId: row.release_id,
      environment: row.environment,
      requestedAction: row.requested_action,
      decision: row.decision,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      reason: row.reason,
      createdAt: row.created_at,
    };
  }
}
