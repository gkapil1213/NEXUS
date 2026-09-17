import { createHash } from "crypto";
import { ArtifactRecord } from "./execution-models";
import { ExecutionStore } from "./execution-store";

export class ArtifactStore {
  constructor(private store: ExecutionStore) {}

  /**
   * Phase 136: worker-authoritative registration is opt-in via `ownership`.
   * Callers that supply it get fenced persistence; a stale worker receives
   * `artifact_ownership_lost` and no row is written. Callers that omit it
   * (system/recovery paths) keep the previous unconditional behavior.
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

  verifyArtifact(artifactId: string, content: Buffer | string): boolean {
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) return false;
    const checksum = createHash("sha256").update(content).digest("hex");
    return artifact.checksum === checksum;
  }
}
