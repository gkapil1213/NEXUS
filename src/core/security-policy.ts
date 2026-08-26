import { nid } from "./db";

export type PolicyDecision = "ALLOW" | "BLOCK" | "REVIEW";
export type PolicySeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface SecurityPolicyRule {
  id: string;
  name: string;
  description: string;
  condition: (context: PolicyContext) => boolean;
  decision: PolicyDecision;
  severity?: PolicySeverity;
}

export interface PolicyContext {
  findings: {
    severity: string;
    category: string;
    scanner: string;
    title: string;
  }[];
  artifact?: {
    signed: boolean;
    verified: boolean;
    digest: string | null;
  };
  sbom?: {
    valid: boolean;
    digest: string | null;
  };
  dast?: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  secrets?: number;
  iac?: number;
}

export interface PolicyEvaluation {
  id: string;
  rule_id: string;
  rule_name: string;
  decision: PolicyDecision;
  reason: string;
  timestamp: number;
}

export class SecurityPolicyEngine {
  private rules: SecurityPolicyRule[] = [];

  constructor() {
    // Default rules
    this.rules = [
      {
        id: "CRITICAL_VULN_BLOCK",
        name: "Critical vulnerability blocks",
        description: "Any critical finding blocks the release",
        condition: (ctx) => ctx.findings.some((f) => f.severity === "critical"),
        decision: "BLOCK",
      },
      {
        id: "HIGH_VULN_BLOCK",
        name: "High vulnerability blocks",
        description: "Any high finding blocks the release",
        condition: (ctx) => ctx.findings.some((f) => f.severity === "high"),
        decision: "BLOCK",
      },
      {
        id: "SECRET_BLOCK",
        name: "Secret detected blocks",
        description: "Any secret finding blocks the release",
        condition: (ctx) => ctx.findings.some((f) => f.category === "SECRET"),
        decision: "BLOCK",
      },
      {
        id: "IAC_BLOCK",
        name: "IaC finding blocks",
        description: "Any IaC finding blocks the release",
        condition: (ctx) => ctx.findings.some((f) => f.category === "IAC"),
        decision: "BLOCK",
      },
      {
        id: "UNSIGNED_ARTIFACT_BLOCK",
        name: "Unsigned artifact blocks production",
        description: "Production requires a signed artifact",
        condition: (ctx) => ctx.artifact !== undefined && ctx.artifact.signed === false,
        decision: "BLOCK",
      },
      {
        id: "INVALID_SBOM_BLOCK",
        name: "Invalid SBOM blocks",
        description: "Invalid or missing SBOM blocks the release",
        condition: (ctx) => ctx.sbom !== undefined && ctx.sbom.valid === false,
        decision: "BLOCK",
      },
      {
        id: "DAST_CRITICAL_BLOCK",
        name: "DAST critical finding blocks",
        description: "Critical DAST finding blocks the release",
        condition: (ctx) => ctx.dast !== undefined && ctx.dast.critical > 0,
        decision: "BLOCK",
      },
    ];
  }

  evaluate(context: PolicyContext): PolicyEvaluation[] {
    const evaluations: PolicyEvaluation[] = [];
    for (const rule of this.rules) {
      if (rule.condition(context)) {
        evaluations.push({
          id: nid("pol"),
          rule_id: rule.id,
          rule_name: rule.name,
          decision: rule.decision,
          reason: rule.description,
          timestamp: Date.now(),
        });
      }
    }
    return evaluations;
  }

  verdict(evaluations: PolicyEvaluation[]): "PASS" | "FAIL" | "BLOCKED" {
    if (evaluations.some((e) => e.decision === "BLOCK")) return "FAIL";
    return "PASS";
  }
}