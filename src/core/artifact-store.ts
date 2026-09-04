import { createHash } from "crypto";
import { ArtifactRecord } from "./execution-models";
import { ExecutionStore } from "./execution-store";

export class ArtifactStore {
  constructor(private store: ExecutionStore) {}

  registerArtifact(
    artifact: Omit<ArtifactRecord, "checksum">,
    content: Buffer | string
  ): ArtifactRecord {
    const checksum = createHash("sha256").update(content).digest("hex");
    const full: ArtifactRecord = { ...artifact, checksum };
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
