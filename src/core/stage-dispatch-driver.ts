// Phase 203a: topologically-ordered stage dispatch driver.
//
// The CI/CD orchestrator iterates pipeline.stages in declared order and can
// block on a stage whose dependency is later in the list. This driver loads
// the canonical dependency graph, sorts stages topologically, and dispatches
// each stage through the existing admission + lease + adapter path until
// convergence (no more progress) or a hard terminal failure.
//
// Reuses: evaluateStageAdmission/Async (202), LeaseManager.acquireLease
// (Phase 194), StageExecutionStoreAdapter.transitionWithLease (201),
// ExecutionAdapter.execute (existing), orderDependencies/detectCycle
// (worker-recovery-dependency).

import { randomUUID } from "crypto";
import type { ExecutionStore } from "./execution-store";
import type { LeaseManager } from "./lease-manager";
import type { ExecutionAdapter } from "./execution-adapter";
import { StageExecutionStoreAdapter } from "./stage-execution-store-adapter";
import { evaluateStageAdmission, evaluateStageAdmissionAsync } from "./stage-admission";
import { detectCycle, orderDependencies, type DependencyGraph } from "./worker-recovery-dependency";
import {
  createStageExecution,
  type StageExecution,
  type StageStatus,
} from "./worker-stage-execution";

export interface DispatchSummary {
  executionId: string;
  ticks: number;
  dispatched: string[];
  blocked: Array<{ stage: string; reason: string }>;
  skipped: string[];
  failed: Array<{ stage: string; error: string }>;
  converged: boolean;
  terminal: boolean;
  cancelled: boolean;
}

const TERMINAL_STAGES: readonly StageStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"];

function topologicalOrder(
  stagesByName: Map<string, StageExecution>,
  edges: Array<{ stageName: string; dependsOnStage: string }>,
): string[] {
  const nodes = [...stagesByName.keys()];
  const edgeMap: Record<string, string[]> = {};
  for (const s of nodes) edgeMap[s] = edgeMap[s] ?? [];
  for (const e of edges) {
    if (!edgeMap[e.stageName]) edgeMap[e.stageName] = [];
    edgeMap[e.stageName].push(e.dependsOnStage);
  }
  const graph: DependencyGraph = { nodes, edges: edgeMap };
  if (detectCycle(graph)) throw new Error("STAGE_GRAPH_CYCLE_DETECTED");
  return orderDependencies(graph);
}

export interface RunStageGraphInput {
  store: ExecutionStore;
  leaseManager: LeaseManager;
  adapter: ExecutionAdapter;
  executionId: string;
  workerId: string;
  leaseTtlMs?: number;
  maxTicks?: number;
  now?: () => number;
}

