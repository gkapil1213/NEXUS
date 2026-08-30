export interface InfrastructurePolicyInput {
  environment: string;
  actions: string[];
  resourceTypes?: string[];
  planDigest?: string;
  approvedDigest?: string;
  region?: string;
  provider?: string;
  changes?: {
    create: number;
    update: number;
    replace: number;
    destroy: number;
  };
}

export interface InfrastructurePolicyVerdict {
  rule: string;
  passed: boolean;
  reason: string;
}

export class InfrastructurePolicyEngine {
  private rules = [
    {
      id: "NO_DESTROY_WITHOUT_APPROVAL",
      evaluate: (input: InfrastructurePolicyInput) => {
        const destructive = (input.changes?.destroy ?? 0) > 0 || (input.changes?.replace ?? 0) > 0;
        if (input.environment === "production" && destructive && !input.approvedDigest) {
          return { rule: "NO_DESTROY_WITHOUT_APPROVAL", passed: false, reason: "Destructive changes require human approval" };
        }
        return { rule: "NO_DESTROY_WITHOUT_APPROVAL", passed: true, reason: "" };
      },
    },
    {
      id: "REQUIRE_EXPLICIT_REGION",
      evaluate: (input: InfrastructurePolicyInput) => {
        if (input.environment === "production" && !input.region) {
          return { rule: "REQUIRE_EXPLICIT_REGION", passed: false, reason: "Production region not specified" };
        }
        return { rule: "REQUIRE_EXPLICIT_REGION", passed: true, reason: "" };
      },
    },
    {
      id: "PLAN_DIGEST_UNCHANGED",
      evaluate: (input: InfrastructurePolicyInput) => {
        if (input.approvedDigest && input.planDigest && input.approvedDigest !== input.planDigest) {
          return { rule: "PLAN_DIGEST_UNCHANGED", passed: false, reason: "Plan digest changed after approval" };
        }
        return { rule: "PLAN_DIGEST_UNCHANGED", passed: true, reason: "" };
      },
    },
    {
      id: "NO_PUBLIC_DATABASE",
      evaluate: (input: InfrastructurePolicyInput) => {
        if (input.resourceTypes?.some(r => r.toLowerCase().includes("public") && r.toLowerCase().includes("db"))) {
          return { rule: "NO_PUBLIC_DATABASE", passed: false, reason: "Public database resource detected" };
        }
        return { rule: "NO_PUBLIC_DATABASE", passed: true, reason: "" };
      },
    },
    {
      id: "NO_PUBLIC_STORAGE",
      evaluate: (input: InfrastructurePolicyInput) => {
        if (input.resourceTypes?.some(r => r.toLowerCase().includes("public") && (r.toLowerCase().includes("s3") || r.toLowerCase().includes("storage")))) {
          return { rule: "NO_PUBLIC_STORAGE", passed: false, reason: "Public storage resource detected" };
        }
        return { rule: "NO_PUBLIC_STORAGE", passed: true, reason: "" };
      },
    },
    {
      id: "NO_UNRESTRICTED_SECURITY_GROUP",
      evaluate: (input: InfrastructurePolicyInput) => {
        if (input.resourceTypes?.some(r => r.toLowerCase().includes("security_group") && r.toLowerCase().includes("0.0.0.0/0"))) {
          return { rule: "NO_UNRESTRICTED_SECURITY_GROUP", passed: false, reason: "Unrestricted security group rule detected" };
        }
        return { rule: "NO_UNRESTRICTED_SECURITY_GROUP", passed: true, reason: "" };
      },
    },
  ];

  evaluate(input: InfrastructurePolicyInput): InfrastructurePolicyVerdict[] {
    return this.rules.map(rule => {
      const verdict = rule.evaluate(input);
      return { rule: rule.id, passed: verdict.passed, reason: verdict.reason };
    });
  }
}