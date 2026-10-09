// src/core/engineering-stage-executor.ts
// Phase 218: production engineering-stage executor.
//
// Runtime integration layer between the durable engineering-run DAG
// (Phase 214) and the existing planning/architecture (Phase 215) and
// implementation (Phase 217) orchestrators.

import type { ExecutionStore } from "./execution-store";
import type { EngineeringRunService, EngineeringRun } from "./engineering-run-service";
import type { EngineeringPlanningOrchestrator } from "./engineering-planning-orchestrator";
import type { EngineeringImplementationOrchestrator } from "./engineering-implementation-orchestrator";
import type { EngineeringBuildExecutor } from "./engineering-build-executor";
import type { EngineeringTestExecutor } from "./engineering-test-executor";
import type { EngineeringDiagnosisExecutor } from "./engineering-diagnosis-executor";
import type { EngineeringRepairExecutor } from "./engineering-repair-executor";
import type { EngineeringSecurityReviewExecutor } from "./engineering-security-review-executor";
import type { EngineeringReleaseReadyExecutor } from "./engineering-release-ready-executor";
import type { WorkspaceActor } from "./workspace";
import {
  CANONICAL_ENGINEERING_DAG,
  type EngineeringStageType,
} from "./engineering-capability-registry";

export type StageExecutionStatus = "SUCCEEDED" | "FAILED" | "BLOCKED" | "INVALID";

export interface EngineeringStageJobPayload {
  kind: "engineering.stage";
  runId: string;
  stageType: EngineeringStageType;
}

export interface WorkspaceResolution {
  workspaceId: string;
  actor: WorkspaceActor;
}

export interface EngineeringStageExecutorDeps {
  store: ExecutionStore;
  runService: EngineeringRunService;
  planning: EngineeringPlanningOrchestrator;
  implementation: EngineeringImplementationOrchestrator;
  buildExecutor?: EngineeringBuildExecutor;
  testExecutor?: EngineeringTestExecutor;
  diagnosisExecutor?: EngineeringDiagnosisExecutor;
  repairExecutor?: EngineeringRepairExecutor;
  securityReviewExecutor?: EngineeringSecurityReviewExecutor;
  releaseReadyExecutor?: EngineeringReleaseReadyExecutor;
  workspaceResolver?: (runId: string) => Promise<WorkspaceResolution | null>;
}

export type StageExecutionOutcome =
  | {
      ok: true;
      runId: string;
      stageType: EngineeringStageType;
      status: StageExecutionStatus;
      reason: string;
      artifactRef: string | null;
    }
  | { ok: false; reason: string };

const WIRED_STAGES: ReadonlySet<EngineeringStageType> = new Set([
  "PLANNING",
  "ARCHITECTURE",
  "IMPLEMENTATION",
  "BUILD",
  "TEST",
  "DIAGNOSIS",
  "REPAIR",
  "SECURITY_REVIEW",
  "RELEASE_READY",
]);

const JOB_TERMINAL = new Set<string>([
  "SUCCEEDED", "FAILED", "CANCELLED", "DEAD_LETTER", "BLOCKED",
]);

export class EngineeringStageExecutor {
  constructor(private readonly deps: EngineeringStageExecutorDeps) {}

  static wiredStages(): ReadonlySet<EngineeringStageType> {
    return WIRED_STAGES;
  }

  static wiring(): { wiredStages: ReadonlySet<EngineeringStageType> } {
    return { wiredStages: WIRED_STAGES };
  }

