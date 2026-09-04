export class WorkerChangeContainment {
  evaluate(verification: string, rollbackAllowed: boolean): "STOP" | "ROLLBACK" | "ESCALATE" {
    if (verification === "DEGRADED" && rollbackAllowed) return "ROLLBACK";
    if (verification === "DEGRADED" && !rollbackAllowed) return "ESCALATE";
    return "STOP";
  }
}
