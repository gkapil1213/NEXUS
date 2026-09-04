import { ExecutionJobStatus } from "./execution-models";

const VALID_TRANSITIONS: Record<ExecutionJobStatus, ExecutionJobStatus[]> = {
  QUEUED: ["CLAIMED", "CANCELLATION_REQUESTED", "CANCELLED", "BLOCKED"],
  CLAIMED: ["RUNNING", "ORPHANED", "CANCELLATION_REQUESTED", "CANCELLED"],
  RUNNING: ["VERIFYING", "FAILED", "ORPHANED", "CANCELLATION_REQUESTED", "CANCELLED"],
  VERIFYING: ["SUCCEEDED", "FAILED", "ORPHANED", "CANCELLATION_REQUESTED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: ["RETRY_SCHEDULED", "DEAD_LETTER", "CANCELLED"],
  RETRY_SCHEDULED: ["QUEUED", "CANCELLED"],
  DEAD_LETTER: [],
  CANCELLATION_REQUESTED: ["CANCELLED", "RUNNING"], // worker may acknowledge by continuing briefly
  CANCELLED: [],
  ORPHANED: ["QUEUED", "CLAIMED", "FAILED", "DEAD_LETTER"],
  BLOCKED: [],
};

export class ExecutionStateMachine {
  canTransition(from: ExecutionJobStatus, to: ExecutionJobStatus): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }

  assertTransition(from: ExecutionJobStatus, to: ExecutionJobStatus): void {
    if (!this.canTransition(from, to)) {
      throw new Error(`Invalid state transition: ${from} -> ${to}`);
    }
  }
}
