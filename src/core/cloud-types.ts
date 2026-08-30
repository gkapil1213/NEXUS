export type CloudProviderName = "aws" | "azure" | "gcp" | "kubernetes";

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
  action: "CREATE" | "UPDATE" | "REPLACE" | "DESTROY" | "NO_CHANGE";
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