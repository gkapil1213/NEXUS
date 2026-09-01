import { createHash } from "node:crypto";

export type PlanAction = "CREATE" | "UPDATE" | "DELETE" | "REPLACE" | "NO_CHANGE";

export interface PlanChange {
  resource: string;
  action: PlanAction;
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reason?: string;
}

export interface PlanInspectionResult {
  changes: PlanChange[];
  destructive_changes: PlanChange[];
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export function parsePlanChanges(planJson: string): PlanChange[] {
  try {
    const plan = JSON.parse(planJson);
    const resourceChanges = plan.resource_changes ?? [];
    const changes: PlanChange[] = [];
    for (const rc of resourceChanges) {
      const actions = rc.change?.actions ?? [];
      let action: PlanAction = "NO_CHANGE";
      if (actions.includes("delete") && actions.includes("create")) {
        action = "REPLACE";
      } else if (actions.includes("delete")) {
        action = "DELETE";
      } else if (actions.includes("update")) {
        action = "UPDATE";
      } else if (actions.includes("create")) {
        action = "CREATE";
      } else if (actions.includes("read")) {
        action = "NO_CHANGE";
      }
      changes.push({
        resource: rc.address ?? "unknown",
        action,
        risk: "LOW",
        reason: rc.change?.reason ?? null,
      });
    }
    return changes;
  } catch {
    return [];
  }
}

export function classifyRisk(changes: PlanChange[]): PlanInspectionResult["risk"] {
  // Critical resources
  const criticalResourcePatterns = [
    "aws_vpc", "aws_subnet", "aws_route_table", "aws_iam", "aws_security_group", "aws_db_"
  ];

  const isCriticalResource = (resource: string) =>
    criticalResourcePatterns.some(pattern => resource.includes(pattern));

  if (
    changes.some(
      c => (c.action === "DELETE" || c.action === "REPLACE") && isCriticalResource(c.resource)
    )
  ) {
    return "CRITICAL";
  }

  if (changes.some(c => c.action === "DELETE" || c.action === "REPLACE")) {
    return "HIGH";
  }

  if (changes.some(c => c.action === "CREATE" || c.action === "UPDATE")) {
    return "MEDIUM";
  }

  return "LOW";
}

export function inspectPlan(planJson: string): PlanInspectionResult {
  const changes = parsePlanChanges(planJson);
  const destructive_changes = changes.filter(c => c.action === "DELETE" || c.action === "REPLACE");
  const risk = classifyRisk(changes);
  return { changes, destructive_changes, risk };
}

export function computePlanDigest(planJson: string): string {
  return `sha256:${createHash("sha256").update(planJson).digest("hex")}`;
}
