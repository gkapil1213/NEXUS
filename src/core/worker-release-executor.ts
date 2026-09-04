export interface ReleaseExecutionAdapter {
  execute(releaseId: string, target: string): Promise<{ status: string; evidence?: any }>;
}

export class UnavailableReleaseAdapter implements ReleaseExecutionAdapter {
  async execute(_releaseId: string, _target: string): Promise<{ status: string; evidence?: any }> {
    return { status: "UNAVAILABLE", evidence: { reason: "adapter_not_configured" } };
  }
}

export class WorkerReleaseExecutor {
  constructor(private adapter: ReleaseExecutionAdapter) {}

  async execute(releaseId: string, target: string): Promise<{ status: string; result: string }> {
    const res = await this.adapter.execute(releaseId, target);
    if (res.status === "UNAVAILABLE") return { status: "UNAVAILABLE", result: "PLANNED_ONLY" };
    if (res.status === "SUCCESS") return { status: "SUCCEEDED", result: "EXECUTED" };
    return { status: res.status, result: "UNKNOWN" };
  }
}
