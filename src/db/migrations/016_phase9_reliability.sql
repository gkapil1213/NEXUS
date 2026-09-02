CREATE TABLE IF NOT EXISTS reliability_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  execution_id TEXT,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  environment TEXT DEFAULT 'local',
  trigger TEXT DEFAULT 'manual',
  git_commit TEXT,
  version TEXT,
  gate_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS performance_baselines (
  id TEXT PRIMARY KEY,
  reliability_run_id TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  memory_rss INTEGER,
  cpu_count INTEGER,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (reliability_run_id) REFERENCES reliability_runs(id)
);

CREATE TABLE IF NOT EXISTS performance_runs (
  id TEXT PRIMARY KEY,
  reliability_run_id TEXT NOT NULL,
  total_requests INTEGER NOT NULL,
  successful_requests INTEGER NOT NULL,
  failed_requests INTEGER NOT NULL,
  error_rate REAL NOT NULL,
  throughput REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  p50 REAL,
  p90 REAL,
  p95 REAL,
  p99 REAL,
  min_latency REAL,
  max_latency REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reliability_run_id) REFERENCES reliability_runs(id)
);

CREATE TABLE IF NOT EXISTS load_test_runs (
  id TEXT PRIMARY KEY,
  reliability_run_id TEXT NOT NULL,
  concurrency INTEGER NOT NULL,
  total_requests INTEGER NOT NULL,
  success INTEGER NOT NULL,
  failure INTEGER NOT NULL,
  throughput REAL,
  p50 REAL,
  p90 REAL,
  p95 REAL,
  p99 REAL,
  error_rate REAL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reliability_run_id) REFERENCES reliability_runs(id)
);

CREATE TABLE IF NOT EXISTS stress_test_runs (
  id TEXT PRIMARY KEY,
  reliability_run_id TEXT NOT NULL,
  concurrency INTEGER NOT NULL,
  total_requests INTEGER,
  success INTEGER,
  failure INTEGER,
  throughput REAL,
  p50 REAL,
  p90 REAL,
  p95 REAL,
  p99 REAL,
  error_rate REAL,
  breaking_point INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reliability_run_id) REFERENCES reliability_runs(id)
);

CREATE TABLE IF NOT EXISTS failure_injections (
  id TEXT PRIMARY KEY,
  reliability_run_id TEXT NOT NULL,
  failure_type TEXT NOT NULL,
  target TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status_before TEXT,
  status_during TEXT,
  status_after TEXT,
  recovered INTEGER,
  evidence TEXT,
  FOREIGN KEY (reliability_run_id) REFERENCES reliability_runs(id)
);

CREATE TABLE IF NOT EXISTS recovery_runs (
  id TEXT PRIMARY KEY,
  reliability_run_id TEXT NOT NULL,
  health_before_failure INTEGER,
  failure_detected_at TEXT,
  recovery_started_at TEXT,
  recovered_at TEXT,
  recovery_duration_ms INTEGER,
  recovery_status TEXT NOT NULL,
  FOREIGN KEY (reliability_run_id) REFERENCES reliability_runs(id)
);

CREATE TABLE IF NOT EXISTS slo_evaluations (
  id TEXT PRIMARY KEY,
  reliability_run_id TEXT NOT NULL,
  availability_percent REAL,
  latency_p95_ms REAL,
  error_rate_percent REAL,
  throughput_rps REAL,
  availability_target REAL,
  latency_target REAL,
  error_rate_target REAL,
  throughput_target REAL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reliability_run_id) REFERENCES reliability_runs(id)
);

CREATE TABLE IF NOT EXISTS error_budget_snapshots (
  id TEXT PRIMARY KEY,
  reliability_run_id TEXT NOT NULL,
  allowed_errors INTEGER,
  observed_errors INTEGER,
  remaining_budget INTEGER,
  budget_consumed_percent REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reliability_run_id) REFERENCES reliability_runs(id)
);

CREATE TABLE IF NOT EXISTS performance_regressions (
  id TEXT PRIMARY KEY,
  reliability_run_id TEXT NOT NULL,
  baseline_run_id TEXT,
  metric_name TEXT NOT NULL,
  baseline_value REAL,
  current_value REAL,
  percentage_change REAL,
  threshold REAL,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reliability_run_id) REFERENCES reliability_runs(id)
);

CREATE TABLE IF NOT EXISTS reliability_event_refs (
  id TEXT PRIMARY KEY,
  reliability_run_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reliability_run_id) REFERENCES reliability_runs(id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  data TEXT
);

CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT,
  resource TEXT,
  result TEXT,
  metadata TEXT,
  timestamp TEXT NOT NULL,
  reliability_run_id TEXT
);
