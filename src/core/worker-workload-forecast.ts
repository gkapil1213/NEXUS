import Database from "better-sqlite3";

export type WorkloadForecastState = "STABLE" | "GROWING" | "SURGING" | "DECLINING" | "UNKNOWN" | "INSUFFICIENT_DATA";

export interface WorkloadForecast {
  state: WorkloadForecastState;
  queueDepth: number;
  growthRate: number;
  evidence: Record<string, any>;
}

export class WorkerWorkloadForecast {
  constructor(private db: Database.Database) {}

  evaluate(currentQueueDepth: number, previousQueueDepth?: number): WorkloadForecast {
    if (previousQueueDepth === undefined) {
      return {
        state: "INSUFFICIENT_DATA",
        queueDepth: currentQueueDepth,
        growthRate: 0,
        evidence: { reason: "no_previous_data" },
      };
    }

    const growthRate = currentQueueDepth - previousQueueDepth;
    let state: WorkloadForecastState = "STABLE";
    if (growthRate > 20) state = "SURGING";
    else if (growthRate > 5) state = "GROWING";
    else if (growthRate < -5) state = "DECLINING";

    return {
      state,
      queueDepth: currentQueueDepth,
      growthRate,
      evidence: { previousQueueDepth, currentQueueDepth, growthRate },
    };
  }

  persist(forecast: WorkloadForecast, correlationId?: string): void {
    this.db.prepare(`
      INSERT INTO worker_workload_forecasts (forecast_id, state, queue_depth, growth_rate, evidence, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `forecast_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      forecast.state,
      forecast.queueDepth,
      forecast.growthRate,
      JSON.stringify(forecast.evidence),
      correlationId,
      Date.now()
    );
  }
}