  async execute(raw: unknown): Promise<StageExecutionOutcome> {
    const parsed = this.parsePayload(raw);
    if (!parsed.ok) return parsed;
    const { runId, stageType } = parsed;

    const run = await this.deps.runService.getEngineeringRun(runId);
    if (!run) return { ok: false, reason: "RUN_NOT_FOUND" };

    const stages = await this.deps.runService.getEngineeringRunStages(runId);
    const stage = stages.find((s) => s.stageType === stageType);
    if (!stage) return { ok: false, reason: "STAGE_NOT_FOUND_FOR_RUN" };

    if (!WIRED_STAGES.has(stageType)) {
      await this.markStageJob(runId, stageType, "BLOCKED",
        "engineering_run.stage_blocked", { reason: "STAGE_NOT_WIRED" });
      return { ok: true, runId, stageType, status: "BLOCKED",
               reason: "STAGE_NOT_WIRED", artifactRef: null };
    }

    const dep = await this.assertUpstreamComplete(runId, stageType);
    if (!dep.ok) {
      await this.markStageJob(runId, stageType, "BLOCKED",
        "engineering_run.stage_blocked", { reason: dep.reason });
      return { ok: true, runId, stageType, status: "BLOCKED",
               reason: dep.reason, artifactRef: null };
    }

    switch (stageType) {
      case "PLANNING":       return this.executePlanning(runId, run);
      case "ARCHITECTURE":   return this.executeArchitecture(runId);
      case "IMPLEMENTATION": return this.executeImplementation(runId);
      case "BUILD":          return this.executeBuild(runId);
      case "TEST":           return this.executeTest(runId);
      case "DIAGNOSIS":     return this.executeDiagnosis(runId);
      case "REPAIR":        return this.executeRepair(runId);
      case "SECURITY_REVIEW": return this.executeSecurityReview(runId);
      default:
        return { ok: true, runId, stageType, status: "BLOCKED",
                 reason: "STAGE_NOT_WIRED", artifactRef: null };
    }
  }

  private parsePayload(raw: unknown):
    | { ok: true; runId: string; stageType: EngineeringStageType }
    | { ok: false; reason: string } {
    if (!raw || typeof raw !== "object") return { ok: false, reason: "PAYLOAD_NOT_OBJECT" };
    const p = raw as Record<string, unknown>;
    if (p.kind !== "engineering.stage") return { ok: false, reason: "UNSUPPORTED_JOB_KIND" };
    if (typeof p.runId !== "string" || !p.runId) return { ok: false, reason: "RUN_ID_MISSING" };
    if (typeof p.stageType !== "string") return { ok: false, reason: "STAGE_TYPE_MISSING" };
    const known = CANONICAL_ENGINEERING_DAG.some((s) => s.stageType === p.stageType);
    if (!known) return { ok: false, reason: "UNKNOWN_STAGE_TYPE:" + p.stageType };
    return { ok: true, runId: p.runId, stageType: p.stageType as EngineeringStageType };
  }

  private async assertUpstreamComplete(
    runId: string,
    stageType: EngineeringStageType,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Phase 221: DIAGNOSIS analyzes prior-stage terminal outcomes —
    // including FAILED — so the SUCCEEDED-only gate does not apply.
    // The diagnosis executor itself enforces evidence sufficiency and
    // returns BLOCKED when the prior stages are not yet diagnosable.
    if (stageType === "DIAGNOSIS") {
      const spec = CANONICAL_ENGINEERING_DAG.find((s) => s.stageType === stageType);
      if (!spec) return { ok: false, reason: "UNKNOWN_STAGE" };
      for (const upstream of spec.dependsOn) {
        const j = await this.deps.store.getJobAsync(runId + "__" + upstream);
        if (!j) return { ok: false, reason: "UPSTREAM_JOB_MISSING:" + upstream };
      }
      return { ok: true };
    }

    const spec = CANONICAL_ENGINEERING_DAG.find((s) => s.stageType === stageType);
    if (!spec) return { ok: false, reason: "UNKNOWN_STAGE" };
    for (const upstream of spec.dependsOn) {
      const jobId = runId + "__" + upstream;
      const j = await this.deps.store.getJobAsync(jobId);
      if (!j) return { ok: false, reason: "UPSTREAM_JOB_MISSING:" + upstream };
      if (j.status !== "SUCCEEDED") {
        return { ok: false, reason: "UPSTREAM_NOT_SUCCEEDED:" + upstream + ":" + j.status };
      }
    }
    return { ok: true };
  }

