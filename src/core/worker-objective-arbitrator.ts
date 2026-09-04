import { WorkerObjectiveEngine } from "./worker-objective-engine";

export class WorkerObjectiveArbitrator {
  constructor(private objectiveEngine: WorkerObjectiveEngine) {}

  arbitrate(): { priorityObjectiveId: string; hardConstraints: string[] } {
    const objectives = this.objectiveEngine.getActiveObjectives();
    const hard = objectives.filter(o => o.hardConstraint).map(o => o.objectiveId);
    const sorted = [...objectives].sort((a, b) => a.priority - b.priority);
    return {
      priorityObjectiveId: sorted.length > 0 ? sorted[0].objectiveId : "",
      hardConstraints: hard,
    };
  }
}
