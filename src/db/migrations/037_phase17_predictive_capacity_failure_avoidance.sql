-- Phase 17.16: Global Workload Intelligence, Predictive Capacity & Autonomous Failure Avoidance
CREATE TABLE IF NOT EXISTS worker_workload_observations (
  observation_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  queue_depth INTEGER,
  jobs_created INTEGER,
  jobs_admitted INTEGER,
  jobs_deferred INTEGER,
  jobs_rejected INTEGER,
  jobs_completed INTEGER,
  jobs_failed INTEGER,
  cpu_demand REAL,
  memory_demand REAL,
  disk_demand REAL,
  concurrency_demand INTEGER,
  data_quality TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_predictions (
  prediction_id TEXT PRIMARY KEY,
  prediction_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  horizon_ms INTEGER,
  predicted_state TEXT,
  confidence TEXT,
  data_quality TEXT,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_prediction_outcomes (
  outcome_id TEXT PRIMARY KEY,
  prediction_id TEXT NOT NULL,
  actual_state TEXT,
  correctness TEXT,
  error_magnitude REAL,
  false_positive INTEGER DEFAULT 0,
  false_negative INTEGER DEFAULT 0,
  observed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (prediction_id) REFERENCES worker_predictions(prediction_id)
);

CREATE TABLE IF NOT EXISTS worker_prediction_quality (
  quality_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  state TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_predictive_control_recommendations (
  recommendation_id TEXT PRIMARY KEY,
  recommendation_type TEXT NOT NULL,
  target_id TEXT,
  risk_level TEXT,
  confidence TEXT,
  policy_version INTEGER,
  state TEXT NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workload_observations_window ON worker_workload_observations(window_start);
CREATE INDEX IF NOT EXISTS idx_predictions_type_created ON worker_predictions(prediction_type, created_at);
CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_prediction ON worker_prediction_outcomes(prediction_id);
CREATE INDEX IF NOT EXISTS idx_predictive_recommendations_state ON worker_predictive_control_recommendations(state);
