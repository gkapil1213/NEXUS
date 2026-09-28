import { createHash } from "crypto";
import { ArtifactRecord } from "./execution-models";
import { ExecutionStore } from "./execution-store";
import { PgClient } from "./pg-client";

export class ArtifactStore {
  constructor(private store: ExecutionStore, private dbUrl?: string) {}

  /**
   * Phase 136: worker-authoritative registration is opt-in via `ownership`.
   * Callers that supply it get fenced persistence; a stale worker receives
   * `artifact_ownership_lost` and no row is written. Callers that omit it
   * (system/recovery paths) keep the previous unconditional behavior.
   *
   * Sync path: writes to the SQLite execution store.
   */
  registerArtifact(
    artifact: Omit<ArtifactRecord, "checksum">,
    content: Buffer | string,
    ownership?: { leaseId: string; workerId: string }
  ): ArtifactRecord {
    const checksum = createHash("sha256").update(content).digest("hex");
    const full: ArtifactRecord = { ...artifact, checksum };
    if (ownership) {
      const res = this.store.addArtifactAsOwner(full, ownership.leaseId, ownership.workerId);
      if (!res.added) {
        throw new Error("artifact_ownership_lost:" + (res.reason ?? "unknown"));
      }
      return full;
    }
    this.store.addArtifact(full);
    return full;
  }

  /**
   * Phase 215: async sibling for shared (Postgres) mode. When dbUrl is wired,
   * persists directly to the Postgres execution_artifacts table with the
   * Phase 188 schema. Idempotent via ON CONFLICT (artifact_id) DO NOTHING.
   */
  async registerArtifactAsync(
    artifact: Omit<ArtifactRecord, "checksum">,
    content: Buffer | string,
  ): Promise<ArtifactRecord> {
    const checksum = createHash("sha256").update(content).digest("hex");
    const full: ArtifactRecord = { ...artifact, checksum };
    if (!this.dbUrl) {
      this.store.addArtifact(full);
      return full;
    }
    const pg = new PgClient();
    await pg.connect(this.dbUrl);
    try {
      await pg.query(
        "INSERT INTO execution_artifacts (" +
        "  artifact_id, job_id, release_id, attempt_id, name, type, size_bytes, checksum," +
        "  storage_ref, metadata, integrity_verified_at, integrity_status, immutable, created_at" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) " +
        "ON CONFLICT (artifact_id) DO NOTHING",
        [
          full.artifactId, full.jobId ?? null, full.releaseId ?? null, full.attemptId ?? null,
          full.name, full.type, full.sizeBytes ?? null, full.checksum,
          full.storageRef ?? null, full.metadata ? JSON.stringify(full.metadata) : null,
          null, "PENDING", 0, full.createdAt,
        ],
      );
    } finally {
      await pg.close();
    }
    return full;
  }

  verifyArtifact(artifactId: string, content: Buffer | string): boolean {
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) return false;
    const checksum = createHash("sha256").update(content).digest("hex");
    return artifact.checksum === checksum;
  }
}
