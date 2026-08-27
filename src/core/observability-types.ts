export type ObservationStatus = "OBSERVED" | "BLOCKED" | "FAIL";

export interface Observation {
  id: string;
  source: string;
  timestamp: string;
  environment: string;
  service: string;
  metric: string;
  value: number;
  unit: string;
  status: ObservationStatus;
  metadata?: Record<string, unknown>;
}

export interface HealthCheckResult {
  id: string;
  target: string;
  timestamp: string;
  status: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN" | "BLOCKED";
  response_time_ms?: number;
  status_code?: number;
  failure_reason?: string;
}

export interface AlertRule {
  id: string;
  metric: string;
  operator: ">" | "<" | ">=" | "<=" | "==" | "!=";
  threshold: number;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  environment: string;
  service: string;
  window_seconds: number;
}

export interface Alert {
  id: string;
  rule_id: string;
  fingerprint: string;
  status: "TRIGGERED" | "ACKNOWLEDGED" | "RESOLVED" | "SUPPRESSED";
  severity: string;
  message: string;
  first_triggered_at: string;
  last_triggered_at: string;
  observations: string[]; // observation ids
}

export interface Incident {
  id: string;
  tenant_id: string;
  environment: string;
  service: string;
  severity: string;
  title: string;
  description: string;
  trigger_alert_id?: string;
  status: "OPEN" | "ACKNOWLEDGED" | "INVESTIGATING" | "MITIGATING" | "RECOVERED" | "RESOLVED" | "CLOSED";
  created_at: string;
  updated_at: string;
  resolved_at?: string;
}