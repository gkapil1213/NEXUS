export type CapacityRiskState = "NORMAL" | "WATCH" | "ELEVATED" | "HIGH" | "CRITICAL" | "INSUFFICIENT_DATA";

export interface CapacityForecast {
  cpuDeficit: number;
  memoryDeficit: number;
  diskDeficit: number;
  concurrencyDeficit: number;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
  dataSufficiency: "SUFFICIENT" | "INSUFFICIENT";
}

export class WorkerPredictiveCapacity {
  forecast(required: { cpu: number; memory: number; disk: number; concurrency: number }, available: { cpu: number; memory: number; disk: number; concurrency: number }, sampleCount: number): CapacityForecast {
    if (sampleCount < 5) {
      return { cpuDeficit: 0, memoryDeficit: 0, diskDeficit: 0, concurrencyDeficit: 0, confidence: "INSUFFICIENT", dataSufficiency: "INSUFFICIENT" };
    }
    return {
      cpuDeficit: Math.max(0, required.cpu - available.cpu),
      memoryDeficit: Math.max(0, required.memory - available.memory),
      diskDeficit: Math.max(0, required.disk - available.disk),
      concurrencyDeficit: Math.max(0, required.concurrency - available.concurrency),
      confidence: "HIGH",
      dataSufficiency: "SUFFICIENT",
    };
  }
}
