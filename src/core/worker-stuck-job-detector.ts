import { NexusEngine } from "./db";

export type StuckJobState = "NORMAL" | "SUSPECTED" | "STUCK" | "RECOVERY_REQUIRED";

export class WorkerStuckJobDetector {
  constructor(private db: NexusEngine) {}

  evaluate(jobId: string, executionDurationMs: number, leaseAgeMs: number, heartbeatAgeMs: number): StuckJobState {
    if (executionDurationMs > 120000 && leaseAgeMs > 120000 && heartbeatAgeMs > 120000) {
      return "RECOVERY_REQUIRED";
    }
    if (executionDurationMs > 60000 && heartbeatAgeMs > 60000) {
      return "STUCK";
    }
    if (executionDurationMs > 30000) {
      return "SUSPECTED";
    }
    return "NORMAL";
  }
}
