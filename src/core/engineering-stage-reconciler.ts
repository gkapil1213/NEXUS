// src/core/engineering-stage-reconciler.ts
// Phase 260 — read-only stage-state reconciliation.
//
// Compares the three durable ledgers for one engineering stage:
//   1. execution_jobs        (authoritative job status)
//   2. engineering_run_stages (DAG progression / capability_status)
//   3. engineering_run_events (audit timeline)
//
// Read-only: this module never mutates. It classifies findings so the
// caller can decide whether a repair is warranted.
//
// Partial-persistence repair (§4C) is deliberately NOT implemented here —
// the transaction boundaries do not allow a safe repair without either a
// cross-service transaction handle or a schema-level outbox. See
// docs/phase260/known-limitations.md.

import type { ExecutionStore } from "./execution-store";
import type { EngineeringRunService } from "./engineering-run-service";
import type { EngineeringStageType } from "./engineering-capability-registry";

export type StageReconciliationFinding =
  | { kind: "CONSISTENT"; jobStatus: string; stageStatus: string }
  | { kind: "MISSING_JOB"; stageId: string; stageStatus: string }
  | { kind: "MISSING_STAGE"; stageId: string; jobStatus: string }
  | { kind: "STAGE_JOB_MISMATCH"; jobStatus: string; stageStatus: string }
  | { kind: "TERMINAL_CONFLICT"; jobStatus: string; stageStatus: string }
  | { kind: "MISSING_RUN_EVENT"; jobStatus: string; expectedEventTypes: string[] }
  | { kind: "UNREADABLE"; reason: string };

const TERMINAL_JOB_STATUSES = new Set(["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED", "DEAD_LETTER"]);

// Map job status → the expected engineering_run_events event type when
// the stage reaches that status.
const EXPECTED_RUN_EVENT_FOR_JOB: Record<string, string[]> = {
  SUCCEEDED: ["engineering_run.stage_succeeded"],
  FAILED:    ["engineering_run.stage_failed"],
  BLOCKED:   ["engineering_run.stage_blocked"],
};

// Capability status → the job status we expect it to correspond to.
// AVAILABLE + artifactRef set ⇔ job SUCCEEDED.
// UNAVAILABLE without artifact ⇔ job BLOCKED or FAILED (any terminal-non-SUCCEEDED).
const COMPATIBLE_STAGE_FOR_JOB: Record<string, string[]> = {
  SUCCEEDED: ["AVAILABLE"],
  FAILED:    ["UNAVAILABLE", "NOT_IMPLEMENTED"],
  BLOCKED:   ["UNAVAILABLE", "NOT_IMPLEMENTED"],
  CANCELLED: ["UNAVAILABLE", "NOT_IMPLEMENTED"],
  DEAD_LETTER: ["UNAVAILABLE", "NOT_IMPLEMENTED"],
};

export async function reconcileEngineeringStage(input: {
  runId: string;
  stageType: EngineeringStageType;
  store: ExecutionStore;
  runService: EngineeringRunService;
}): Promise<{ findings: StageReconciliationFinding[]; ok: boolean }> {
  const { runId, stageType, store, runService } = input;
  const stageId = runId + "__" + stageType;
  const findings: StageReconciliationFinding[] = [];

  // ---- Read the authoritative job --------------------------------------
  let job;
  try {
    job = await store.getJobAsync(stageId);
  } catch (e) {
    return {
      findings: [{ kind: "UNREADABLE", reason: "getJobAsync:" + (e instanceof Error ? e.message : String(e)) }],
      ok: false,
    };
  }
  if (!job) {
    return {
      findings: [{ kind: "MISSING_JOB", stageId, stageStatus: "UNKNOWN" }],
      ok: false,
    };
  }

  // ---- Read the stage row ----------------------------------------------
  let stages;
  try {
    stages = await runService.getEngineeringRunStages(runId);
  } catch (e) {
    return {
      findings: [{ kind: "UNREADABLE", reason: "getEngineeringRunStages:" + (e instanceof Error ? e.message : String(e)) }],
      ok: false,
    };
  }
  const stage = stages.find((s) => s.stageType === stageType);
  if (!stage) {
    return {
      findings: [{ kind: "MISSING_STAGE", stageId, jobStatus: job.status }],
      ok: false,
    };
  }

  const jobStatus = job.status;
  const stageStatus = stage.capabilityStatus;

  // ---- Stage/job compatibility check -----------------------------------
  const expectedStages = COMPATIBLE_STAGE_FOR_JOB[jobStatus] ?? [];
  if (expectedStages.length > 0 && expectedStages.indexOf(stageStatus) < 0) {
    // Distinguish terminal conflict from a plain mismatch: if job is
    // terminal and stage is a status that would correspond to a *different*
    // terminal, that is a conflict, not just drift.
    if (TERMINAL_JOB_STATUSES.has(jobStatus)) {
      findings.push({ kind: "TERMINAL_CONFLICT", jobStatus, stageStatus });
    } else {
      findings.push({ kind: "STAGE_JOB_MISMATCH", jobStatus, stageStatus });
    }
  }

  // ---- Run-event presence check ----------------------------------------
  // For a terminal job status, the corresponding engineering_run_events
  // row should exist. Its absence indicates partial persistence.
  const expected = EXPECTED_RUN_EVENT_FOR_JOB[jobStatus];
  if (expected && expected.length > 0) {
    let events;
    try {
      events = await runService.getEngineeringRunEvents(runId);
    } catch (e) {
      findings.push({ kind: "UNREADABLE", reason: "getEngineeringRunEvents:" + (e instanceof Error ? e.message : String(e)) });
      return { findings, ok: false };
    }
    const hasAny = events.some((ev) => expected.indexOf(ev.eventType) >= 0);
    if (!hasAny) {
      findings.push({ kind: "MISSING_RUN_EVENT", jobStatus, expectedEventTypes: expected });
    }
  }

  // ---- Classification --------------------------------------------------
  if (findings.length === 0) {
    return { findings: [{ kind: "CONSISTENT", jobStatus, stageStatus }], ok: true };
  }
  // If any UNREADABLE finding is present, ok is false regardless.
  const ok = findings.every((f) => f.kind === "CONSISTENT");
  return { findings, ok };
}