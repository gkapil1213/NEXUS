import { ObservabilityService } from "./observability-service";
import { nid } from "./db";

export class MetricsAgent {
  constructor(private observability: ObservabilityService) {}

  async collectProcessMetrics(service = "nexus", environment = "local"): Promise<void> {
    const mem = process.memoryUsage();
    const uptime = process.uptime();
    const cpuUsage = process.cpuUsage?.(); // may be undefined in some runtimes

    await this.observability.recordObservation({
      id: nid("metric"),
      source: "process",
      service,
      environment,
      metric: "process_uptime_seconds",
      value: uptime,
      unit: "seconds",
      status: "OBSERVED",
    });

    await this.observability.recordObservation({
      id: nid("metric"),
      source: "process",
      service,
      environment,
      metric: "memory_rss_bytes",
      value: mem.rss,
      unit: "bytes",
      status: "OBSERVED",
    });

    if (cpuUsage) {
      await this.observability.recordObservation({
        id: nid("metric"),
        source: "process",
        service,
        environment,
        metric: "cpu_user_microseconds",
        value: cpuUsage.user,
        unit: "microseconds",
        status: "OBSERVED",
      });
      await this.observability.recordObservation({
        id: nid("metric"),
        source: "process",
        service,
        environment,
        metric: "cpu_system_microseconds",
        value: cpuUsage.system,
        unit: "microseconds",
        status: "OBSERVED",
      });
    }
  }
}