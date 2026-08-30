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
      const action = rc.change?.actions?.[0] ?? "NO_CHANGE";
      const resource = rc.address ?? "unknown";
      changes.push({
        resource,
        action: action as PlanAction,
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
  if (changes.some(c => (c.action === "DELETE" || c.action === "REPLACE") && c.resource.includes("aws_vpc"))) return "CRITICAL";
  if (changes.some(c => c.action === "DELETE" || c.action === "REPLACE")) return "HIGH";
  if (changes.some(c => c.action === "CREATE")) return "MEDIUM";
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