export interface ReleaseVersion {
  releaseId: string;
  version: string;
  prevVersion?: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createReleaseVersion(releaseId: string, version: string, prevVersion?: string): ReleaseVersion {
  return {
    releaseId,
    version,
    prevVersion,
    createdAt: new Date().toISOString(),
    idempotencyKey: `${releaseId}:${version}`,
  };
}
