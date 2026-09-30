// src/core/engineering-release-ready-executor.ts
// Phase 224: real engineering RELEASE_READY stage executor.
//
// Read-only release-readiness decision derived from persisted engineering state:
//   - all prior stages (PLANNING..SECURITY_REVIEW) must be SUCCEEDED
//   - a candidate artifact must exist (from a stage artifact_ref)
//   - the run must have a source_revision bound
//   - the artifact must exist with a non-empty checksum
//
// Never deploys. Never publishes. Persists a durable release-readiness artifact
// and events, then returns SUCCEEDED / FAILED / BLOCKED honestly.

import { PgClient } from "./pg-client";
import type { ExecutionStore } from "./execution-store";
import type { ArtifactStore } from "./artifact-store";
import type { WorkspaceActor } from "./workspace";

export type EngineeringReleaseReadyStatus = "SUCCEEDED" | "FAILED" | "BLOCKED";

export interface StageCheck {
  stageType: string;
  status: string;
  ok: boolean;
}

export interface EngineeringReleaseReadyOutcome {
  status: EngineeringReleaseReadyStatus;
  reason: string;
  releaseId: string;
  stageChecks: StageCheck[];
  candidateArtifactRef: string | null;
  candidateArtifactId: string | null;
  sourceRevision: string | null;
  artifactRef: string | null;
}

export interface EngineeringReleaseReadyExecutorDeps {
  dbUrl: string;
  store: ExecutionStore;
  artifacts: ArtifactStore;
}

export interface RunReleaseReadyInput {
  runId: string;
  actor: WorkspaceActor;
}

const REQUIRED_PRIOR_STAGES = [
  "PLANNING","ARCHITECTURE","IMPLEMENTATION","BUILD","TEST","DIAGNOSIS","REPAIR","SECURITY_REVIEW",
] as const;

function genEventId(): string {
  return "eevt-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function sanitize(s: string): string {
  if (!s) return "";
  return s
    .replace(/postgres:\/\/[^@\s]+@/gi, "postgres://<redacted>@")
    .replace(/(sk-|pk-|Bearer\s+)[A-Za-z0-9._-]{16,}/g, "$1<redacted>")
    .slice(0, 4096);
}

export class EngineeringReleaseReadyExecutor {
  constructor(private readonly deps: EngineeringReleaseReadyExecutorDeps) {}

  private async withPg<T>(fn: (pg: PgClient) => Promise<T>): Promise<T> {
    const pg = new PgClient();
    await pg.connect(this.deps.dbUrl);
    try { return await fn(pg); } finally { await pg.close(); }
  }

  private async appendEvent(
    runId: string,
    stageId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const pg = new PgClient();
    await pg.connect(this.deps.dbUrl);
    try {
      await pg.query(
        "INSERT INTO engineering_run_events (event_id, run_id, stage_id, event_type, payload, created_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6)",
        [genEventId(), runId, stageId, eventType, JSON.stringify(payload), Date.now()],
      );
    } finally { await pg.close(); }
  }

