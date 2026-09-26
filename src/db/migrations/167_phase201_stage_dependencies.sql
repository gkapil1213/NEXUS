-- 167_phase201_stage_dependencies.sql
-- Phase 201: canonical dependency edges for stage execution graphs.
--
-- One row per directed edge (stage_name depends_on depends_on_stage) inside
-- an execution. Stages are existing execution_jobs rows with
-- job_type = 'pipeline.stage' (see stage-execution-store-adapter.ts); this
-- migration does not introduce a new stage table.
--
-- Enforced at DB layer:
--   - (execution_id, stage_name, depends_on_stage) is the identity
--   - self-dependency is rejected by CHECK
-- Enforced at application layer (validateStageGraph):
--   - cross-execution references
--   - cycles (via worker-recovery-dependency.detectCycle)
--   - missing declared stages

CREATE TABLE IF NOT EXISTS execution_stage_dependencies (
  execution_id     TEXT NOT NULL,
  stage_name       TEXT NOT NULL,
  depends_on_stage TEXT NOT NULL,
  created_at       BIGINT NOT NULL,
  PRIMARY KEY (execution_id, stage_name, depends_on_stage),
  CHECK (stage_name <> depends_on_stage)
);

CREATE INDEX IF NOT EXISTS idx_stage_deps_exec_stage
  ON execution_stage_dependencies (execution_id, stage_name);

CREATE INDEX IF NOT EXISTS idx_stage_deps_exec_dep
  ON execution_stage_dependencies (execution_id, depends_on_stage);