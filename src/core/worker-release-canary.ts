export class WorkerReleaseCanary {
  evaluate(cohort: number, healthy: boolean, baselineGood: boolean): "PROMOTE" | "HOLD" | "PAUSE" | "ROLLBACK" {
    if (!healthy || !baselineGood) return "ROLLBACK";
    if (cohort < 0.5 && healthy && baselineGood) return "PROMOTE";
    return "HOLD";
  }
}
