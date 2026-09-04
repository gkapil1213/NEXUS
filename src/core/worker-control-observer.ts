export interface ObservationResult {
  objectiveAchieved: boolean;
  observedValue?: number;
  expectedValue?: number;
}

export class WorkerControlObserver {
  observe(objectiveTarget: number | undefined, observedValue: number): ObservationResult {
    if (objectiveTarget === undefined) return { objectiveAchieved: true, observedValue };
    return { objectiveAchieved: observedValue <= objectiveTarget, observedValue, expectedValue: objectiveTarget };
  }
}
