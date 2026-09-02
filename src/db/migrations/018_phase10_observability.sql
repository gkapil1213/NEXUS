CREATE TABLE IF NOT EXISTS observability_metrics (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  service TEXT,
  environment TEXT,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  unit TEXT,
  source TEXT,
  metadata TEXT,
  execution_id TEXT,
  deployment_id TEXT,
  trace_id TEXT
);

CREATE TABLE IF NOT EXISTS observability_logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  level TEXT,
  service TEXT,
  message TEXT,
  execution_id TEXT,
  deployment_id TEXT,
  trace_id TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS service_health (
  id TEXT PRIMARY KEY,
  service TEXT,
  environment TEXT,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  evidence TEXT
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  condition TEXT,
  severity TEXT,
  service TEXT,
  enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  alert_rule_id TEXT,
  fingerprint TEXT,
  severity TEXT,
  status TEXT NOT NULL,
  service TEXT,
  environment TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  occurrence_count INTEGER DEFAULT 1,
  metadata TEXT,
  incident_id TEXT
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  title TEXT,
  severity TEXT,
  service TEXT,
  environment TEXT,
  status TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  impact TEXT,
  root_cause_analysis_id TEXT,
  remediation_action_id TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS incident_evidence (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  source TEXT,
  timestamp TEXT NOT NULL,
  reference TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS root_cause_analyses (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  classification TEXT,
  confidence REAL,
  evidence TEXT,
  alternative_hypotheses TEXT,
  recommended_action TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remediation_actions (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  action_type TEXT,
  status TEXT NOT NULL,
  risk_level TEXT,
  proposed_at TEXT NOT NULL,
  executed_at TEXT,
  verification_result TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS remediation_approvals (
  id TEXT PRIMARY KEY,
  remediation_action_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  approver TEXT,
  reason TEXT,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON observability_metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON observability_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_alerts_fingerprint ON alerts(fingerprint);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_evidence_incident ON incident_evidence(incident_id);
