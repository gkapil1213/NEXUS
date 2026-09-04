import { DomainRecommendation } from "./worker-decision-normalizer";

export type ConflictSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export class WorkerDecisionConflictDetector {
  detect(recs: DomainRecommendation[]): { actionA: string; actionB: string; conflictType: string; severity: ConflictSeverity }[] {
    const conflicts: { actionA: string; actionB: string; conflictType: string; severity: ConflictSeverity }[] = [];
    const normalized = recs.map(r => ({ ...r, action: r.action.toUpperCase() }));
    for (let i = 0; i < normalized.length; i++) {
      for (let j = i + 1; j < normalized.length; j++) {
        const a = normalized[i].action;
        const b = normalized[j].action;
        if (a === b) continue;
        const pair = [a, b].sort();
        if (
          (pair[0] === "SCALE_UP" && pair[1] === "SCALE_DOWN") ||
          (pair[0] === "RELEASE" && pair[1] === "ROLLBACK") ||
          (pair[0] === "OPTIMIZE_COST" && pair[1] === "PROTECT_RELIABILITY") ||
          (pair[0] === "RECOVER" && pair[1] === "RELEASE") ||
          (pair[0] === "CONTAIN" && pair[1] === "SCALE_OUT")
        ) {
          conflicts.push({ actionA: a, actionB: b, conflictType: "OPPOSING_ACTION", severity: "HIGH" });
        } else if (a === "SCALE_UP" && b === "SCALE_DOWN") {
          conflicts.push({ actionA: a, actionB: b, conflictType: "SCALE_CONFLICT", severity: "CRITICAL" });
        } else if (a === "CONTAIN" && b === "SCALE_OUT") {
          conflicts.push({ actionA: a, actionB: b, conflictType: "CONTAINMENT_CONFLICT", severity: "HIGH" });
        }
      }
    }
    return conflicts;
  }
}