export async function runStageGraphToCompletion(
  input: RunStageGraphInput,
): Promise<DispatchSummary> {
  const {
    store, leaseManager, adapter, executionId, workerId,
    leaseTtlMs = 60_000,
    maxTicks = 200,
    now = () => Date.now(),
  } = input;

  const summary: DispatchSummary = {
    executionId,
    ticks: 0,
    dispatched: [],
    blocked: [],
    skipped: [],
    failed: [],
    converged: false,
    terminal: false,
    cancelled: false,
  };

  const execJob = store.getJob(executionId);
  if (!execJob) throw new Error("EXECUTION_NOT_FOUND:" + executionId);

  const pipelinePayload = (execJob.payload ?? {}) as Record<string, any>;
  const tenantId: string = pipelinePayload.tenantId ?? "unknown";
  const correlationId: string = pipelinePayload.correlationId ?? randomUUID();

  const stagePort = new StageExecutionStoreAdapter(store);

  for (let tick = 0; tick < maxTicks; tick++) {
    summary.ticks = tick + 1;

    const freshExec = store.getJob(executionId);
    if (freshExec?.cancellationRequested) {
      summary.cancelled = true;
      summary.terminal = true;
      return summary;
    }

    // Load the durable graph + all stages for this execution.
    const allStages: StageExecution[] = stagePort.listForExecutionSync(executionId);
    if (allStages.length === 0) {
      summary.converged = true;
      summary.terminal = true;
      return summary;
    }
    const stagesByName = new Map<string, StageExecution>();
    for (const s of allStages) stagesByName.set(s.stageName, s);

    const edges = store.stageDeps.listGraph(executionId).map((e) => ({
      stageName: e.stageName,
      dependsOnStage: e.dependsOnStage,
    }));

    let order: string[];
    try {
      order = topologicalOrder(stagesByName, edges);
    } catch (e: any) {
      summary.failed.push({ stage: "*", error: String(e?.message ?? e) });
      return summary;
    }

    let progressThisTick = false;

    for (const stageName of order) {
      if (summary.dispatched.includes(stageName)) continue;
      if (summary.failed.some((f) => f.stage === stageName)) continue;

      const stage = stagesByName.get(stageName);
      if (!stage) continue;

      if (TERMINAL_STAGES.includes(stage.status)) {
        if (!summary.skipped.includes(stageName)) summary.skipped.push(stageName);
        continue;
      }

      // Admission gate (durable read; dispatches by backend).
      const adm = store.hasAsyncBackend()
        ? await evaluateStageAdmissionAsync({ store, executionId, stageName })
        : evaluateStageAdmission({ store, executionId, stageName });

      if (!adm.eligible) {
        if (!summary.blocked.some((b) => b.stage === stageName)) {
          summary.blocked.push({ stage: stageName, reason: adm.reason });
        }
        continue;
      }

      // Stage is admitted. Ensure a durable stage row exists, then claim.
      let stored: StageExecution;
      try {
        stored = await stagePort.insertIfAbsent(createStageExecution({
          executionId,
          tenantId,
          correlationId,
          stageName,
          executor: adapter.getId(),
          inputFingerprint: `${executionId}:${stageName}`,
          artifactReferences: [],
        }));
      } catch (e: any) {
        summary.failed.push({ stage: stageName, error: `insertIfAbsent: ${e?.message ?? e}` });
        continue;
      }

      if (TERMINAL_STAGES.includes(stored.status)) {
        if (!summary.skipped.includes(stageName)) summary.skipped.push(stageName);
        continue;
      }

      // Atomic claim. Concurrent workers race here; only one lease survives.
      let stageLease;
      try {
        stageLease = leaseManager.acquireLease(stored.stageExecutionId, workerId, leaseTtlMs);
      } catch (e: any) {
        // LOSER of the race, or lease conflict.
        summary.blocked.push({ stage: stageName, reason: `LEASE_UNAVAILABLE: ${e?.message ?? e}` });
        continue;
      }

      // PENDING -> RUNNING (lease-fenced).
      const startNow = new Date(now()).toISOString();
      let running: StageExecution;
      try {
        running = await stagePort.transitionWithLease({
          stageExecutionId: stored.stageExecutionId,
          from: "PENDING",
          to: "RUNNING",
          workerId,
          leaseId: stageLease.leaseId,
          patch: { startedAt: startNow, workerId, leaseId: stageLease.leaseId },
          evidence: {
            correlationId, executionId,
            stageExecutionId: stored.stageExecutionId,
            from: "PENDING", to: "RUNNING",
            workerId, leaseId: stageLease.leaseId,
            at: startNow,
          },
        });
      } catch (e: any) {
        try { leaseManager.releaseLease(stageLease.leaseId); } catch {}
        summary.failed.push({ stage: stageName, error: `transition_to_running: ${e?.message ?? e}` });
        continue;
      }

      // Execute via the existing adapter.
      let adapterResult: { success: boolean; externalId?: string; stderr?: string };
      try {
        adapterResult = await adapter.execute(
          {
            operation: stageName,
            args: [],
            metadata: { pipelineId: executionId, correlationId },
          },
          { jobId: stored.stageExecutionId },
        );
      } catch (e: any) {
        adapterResult = { success: false, stderr: `adapter threw: ${e?.message ?? e}` };
      }

      const endNow = new Date(now()).toISOString();
      const nextStatus: "SUCCEEDED" | "FAILED" = adapterResult.success ? "SUCCEEDED" : "FAILED";
      const failureReason = adapterResult.success
        ? undefined
        : (adapterResult.stderr ?? "executor returned failure");

      try {
        await stagePort.transitionWithLease({
          stageExecutionId: stored.stageExecutionId,
          from: "RUNNING",
          to: nextStatus,
          workerId,
          leaseId: stageLease.leaseId,
          patch: {
            endedAt: endNow,
            outputFingerprint: adapterResult.externalId ?? undefined,
            failureReason,
          },
          evidence: {
            correlationId, executionId,
            stageExecutionId: stored.stageExecutionId,
            from: "RUNNING", to: nextStatus,
            workerId, leaseId: stageLease.leaseId,
            reason: failureReason,
            at: endNow,
          },
        });
      } finally {
        try { leaseManager.releaseLease(stageLease.leaseId); } catch {}
      }

      if (adapterResult.success) {
        summary.dispatched.push(stageName);
      } else {
        summary.failed.push({ stage: stageName, error: failureReason ?? "stage failed" });
      }
      progressThisTick = true;
    }

    if (!progressThisTick) {
      // No stage was dispatchable this tick. Either all are terminal, or
      // we are blocked waiting for external convergence.
      const freshStages = stagePort.listForExecutionSync(executionId);
      const allTerminal = freshStages.length > 0 &&
        freshStages.every((s) => TERMINAL_STAGES.includes(s.status));
      summary.converged = allTerminal;
      summary.terminal = allTerminal;
      return summary;
    }

    // Check if we finished everything.
    const after = stagePort.listForExecutionSync(executionId);
    const allDone = after.length > 0 && after.every((s) => TERMINAL_STAGES.includes(s.status));
    if (allDone) {
      summary.converged = true;
      summary.terminal = true;
      return summary;
    }
  }

  // maxTicks exhausted.
  summary.converged = false;
  summary.terminal = false;
  return summary;
}