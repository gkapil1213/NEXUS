export type CloudProviderName = "aws" | "azure" | "gcp" | "kubernetes" | "terraform";

export interface CloudIdentity {
  provider: CloudProviderName;
  account_id?: string;
  arn?: string;
  user_id?: string;
  region?: string;
}

export interface CloudOperationResult<T = unknown> {
  status: "PASS" | "FAIL" | "BLOCKED";
  operation: string;
  provider: CloudProviderName;
  evidence?: T;
  reason?: string | null;
}

export interface TerraformPlanChange {
  resource: string;
  action: "CREATE" | "UPDATE" | "REPLACE" | "DELETE" | "NO_CHANGE";
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reason?: string;
}

export interface TerraformPlanSummary {
  status: "PASS" | "FAIL" | "BLOCKED";
  changes: TerraformPlanChange[];
  destructive_changes: TerraformPlanChange[];
  estimated_cost: null | string;
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  output?: string;
}

/* Phase 229: provider-neutral capability model. Each provider declares
 * exactly which production capabilities it supports. Missing capabilities
 * are returned as BLOCKED with UNSUPPORTED_CAPABILITY reason; they are
 * never silently faked. */
export interface ProviderCapabilities {
  compute: boolean;
  containerDeployment: boolean;
  registry: boolean;
  trafficRouting: boolean;
  healthChecks: boolean;
  rollback: boolean;
  loadBalancer: boolean;
  serviceDiscovery: boolean;
  observability: boolean;
  secrets: boolean;
}

export interface CapabilityReport {
  provider: CloudProviderName;
  capabilities: ProviderCapabilities;
  reason: string | null;
  probedAt: number;
}