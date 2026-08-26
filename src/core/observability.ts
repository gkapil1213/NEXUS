import { nid } from "./db";

export type MetricName =
  | "request_count"
  | "error_count"
  | "error_rate"
  | "latency"
  | "deployment_duration"
  | "deployment_failures"
  | "container_restarts"
  | "health_failures";

export interface MetricRecord {
  id: string;
  name: MetricName;
  value: number;
  tags: Record<string, string>;
  timestamp: number;
}

export interface HealthRecord {
  id: string;
  endpoint: string;
  ok: boolean;
  status_code: number | null;
  response_time_ms: number | null;
  error: string | null;
  timestamp: number;
}

export interface DeploymentEventRecord {
  id: string;
  deployment_id: string;
  environment: string;
  status: string;
  image_digest: string | null;
  timestamp: number;
}

export interface ObservabilitySummary {
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_latency_ms: number;
  health_checks_total: number;
  health_checks_failed: number;
  deployments_total: number;
  deployments_failed: number;
  recent_health: HealthRecord | null;
  recent_deployment: DeploymentEventRecord | null;
}

export class ObservabilityService {
  private metrics: MetricRecord[] = [];
  private healthRecords: HealthRecord[] = [];
  private deploymentEvents: DeploymentEventRecord[] = [];

  recordMetric(name: MetricName, value: number, tags: Record<string, string> = {}): MetricRecord {
    const metric: MetricRecord = {
      id: nid("met"),
      name,
      value,
      tags,
      timestamp: Date.now(),
    };
    this.metrics.push(metric);
    return metric;
  }

  recordHealthCheck(endpoint: string, ok: boolean, statusCode: number | null, responseTimeMs: number | null, error: string | null = null): HealthRecord {
    const health: HealthRecord = {
      id: nid("hlt"),
      endpoint,
      ok,
      status_code: statusCode,
      response_time_ms: responseTimeMs,
      error,
      timestamp: Date.now(),
    };
    this.healthRecords.push(health);
    return health;
  }

  recordDeploymentEvent(deploymentId: string, environment: string, status: string, imageDigest: string | null = null): DeploymentEventRecord {
    const event: DeploymentEventRecord = {
      id: nid("dep"),
      deployment_id: deploymentId,
      environment,
      status,
      image_digest: imageDigest,
      timestamp: Date.now(),
    };
    this.deploymentEvents.push(event);
    return event;
  }

  getMetrics(name?: MetricName): MetricRecord[] {
    if (name) {
      return this.metrics.filter((m) => m.name === name);
    }
    return [...this.metrics];
  }

  getHealthHistory(): HealthRecord[] {
    return [...this.healthRecords].sort((a, b) => b.timestamp - a.timestamp);
  }

  getDeploymentHistory(): DeploymentEventRecord[] {
    return [...this.deploymentEvents].sort((a, b) => b.timestamp - a.timestamp);
  }

  computeSummary(): ObservabilitySummary {
    const requestCount = this.metrics.filter((m) => m.name === "request_count").reduce((sum, m) => sum + m.value, 0);
    const errorCount = this.metrics.filter((m) => m.name === "error_count").reduce((sum, m) => sum + m.value, 0);
    const latencyMetrics = this.metrics.filter((m) => m.name === "latency");
    const avgLatency = latencyMetrics.length > 0 ? latencyMetrics.reduce((sum, m) => sum + m.value, 0) / latencyMetrics.length : 0;

    const healthFailed = this.healthRecords.filter((h) => !h.ok).length;
    const deploymentsFailed = this.deploymentEvents.filter((d) => d.status === "FAILED").length;

    return {
      total_requests: requestCount,
      error_count: errorCount,
      error_rate: requestCount > 0 ? (errorCount / requestCount) * 100 : 0,
      avg_latency_ms: avgLatency,
      health_checks_total: this.healthRecords.length,
      health_checks_failed: healthFailed,
      deployments_total: this.deploymentEvents.length,
      deployments_failed: deploymentsFailed,
      recent_health: this.healthRecords.length > 0 ? this.healthRecords[this.healthRecords.length - 1] : null,
      recent_deployment: this.deploymentEvents.length > 0 ? this.deploymentEvents[this.deploymentEvents.length - 1] : null,
    };
  }
}