export type ChangeType =
  | "APPLICATION_RELEASE"
  | "CONFIG_CHANGE"
  | "INFRASTRUCTURE_CHANGE"
  | "SCHEMA_MIGRATION"
  | "DEPENDENCY_UPDATE"
  | "FEATURE_FLAG_CHANGE"
  | "WORKER_ROLLOUT"
  | "POLICY_CHANGE"
  | "SECURITY_CONFIG_CHANGE"
  | "SCALING_CHANGE";

export interface ChangeInput {
  changeId: string;
  changeType: ChangeType;
  service?: string;
  target?: string;
  environment?: string;
  failureDomain?: string;
  dependencyDepth?: number;
  magnitude?: number;
  confidence?: number;
}

export class WorkerChangeIntelligence {
  normalize(input: ChangeInput): Record<string, string | number> {
    return {
      change_id: input.changeId,
      change_type: input.changeType,
      service: input.service ?? "unknown",
      target: input.target ?? "unknown",
      environment: input.environment ?? "unknown",
      failure_domain: input.failureDomain ?? "unknown",
      dependency_depth: input.dependencyDepth ?? 0,
      magnitude: input.magnitude ?? 0,
      confidence: input.confidence ?? 0,
    };
  }
}
