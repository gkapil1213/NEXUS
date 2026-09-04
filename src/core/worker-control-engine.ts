import Database from "better-sqlite3";
import { ControlDecisionStore, ControlDecision, ControlDecisionStatus } from "./worker-control-decision";
import { ControlActionStore, ControlAction } from "./worker-control-action";
import { WorkerControlExecutor, ExecutorResult } from "./worker-control-executor";
import { WorkerControlBudget } from "./worker-control-budget";
import { WorkerControlStability } from "./worker-control-stability";
import { WorkerControlOverrideStore } from "./worker-control-override";
import { WorkerSafetyGate } from "./worker-safety-gate";

export interface ControlEngineDeps {
  decisionStore: ControlDecisionStore;
  actionStore: ControlActionStore;
  executor: WorkerControlExecutor;
  budget: WorkerControlBudget;
  stability: WorkerControlStability;
  override: WorkerControlOverrideStore;
  safetyGate?: WorkerSafetyGate;
}

export class WorkerControlEngine {
  constructor(private deps: ControlEngineDeps) {}

  submitDecision(decision: ControlDecision): { status: ControlDecisionStatus; reason?: string } {
    const existing = this.deps.decisionStore.getByIdempotencyKey(decision.idempotencyKey);
    if (existing) return { status: existing.status, reason: "duplicate" };
    this.deps.decisionStore.create(decision);
    return { status: decision.status };
  }

  executeDecision(decisionId: string): { status: ControlDecisionStatus; actionId?: string; reason?: string } {
    const decision = this.deps.decisionStore.get(decisionId);
    if (!decision) return { status: "BLOCKED", reason: "decision_not_found" };

    // Idempotency: check if action already exists for this decision
    const existingAction = this.deps.actionStore.getByIdempotencyKey(`action_${decision.idempotencyKey}`);
    if (existingAction) return { status: "BLOCKED", reason: "action_already_executed" };

    // Stale/expired checks
    if (decision.expiresAt && Date.now() > decision.expiresAt) return { status: "EXPIRED", reason: "decision_expired" };
    if (decision.status !== "APPROVED" && decision.status !== "AUTHORIZED") return { status: "BLOCKED", reason: "decision_not_approved" };

    // Autonomy level enforcement
    if (decision.autonomyLevel === "OBSERVE_ONLY") return { status: "BLOCKED", reason: "observe_only_mode" };
    if (decision.autonomyLevel === "HUMAN_APPROVAL_REQUIRED") return { status: "DEFERRED", reason: "human_approval_required" };
    if (decision.autonomyLevel === "EMERGENCY_STOP") return { status: "BLOCKED", reason: "emergency_stop" };

    // Override check
    if (this.deps.override.isActive("STOP_AUTONOMOUS_CONTROL")) return { status: "BLOCKED", reason: "emergency_stop" };
    if (this.deps.override.isActive("PAUSE_AUTONOMOUS_CONTROL")) return { status: "DEFERRED", reason: "autonomy_paused" };

    // Budget check (use action type scope)
    if (!this.deps.budget.checkAndRecord(decision.actionType, 5, 60000)) {
      return { status: "BLOCKED", reason: "budget_exhausted" };
    }

    // Safety gate for worker-target actions
    if (decision.targetId && this.deps.safetyGate) {
      const gateResult = this.deps.safetyGate.evaluate(decision.targetId);
      if (gateResult !== "ALLOW") return { status: "BLOCKED", reason: `safety_gate_${gateResult}` };
    }

    // Oscillation check
    const stabilityState = this.deps.stability.record(decision.actionType);
    if (stabilityState === "OSCILLATING") {
      return { status: "BLOCKED", reason: "oscillation_detected" };
    }

    // Create action and execute
    const actionId = `action_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const action: ControlAction = {
      actionId,
      decisionId: decisionId,
      actionType: decision.actionType as any,
      targetId: decision.targetId,
      status: "EXECUTING",
      idempotencyKey: `action_${decision.idempotencyKey}`,
      evidence: { decisionId },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.deps.actionStore.create(action);

    const result = this.deps.executor.execute(decision.actionType as any, decision.targetId);
    let actionStatus: ControlAction["status"];
    let decisionStatus: ControlDecisionStatus;
    switch (result) {
      case "SUCCEEDED":
        actionStatus = "SUCCEEDED";
        decisionStatus = "SUCCEEDED";
        break;
      case "CONTROL_PLANE_ONLY":
        actionStatus = "SUCCEEDED"; // control-plane action executed successfully
        decisionStatus = "SUCCEEDED";
        break;
      case "FAILED":
        actionStatus = "FAILED";
        decisionStatus = "FAILED";
        break;
      default:
        actionStatus = "FAILED";
        decisionStatus = "FAILED";
    }

    this.deps.actionStore.updateStatus(actionId, actionStatus);
    this.deps.decisionStore.updateStatus(decisionId, decisionStatus);
    return { status: decisionStatus, actionId };
  }
}
