import type { PlanInspectionResult } from "./infrastructure-plan";

export interface ApplyConditions {
  terraformAvailable: boolean;
  awsAvailable: boolean;
  planValid: boolean;
  planDigestMatches: boolean;
  securityPolicyPass: boolean;
  approvalExists: boolean;
  isDestructive: boolean;
  isProduction: boolean;
}

export class SafeApplyService {
  evaluate(conditions: ApplyConditions): { status: "PASS" | "BLOCKED" | "FAIL"; reason: string } {
    if (!conditions.terraformAvailable) return { status: "BLOCKED", reason: "Terraform not available" };
    if (!conditions.awsAvailable) return { status: "BLOCKED", reason: "AWS not available" };
    if (!conditions.planValid) return { status: "BLOCKED", reason: "Invalid Terraform plan" };
    if (!conditions.securityPolicyPass) return { status: "FAIL", reason: "Security policy violation" };
    if (!conditions.approvalExists) return { status: "BLOCKED", reason: "Missing human approval" };
    if (!conditions.planDigestMatches) return { status: "BLOCKED", reason: "Plan digest mismatch" };
    if (conditions.isDestructive && conditions.isProduction) {
      return { status: "BLOCKED", reason: "Destructive production changes require explicit approval" };
    }
    return { status: "PASS", reason: "Apply conditions satisfied" };
  }
}

export class CostSafetyService {
  estimate(_plan: PlanInspectionResult): "UNAVAILABLE" {
    return "UNAVAILABLE";
  }
}