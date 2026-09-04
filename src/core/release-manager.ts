import { ExecutionStore } from "./execution-store";
import { ReleaseRecord, ReleaseStatus } from "./execution-models";

export class ReleaseManager {
  constructor(private store: ExecutionStore) {}

  createRelease(
    releaseId: string,
    version: string,
    artifactId?: string,
    buildInfo?: any
  ): ReleaseRecord {
    const now = Date.now();
    const release: ReleaseRecord = {
      releaseId,
      version,
      buildInfo,
      artifactId,
      status: "CREATED",
      createdAt: now,
      updatedAt: now,
    };
    this.store.addRelease(release);
    return release;
  }

  updateStatus(releaseId: string, status: ReleaseStatus): ReleaseRecord | undefined {
    const release = this.store.getRelease(releaseId);
    if (!release) return undefined;
    release.status = status;
    release.updatedAt = Date.now();
    this.store.updateRelease(release);
    return release;
  }

  getRelease(releaseId: string): ReleaseRecord | undefined {
    return this.store.getRelease(releaseId);
  }
}