  private async getRun(runId: string): Promise<{ sourceRevision: string | null; repository: string | null } | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT source_revision, repository FROM engineering_runs WHERE id=$1", [runId]);
      if (r.rowCount === 0) return null;
      return {
        sourceRevision: r.rows[0].source_revision ?? null,
        repository: r.rows[0].repository ?? null,
      };
    });
  }

  private async getHighestOrdinalArtifactRef(runId: string): Promise<string | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT artifact_ref FROM engineering_run_stages " +
        "WHERE run_id=$1 AND artifact_ref IS NOT NULL " +
        "ORDER BY ordinal DESC LIMIT 1", [runId]);
      if (r.rowCount === 0) return null;
      return r.rows[0].artifact_ref ?? null;
    });
  }

  private async fetchArtifact(artifactId: string): Promise<{ artifactId: string; checksum: string; jobId: string | null } | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT artifact_id, checksum, job_id FROM execution_artifacts WHERE artifact_id=$1", [artifactId]);
      if (r.rowCount === 0) return null;
      return { artifactId: r.rows[0].artifact_id, checksum: r.rows[0].checksum ?? "", jobId: r.rows[0].job_id ?? null };
    });
  }

  async runReleaseReady(input: RunReleaseReadyInput): Promise<EngineeringReleaseReadyOutcome> {
    const { runId } = input;
    const stageId = runId + "__RELEASE_READY";
    const releaseId = "relready-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

    await this.appendEvent(runId, stageId, "engineering_release_ready.started", { runId, releaseId });

    const empty = (status: EngineeringReleaseReadyStatus, reason: string, checks: StageCheck[], candRef: string | null, candId: string | null, rev: string | null, artRef: string | null): EngineeringReleaseReadyOutcome => ({
      status, reason, releaseId, stageChecks: checks,
      candidateArtifactRef: candRef, candidateArtifactId: candId,
      sourceRevision: rev, artifactRef: artRef,
    });

    // 1. Verify all prior stages are SUCCEEDED
    const stageChecks: StageCheck[] = [];
    for (const st of REQUIRED_PRIOR_STAGES) {
      const j = await this.deps.store.getJobAsync(runId + "__" + st);
      const status = j?.status ?? "MISSING";
      const ok = status === "SUCCEEDED";
      stageChecks.push({ stageType: st, status, ok });
    }
    const failed = stageChecks.filter((c) => !c.ok);
    if (failed.length > 0) {
      const reason = "PREREQUISITE_NOT_SUCCEEDED:" + failed.map((f) => f.stageType + "=" + f.status).join(",");
      await this.appendEvent(runId, stageId, "engineering_release_ready.blocked", { reason, stageChecks });
      return empty("BLOCKED", reason, stageChecks, null, null, null, null);
    }

    // 2. Resolve source revision from the run
    const run = await this.getRun(runId);
    if (!run) {
      const reason = "RUN_NOT_FOUND";
      await this.appendEvent(runId, stageId, "engineering_release_ready.failed", { reason });
      return empty("FAILED", reason, stageChecks, null, null, null, null);
    }
    if (!run.sourceRevision) {
      const reason = "SOURCE_REVISION_MISSING";
      await this.appendEvent(runId, stageId, "engineering_release_ready.blocked", { reason, stageChecks });
      return empty("BLOCKED", reason, stageChecks, null, null, null, null);
    }


    // 3. Resolve candidate artifact
    const candidateRef = await this.getHighestOrdinalArtifactRef(runId);
    if (!candidateRef) {
      const reason = "NO_CANDIDATE_ARTIFACT";
      await this.appendEvent(runId, stageId, "engineering_release_ready.blocked", { reason, stageChecks });
      return empty("BLOCKED", reason, stageChecks, null, null, null, null);
    }
    const candidateId = candidateRef.startsWith("artifact://") ? candidateRef.slice("artifact://".length) : candidateRef;


    // 4. Verify artifact exists with non-empty checksum
    const art = await this.fetchArtifact(candidateId);
    if (!art) {
      const reason = "CANDIDATE_ARTIFACT_NOT_FOUND:" + candidateId;
      await this.appendEvent(runId, stageId, "engineering_release_ready.blocked", { reason, candidateId });
      return empty("BLOCKED", reason, stageChecks, candidateRef, candidateId, run.sourceRevision, null);
    }
    if (!art.checksum || art.checksum.length === 0) {
      const reason = "ARTIFACT_CHECKSUM_MISSING";
      await this.appendEvent(runId, stageId, "engineering_release_ready.blocked", { reason, candidateId });
      return empty("BLOCKED", reason, stageChecks, candidateRef, candidateId, run.sourceRevision, null);
    }

    // 5. Persist the release-readiness artifact
    const artifactContent = JSON.stringify({
      schemaVersion: 1,
      releaseId,
      runId,
      repository: run.repository,
      sourceRevision: run.sourceRevision,
      candidateArtifactRef: candidateRef,
      candidateArtifactId: candidateId,
      candidateArtifactChecksum: art.checksum,
      stageChecks,
      status: "SUCCEEDED",
      reason: "RELEASE_READY",
      capturedAt: new Date().toISOString(),
    }, null, 2);

    let rrArtifactRef: string | null = null;
    try {
      const record = await this.deps.artifacts.registerArtifactAsync(
        {
          artifactId: "art-relready-" + releaseId,
          jobId: runId,
          name: "release-ready-" + releaseId + ".json",
          type: "ENGINEERING_RELEASE_READY",
          metadata: { releaseId, runId, sourceRevision: run.sourceRevision, candidateArtifactId: candidateId },
          createdAt: Date.now(),
        } as any,
        artifactContent,
      );
      rrArtifactRef = "artifact://" + record.artifactId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.appendEvent(runId, stageId, "engineering_release_ready.failed", { reason: "ARTIFACT_REGISTRATION_FAILED", detail: sanitize(msg) });
      return empty("FAILED", "ARTIFACT_REGISTRATION_FAILED", stageChecks, candidateRef, candidateId, run.sourceRevision, null);
    }

    await this.appendEvent(runId, stageId, "engineering_release_ready.completed", {
      releaseId, status: "SUCCEEDED", artifactRef: rrArtifactRef, sourceRevision: run.sourceRevision,
    });

    return empty("SUCCEEDED", "RELEASE_READY", stageChecks, candidateRef, candidateId, run.sourceRevision, rrArtifactRef);
  }
}
