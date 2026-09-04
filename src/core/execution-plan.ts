export interface ExecutionPlanStep {
  id: string;
  adapterId: string;
  operation: string;
  args?: string[];
  dependsOn?: string[];
  environment?: string;
  timeoutMs?: number;
}

export interface ExecutionPlan {
  planId: string;
  objective: string;
  steps: ExecutionPlanStep[];
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  environment: string;
  approvalRequired: boolean;
  rollbackRequired: boolean;
  verificationRequirements: string[];
}

export class ExecutionPlanValidator {
  validate(plan: ExecutionPlan): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const ids = new Set(plan.steps.map((s) => s.id));
    // duplicate IDs
    if (ids.size !== plan.steps.length) errors.push("Duplicate step IDs detected");

    // cycle detection
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string, stack: string[]): boolean => {
      if (visiting.has(id)) {
        errors.push(`Circular dependency detected: ${stack.join(" -> ")} -> ${id}`);
        return false;
      }
      if (visited.has(id)) return true;
      const step = plan.steps.find((s) => s.id === id);
      if (!step) {
        errors.push(`Unknown dependency: ${id}`);
        return false;
      }
      visiting.add(id);
      if (step.dependsOn) {
        for (const dep of step.dependsOn) {
          if (!visit(dep, [...stack, dep])) return false;
        }
      }
      visiting.delete(id);
      visited.add(id);
      return true;
    };

    for (const step of plan.steps) {
      if (!visited.has(step.id)) {
        visit(step.id, [step.id]);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  topologicalOrder(plan: ExecutionPlan): ExecutionPlanStep[] {
    const valid = this.validate(plan);
    if (!valid.valid) throw new Error("Cannot order invalid plan");
    const ordered: ExecutionPlanStep[] = [];
    const visited = new Set<string>();
    const visit = (step: ExecutionPlanStep) => {
      if (visited.has(step.id)) return;
      visited.add(step.id);
      if (step.dependsOn) {
        for (const dep of step.dependsOn) {
          const depStep = plan.steps.find((s) => s.id === dep);
          if (depStep) visit(depStep);
        }
      }
      ordered.push(step);
    };
    for (const step of plan.steps) visit(step);
    return ordered;
  }
}
