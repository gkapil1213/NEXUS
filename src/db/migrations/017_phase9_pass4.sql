ALTER TABLE reliability_runs ADD COLUMN summary TEXT;
ALTER TABLE reliability_runs ADD COLUMN updated_at TEXT;

CREATE TABLE IF NOT EXISTS reliability_audit_refs (
  id TEXT PRIMARY KEY,
  reliability_run_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reliability_run_id) REFERENCES reliability_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_reliability_runs_status ON reliability_runs(status);
CREATE INDEX IF NOT EXISTS idx_reliability_runs_created_at ON reliability_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_performance_runs_run_id ON performance_runs(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_load_test_runs_run_id ON load_test_runs(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_stress_test_runs_run_id ON stress_test_runs(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_failure_injections_run_id ON failure_injections(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_recovery_runs_run_id ON recovery_runs(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_slo_evaluations_run_id ON slo_evaluations(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_error_budget_run_id ON error_budget_snapshots(reliability_run_id);
CREATE INDEX IF NOT EXISTS idx_performance_regressions_run_id ON performance_regressions(reliability_run_id);
