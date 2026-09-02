export interface SLOConfig {
  availability_target_percent: number;
  latency_p95_target_ms: number;
  error_rate_target_percent: number;
  throughput_target_rps: number;
}

export interface SLOEvaluation {
  availability_percent: number;
  latency_p95_ms: number;
  error_rate_percent: number;
  throughput_rps: number;
  slo_met: boolean;
}

export class SLOAgent {
  evaluate(config: SLOConfig, metrics: any): SLOEvaluation {
    const availability = ((metrics.success / metrics.totalRequests) * 100) || 0;
    const latencyP95 = metrics.latency.p95;
    const errorRate = metrics.errorRate;
    const throughput = metrics.throughput;

    const slo_met =
      availability >= config.availability_target_percent &&
      latencyP95 <= config.latency_p95_target_ms &&
      errorRate <= config.error_rate_target_percent &&
      throughput >= config.throughput_target_rps;

    return {
      availability_percent: availability,
      latency_p95_ms: latencyP95,
      error_rate_percent: errorRate,
      throughput_rps: throughput,
      slo_met
    };
  }
}
