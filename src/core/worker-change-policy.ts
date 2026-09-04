export interface ChangePolicyRule {
  changeType: string;
  maxRisk: string;
  requireApproval: boolean;
}

export class WorkerChangePolicy {
  constructor(private rules: ChangePolicyRule[]) {}

  evaluate(changeType: string, riskLevel: string): "ALLOW" | "DENY" | "REQUIRE_APPROVAL" {
    const rule = this.rules.find(r => r.changeType === changeType);
    if (!rule) return "ALLOW";
    const riskOrder = ["LOW", "GUARDED", "HIGH", "CRITICAL"];
    if (riskOrder.indexOf(riskLevel) > riskOrder.indexOf(rule.maxRisk)) return "DENY";
    return rule.requireApproval ? "REQUIRE_APPROVAL" : "ALLOW";
  }
}
