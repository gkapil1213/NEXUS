import { WorkerObjectiveEngine } from "./worker-objective-engine";

export interface ScoreInput {
  observations: Record<string, number>;
  predictionConfidence: number;
  workerRisk: number;
  fleetResilience: number;
  controlStability: number;
  missingDataPenalty: number;
}

export class WorkerObjectiveScore {
  constructor(private objectiveEngine: WorkerObjectiveEngine) {}

  calculate(input: ScoreInput): Record<string, number> {
    const objectives = this.objectiveEngine.getActiveObjectives();
    const scores: Record<string, number> = {};
    for (const obj of objectives) {
      const observed = input.observations[obj.objectiveId];
      if (observed === undefined) {
        scores[obj.objectiveId] = Number.NaN;
        continue;
      }
      let score = observed;
      if (obj.direction === "minimize") score = -observed;
      score *= obj.weight;
      if (!Number.isFinite(score)) score = 0;
      scores[obj.objectiveId] = score;
    }
    return scores;
  }

  overallScore(scores: Record<string, number>): number {
    let total = 0;
    for (const key of Object.keys(scores)) {
      const value = scores[key];
      if (!Number.isFinite(value)) continue;
      total += value;
    }
    return total;
  }
}
