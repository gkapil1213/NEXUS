import Database from "better-sqlite3";

export class WorkerCostReliabilityControl {
  constructor(
    private plan: any,
    private executor: any,
    private outcome: any
  ) {}

  run(optimization: any): { status: string; classification: string } {
    const created = this.plan.create(optimization);
    if (!created) return { status: "DUPLICATE", classification: "UNKNOWN" };
    const execStatus = this.executor.execute(optimization.optimizationId);
    let status = "UNAVAILABLE";
    let classification = "UNKNOWN";
    if (execStatus === "UNAVAILABLE") {
      status = "UNAVAILABLE";
      classification = "UNKNOWN";
    }
    return { status, classification };
  }
}
