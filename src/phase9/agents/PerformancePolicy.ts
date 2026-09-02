export interface PerformancePolicy {
  max_p95_latency_ms: number;
  max_p99_latency_ms: number;
  max_error_rate_percent: number;
  min_throughput_rps: number;
  max_cpu_percent: number;
  max_memory_mb: number;
}

export const defaultPolicy: PerformancePolicy = {
  max_p95_latency_ms: 1000,
  max_p99_latency_ms: 2000,
  max_error_rate_percent: 5,
  min_throughput_rps: 1,
  max_cpu_percent: 80,
  max_memory_mb: 512
};