  private async executePlanning(runId: string, run: EngineeringRun): Promise<StageExecutionOutcome> {
    let outcome;
    try {
      const submit = await this.deps.planning.submitRequest({
        runId,
        requestText: run.objective,
        createdBy: run.requestedBy ?? "engineering-stage-executor",
        metadata: { phase: 218, stageType: "PLANNING" },
      });
      outcome = await this.deps.planning.runPlanning(runId, submit.request.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return this.applyStageOutcome(runId, "PLANNING", "FAILED", "PLANNING_EXECUTOR_THREW:" + msg, null);
    }
    if (outcome.status === "SUCCEEDED" && outcome.plan) {
      const artifactRef = "artifact://plan-" + outcome.plan.planId;
      await this.applyStageCompletion(runId, "PLANNING", artifactRef, "plan validated");
      return { ok: true, runId, stageType: "PLANNING",
               status: "SUCCEEDED", reason: outcome.reason, artifactRef };
    }
    return this.applyStageOutcome(runId, "PLANNING", outcome.status, outcome.reason, null);
  }
  private async executeArchitecture(runId: string): Promise<StageExecutionOutcome> {
    let plan, outcome;
    try {
      plan = await this.deps.planning.getLatestPlan(runId);
      if (!plan) {
        return this.applyStageOutcome(runId, "ARCHITECTURE", "FAILED", "PLAN_NOT_FOUND", null);
      }
      if (plan.status !== "VALID") {
        return this.applyStageOutcome(runId, "ARCHITECTURE", "INVALID",
          "PLAN_NOT_VALID:" + plan.status, null);
      }
      outcome = await this.deps.planning.runArchitecture(runId, plan.planId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return this.applyStageOutcome(runId, "ARCHITECTURE", "FAILED", "ARCHITECTURE_EXECUTOR_THREW:" + msg, null);
    }
    if (outcome.status === "SUCCEEDED" && outcome.architecture) {
      const artifactRef = "artifact://architecture-" + outcome.architecture.architectureId;
      await this.applyStageCompletion(runId, "ARCHITECTURE", artifactRef, "architecture validated");
      return { ok: true, runId, stageType: "ARCHITECTURE",
               status: "SUCCEEDED", reason: outcome.reason, artifactRef };
    }
    return this.applyStageOutcome(runId, "ARCHITECTURE", outcome.status, outcome.reason, null);
  }
  private async executeImplementation(runId: string): Promise<StageExecutionOutcome> {
    let plan, arch, ws, outcome;
    try {
      plan = await this.deps.planning.getLatestPlan(runId);
      if (!plan || plan.status !== "VALID") {
        return this.applyStageOutcome(runId, "IMPLEMENTATION", "FAILED",
          "PLAN_NOT_VALID:" + (plan && plan.status ? plan.status : "MISSING"), null);
      }
      arch = await this.deps.planning.getLatestArchitecture(runId);
      if (!arch || arch.status !== "VALID") {
        return this.applyStageOutcome(runId, "IMPLEMENTATION", "FAILED",
          "ARCHITECTURE_NOT_VALID:" + (arch && arch.status ? arch.status : "MISSING"), null);
      }
      if (!this.deps.workspaceResolver) {
        return this.applyStageOutcome(runId, "IMPLEMENTATION", "BLOCKED",
          "WORKSPACE_RESOLVER_NOT_CONFIGURED", null);
      }
      ws = await this.deps.workspaceResolver(runId);
      if (!ws) {
        return this.applyStageOutcome(runId, "IMPLEMENTATION", "BLOCKED",
          "WORKSPACE_NOT_BOUND_TO_RUN", null);
      }
      outcome = await this.deps.implementation.runImplementation({
        runId,
        planId: plan.planId,
        architectureId: arch.architectureId,
        workspaceId: ws.workspaceId,
        actor: ws.actor,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return this.applyStageOutcome(runId, "IMPLEMENTATION", "FAILED", "IMPLEMENTATION_EXECUTOR_THREW:" + msg, null);
    }
    if (outcome.status === "SUCCEEDED") {
      const artifactRef = outcome.artifactId ? "artifact://" + outcome.artifactId : null;
      await this.applyStageCompletion(runId, "IMPLEMENTATION", artifactRef, "implementation applied");
      return { ok: true, runId, stageType: "IMPLEMENTATION",
               status: "SUCCEEDED", reason: outcome.reason, artifactRef };
    }
    return this.applyStageOutcome(runId, "IMPLEMENTATION", outcome.status, outcome.reason, null);
  }
  private async executeBuild(runId: string): Promise<StageExecutionOutcome> {
    if (!this.deps.buildExecutor) {
      return this.applyStageOutcome(runId, "BUILD", "BLOCKED",
        "BUILD_EXECUTOR_NOT_CONFIGURED", null);
    }
    const run = await this.deps.runService.getEngineeringRun(runId);
    if (!run) return this.applyStageOutcome(runId, "BUILD", "FAILED", "RUN_NOT_FOUND", null);

    if (!this.deps.workspaceResolver) {
      return this.applyStageOutcome(runId, "BUILD", "BLOCKED",
        "WORKSPACE_RESOLVER_NOT_CONFIGURED", null);
    }
    const ws = await this.deps.workspaceResolver(runId);
    if (!ws) {
      return this.applyStageOutcome(runId, "BUILD", "BLOCKED",
        "WORKSPACE_NOT_BOUND_TO_RUN", null);
    }

    let outcome;
    try {
      outcome = await this.deps.buildExecutor.runBuild({
        runId, workspaceId: ws.workspaceId, actor: ws.actor,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return this.applyStageOutcome(runId, "BUILD", "FAILED", "BUILD_EXECUTOR_THREW:" + msg, null);
    }

    if (outcome.status === "SUCCEEDED") {
      await this.applyStageCompletion(runId, "BUILD", outcome.artifactRef, "build succeeded");
      return { ok: true, runId, stageType: "BUILD", status: "SUCCEEDED",
               reason: outcome.reason, artifactRef: outcome.artifactRef };
    }
    return this.applyStageOutcome(runId, "BUILD", outcome.status, outcome.reason, outcome.artifactRef);
  }

  private async executeTest(runId: string): Promise<StageExecutionOutcome> {
    if (!this.deps.testExecutor) {
      return this.applyStageOutcome(runId, "TEST", "BLOCKED",
        "TEST_EXECUTOR_NOT_CONFIGURED", null);
    }
    const run = await this.deps.runService.getEngineeringRun(runId);
    if (!run) return this.applyStageOutcome(runId, "TEST", "FAILED", "RUN_NOT_FOUND", null);

    if (!this.deps.workspaceResolver) {
      return this.applyStageOutcome(runId, "TEST", "BLOCKED",
        "WORKSPACE_RESOLVER_NOT_CONFIGURED", null);
    }
    const ws = await this.deps.workspaceResolver(runId);
    if (!ws) {
      return this.applyStageOutcome(runId, "TEST", "BLOCKED",
        "WORKSPACE_NOT_BOUND_TO_RUN", null);
    }

    let outcome;
    try {
      outcome = await this.deps.testExecutor.runTest({
        runId, workspaceId: ws.workspaceId, actor: ws.actor,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return this.applyStageOutcome(runId, "TEST", "FAILED", "TEST_EXECUTOR_THREW:" + msg, null);
    }

    if (outcome.status === "SUCCEEDED") {
      await this.applyStageCompletion(runId, "TEST", outcome.artifactRef, "test succeeded");
      return { ok: true, runId, stageType: "TEST", status: "SUCCEEDED",
               reason: outcome.reason, artifactRef: outcome.artifactRef };
    }
    return this.applyStageOutcome(runId, "TEST", outcome.status, outcome.reason, outcome.artifactRef);
  }

  private async executeDiagnosis(runId: string): Promise<StageExecutionOutcome> {
    if (!this.deps.diagnosisExecutor) {
      return this.applyStageOutcome(runId, "DIAGNOSIS", "BLOCKED",
        "DIAGNOSIS_EXECUTOR_NOT_CONFIGURED", null);
    }
    const run = await this.deps.runService.getEngineeringRun(runId);
    if (!run) return this.applyStageOutcome(runId, "DIAGNOSIS", "FAILED", "RUN_NOT_FOUND", null);

    let outcome;
    try {
      outcome = await this.deps.diagnosisExecutor.runDiagnosis({
        runId,
        actor: { id: "engineering-diagnosis-system", kind: "system" } as any,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return this.applyStageOutcome(runId, "DIAGNOSIS", "FAILED", "DIAGNOSIS_EXECUTOR_THREW:" + msg, null);
    }

    if (outcome.status === "SUCCEEDED") {
      await this.applyStageCompletion(runId, "DIAGNOSIS", outcome.artifactRef, "diagnosis completed");
      return { ok: true, runId, stageType: "DIAGNOSIS", status: "SUCCEEDED",
               reason: outcome.reason, artifactRef: outcome.artifactRef };
    }
    return this.applyStageOutcome(runId, "DIAGNOSIS", outcome.status, outcome.reason, outcome.artifactRef);
  }

  private async executeRepair(runId: string): Promise<StageExecutionOutcome> {
    if (!this.deps.repairExecutor) {
      return this.applyStageOutcome(runId, "REPAIR", "BLOCKED",
        "REPAIR_EXECUTOR_NOT_CONFIGURED", null);
    }
    const run = await this.deps.runService.getEngineeringRun(runId);
    if (!run) return this.applyStageOutcome(runId, "REPAIR", "FAILED", "RUN_NOT_FOUND", null);

    if (!this.deps.workspaceResolver) {
      return this.applyStageOutcome(runId, "REPAIR", "BLOCKED",
        "WORKSPACE_RESOLVER_NOT_CONFIGURED", null);
    }
    const ws = await this.deps.workspaceResolver(runId);
    if (!ws) {
      return this.applyStageOutcome(runId, "REPAIR", "BLOCKED",
        "WORKSPACE_NOT_BOUND_TO_RUN", null);
    }

    let outcome;
    try {
      outcome = await this.deps.repairExecutor.runRepair({
        runId, workspaceId: ws.workspaceId, actor: ws.actor,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return this.applyStageOutcome(runId, "REPAIR", "FAILED", "REPAIR_EXECUTOR_THREW:" + msg, null);
    }

    if (outcome.status === "SUCCEEDED") {
      await this.applyStageCompletion(runId, "REPAIR", outcome.artifactRef, "repair succeeded");
      return { ok: true, runId, stageType: "REPAIR", status: "SUCCEEDED",
               reason: outcome.reason, artifactRef: outcome.artifactRef };
    }
    return this.applyStageOutcome(runId, "REPAIR", outcome.status, outcome.reason, outcome.artifactRef);
  }

  private async executeSecurityReview(runId: string): Promise<StageExecutionOutcome> {
    if (!this.deps.securityReviewExecutor) {
      return this.applyStageOutcome(runId, "SECURITY_REVIEW", "BLOCKED",
        "SECURITY_REVIEW_EXECUTOR_NOT_CONFIGURED", null);
    }
    const run = await this.deps.runService.getEngineeringRun(runId);
    if (!run) return this.applyStageOutcome(runId, "SECURITY_REVIEW", "FAILED", "RUN_NOT_FOUND", null);

    if (!this.deps.workspaceResolver) {
      return this.applyStageOutcome(runId, "SECURITY_REVIEW", "BLOCKED",
        "WORKSPACE_RESOLVER_NOT_CONFIGURED", null);
    }
    const ws = await this.deps.workspaceResolver(runId);
    if (!ws) {
      return this.applyStageOutcome(runId, "SECURITY_REVIEW", "BLOCKED",
        "WORKSPACE_NOT_BOUND_TO_RUN", null);
    }

    let outcome;
    try {
      outcome = await this.deps.securityReviewExecutor.runSecurityReview({
        runId, workspaceId: ws.workspaceId, actor: ws.actor,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return this.applyStageOutcome(runId, "SECURITY_REVIEW", "FAILED", "SECURITY_REVIEW_EXECUTOR_THREW:" + msg, null);
    }

    if (outcome.status === "SUCCEEDED") {
      await this.applyStageCompletion(runId, "SECURITY_REVIEW", outcome.artifactRef, "security review passed");
      return { ok: true, runId, stageType: "SECURITY_REVIEW", status: "SUCCEEDED",
               reason: outcome.reason, artifactRef: outcome.artifactRef };
    }
    return this.applyStageOutcome(runId, "SECURITY_REVIEW", outcome.status, outcome.reason, outcome.artifactRef);
  }

    private async applyStageCompletion(
    runId: string,
    stageType: EngineeringStageType,
    artifactRef: string | null,
    reason: string,
  ): Promise<void> {
    const stages = await this.deps.runService.getEngineeringRunStages(runId);
    const stage = stages.find((s) => s.stageType === stageType);
    if (stage && !(stage.capabilityStatus === "AVAILABLE" && stage.artifactRef === artifactRef)) {
      await this.deps.runService.transitionStage({
        runId,
        stageId: stage.id,
        expectedCapabilityStatus: stage.capabilityStatus,
        newCapabilityStatus: "AVAILABLE",
        artifactRef,
        reason,
      });
    }
    await this.markStageJob(runId, stageType, "SUCCEEDED",
      "engineering_run.stage_succeeded", { reason, artifactRef });
  }

  private async applyStageOutcome(
    runId: string,
    stageType: EngineeringStageType,
    outcomeStatus: string,
    reason: string,
    artifactRef: string | null,
  ): Promise<StageExecutionOutcome> {
    const jobStatus =
      outcomeStatus === "SUCCEEDED" ? "SUCCEEDED" :
      outcomeStatus === "BLOCKED"   ? "BLOCKED"   :
      "FAILED";
    await this.markStageJob(runId, stageType, jobStatus,
      "engineering_run.stage_" + jobStatus.toLowerCase(), { reason });
    return { ok: true, runId, stageType,
             status: (outcomeStatus as StageExecutionStatus),
             reason, artifactRef };
  }

  private async markStageJob(
    runId: string,
    stageType: EngineeringStageType,
    targetStatus: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const jobId = runId + "__" + stageType;
    const current = await this.deps.store.getJobAsync(jobId);
    if (!current) return;
    if (current.status === targetStatus) return;
    if (JOB_TERMINAL.has(current.status) && targetStatus !== current.status) return;

    try {
      const result = await this.deps.store.recoverJobAtomicAsync({
        jobId,
        expectedStatus: current.status,
        newStatus: targetStatus,
        expectedLeaseId: current.currentLeaseId ?? null,
        patch: {},
        event: { eventType, payload },
      });

      if (!result.ok) return;

      const stages = await this.deps.runService.getEngineeringRunStages(runId);
      const stage = stages.find((s) => s.stageType === stageType);
      if (!stage) return;

      await this.deps.runService.recordStageExecutionEvent(
        runId,
        stage.id,
        eventType,
        payload,
      );
    } catch {
      /* durable job transition/event handling remains idempotent and observable */
    }
  }
}
