export type DomainConcentrationState = "SAFE" | "WARNING" | "CRITICAL" | "INSUFFICIENT_DATA";

export class WorkerFailureDomainPrediction {
  evaluate(domainLoad: number, totalLoad: number, sampleCount: number): DomainConcentrationState {
    if (sampleCount < 5) return "INSUFFICIENT_DATA";
    if (totalLoad === 0) return "SAFE";
    const concentration = domainLoad / totalLoad;
    if (concentration > 0.7) return "CRITICAL";
    if (concentration > 0.5) return "WARNING";
    return "SAFE";
  }
}
