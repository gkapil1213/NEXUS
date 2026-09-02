import { db } from './relationalDb';
import { randomUUID } from 'crypto';

// ---------- State Machine ----------
const VALID_TRANSITIONS: Record<string, string[]> = {
  'CREATED': ['RUNNING'],
  'RUNNING': ['DEGRADED', 'FAILED', 'COMPLETED', 'BLOCKED'],
  'DEGRADED': ['COMPLETED', 'FAILED'],
  'FAILED': [],
  'COMPLETED': [],
  'BLOCKED': []
};
export function isValidTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
export function updateReliabilityRunStatus(id: string, newStatus: string) {
  const current = db.prepare('SELECT status FROM reliability_runs WHERE id = ?').get(id) as any;
  if (!current) throw new Error('Reliability run not found');
  if (!isValidTransition(current.status, newStatus)) {
    throw new Error(`Invalid status transition: ${current.status} -> ${newStatus}`);
  }
  db.prepare('UPDATE reliability_runs SET status = ?, updated_at = ? WHERE id = ?')
    .run(newStatus, new Date().toISOString(), id);
}

// ---------- Insert Functions ----------
export function insertReliabilityRun(run: any) {
  db.prepare(`INSERT INTO reliability_runs (id, project_id, execution_id, status, started_at, completed_at, duration_ms, environment, trigger, git_commit, version, gate_status, summary, created_at, updated_at)
    VALUES (@id, @project_id, @execution_id, @status, @started_at, @completed_at, @duration_ms, @environment, @trigger, @git_commit, @version, @gate_status, @summary, @created_at, @updated_at)`).run(run);
}
export function updateReliabilityRun(id: string, updates: any) {
  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE reliability_runs SET ${fields}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...updates, id, updated_at: new Date().toISOString() });
}
export function insertBaseline(baseline: any) {
  db.prepare(`INSERT INTO performance_baselines (id, reliability_run_id, status_code, latency_ms, memory_rss, cpu_count, timestamp)
    VALUES (@id, @reliability_run_id, @status_code, @latency_ms, @memory_rss, @cpu_count, @timestamp)`).run(baseline);
}
export function insertPerformance(perf: any) {
  db.prepare(`INSERT INTO performance_runs (id, reliability_run_id, total_requests, successful_requests, failed_requests, error_rate, throughput, duration_ms, p50, p90, p95, p99, min_latency, max_latency, created_at)
    VALUES (@id, @reliability_run_id, @total_requests, @successful_requests, @failed_requests, @error_rate, @throughput, @duration_ms, @p50, @p90, @p95, @p99, @min_latency, @max_latency, @created_at)`).run(perf);
}
export function insertLoadTest(load: any) {
  db.prepare(`INSERT INTO load_test_runs (id, reliability_run_id, concurrency, total_requests, success, failure, throughput, p50, p90, p95, p99, error_rate, duration_ms, created_at)
    VALUES (@id, @reliability_run_id, @concurrency, @total_requests, @success, @failure, @throughput, @p50, @p90, @p95, @p99, @error_rate, @duration_ms, @created_at)`).run(load);
}
export function insertStressLevel(stress: any) {
  db.prepare(`INSERT INTO stress_test_runs (id, reliability_run_id, concurrency, total_requests, success, failure, throughput, p50, p90, p95, p99, error_rate, breaking_point, created_at)
    VALUES (@id, @reliability_run_id, @concurrency, @total_requests, @success, @failure, @throughput, @p50, @p90, @p95, @p99, @error_rate, @breaking_point, @created_at)`).run(stress);
}
export function insertFailureInjection(failure: any) {
  db.prepare(`INSERT INTO failure_injections (id, reliability_run_id, failure_type, target, started_at, ended_at, duration_ms, status_before, status_during, status_after, recovered, evidence)
    VALUES (@id, @reliability_run_id, @failure_type, @target, @started_at, @ended_at, @duration_ms, @status_before, @status_during, @status_after, @recovered, @evidence)`).run(failure);
}
export function insertRecovery(recovery: any) {
  db.prepare(`INSERT INTO recovery_runs (id, reliability_run_id, health_before_failure, failure_detected_at, recovery_started_at, recovered_at, recovery_duration_ms, recovery_status)
    VALUES (@id, @reliability_run_id, @health_before_failure, @failure_detected_at, @recovery_started_at, @recovered_at, @recovery_duration_ms, @recovery_status)`).run(recovery);
}
export function insertSLOEvaluation(slo: any) {
  db.prepare(`INSERT INTO slo_evaluations (id, reliability_run_id, availability_percent, latency_p95_ms, error_rate_percent, throughput_rps, availability_target, latency_target, error_rate_target, throughput_target, result, created_at)
    VALUES (@id, @reliability_run_id, @availability_percent, @latency_p95_ms, @error_rate_percent, @throughput_rps, @availability_target, @latency_target, @error_rate_target, @throughput_target, @result, @created_at)`).run(slo);
}
export function insertErrorBudget(budget: any) {
  db.prepare(`INSERT INTO error_budget_snapshots (id, reliability_run_id, allowed_errors, observed_errors, remaining_budget, budget_consumed_percent, created_at)
    VALUES (@id, @reliability_run_id, @allowed_errors, @observed_errors, @remaining_budget, @budget_consumed_percent, @created_at)`).run(budget);
}
export function insertRegression(reg: any) {
  db.prepare(`INSERT INTO performance_regressions (id, reliability_run_id, baseline_run_id, metric_name, baseline_value, current_value, percentage_change, threshold, decision, created_at)
    VALUES (@id, @reliability_run_id, @baseline_run_id, @metric_name, @baseline_value, @current_value, @percentage_change, @threshold, @decision, @created_at)`).run(reg);
}
export function insertEventRef(ref: any) {
  db.prepare(`INSERT INTO reliability_event_refs (id, reliability_run_id, event_id, created_at) VALUES (@id, @reliability_run_id, @event_id, @created_at)`).run(ref);
}
export function insertAuditRef(ref: any) {
  db.prepare(`INSERT INTO reliability_audit_refs (id, reliability_run_id, audit_id, created_at) VALUES (@id, @reliability_run_id, @audit_id, @created_at)`).run(ref);
}

// ---------- Query Functions ----------
export function getRunById(id: string): any {
  return db.prepare('SELECT * FROM reliability_runs WHERE id = ?').get(id);
}
export function getRuns(limit = 20, offset = 0, filters: any = {}): any[] {
  let query = 'SELECT * FROM reliability_runs';
  const conditions: string[] = [];
  const params: any[] = [];
  if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
  if (filters.environment) { conditions.push('environment = ?'); params.push(filters.environment); }
  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(query).all(...params);
}
export function getBaseline(runId: string): any[] {
  return db.prepare('SELECT * FROM performance_baselines WHERE reliability_run_id = ?').all(runId);
}
export function getPerformance(runId: string): any[] {
  return db.prepare('SELECT * FROM performance_runs WHERE reliability_run_id = ?').all(runId);
}
export function getLoad(runId: string): any[] {
  return db.prepare('SELECT * FROM load_test_runs WHERE reliability_run_id = ? ORDER BY concurrency').all(runId);
}
export function getStress(runId: string): any[] {
  return db.prepare('SELECT * FROM stress_test_runs WHERE reliability_run_id = ? ORDER BY concurrency').all(runId);
}
export function getFailures(runId: string): any[] {
  return db.prepare('SELECT * FROM failure_injections WHERE reliability_run_id = ?').all(runId);
}
export function getRecovery(runId: string): any[] {
  return db.prepare('SELECT * FROM recovery_runs WHERE reliability_run_id = ?').all(runId);
}
export function getSLO(runId: string): any[] {
  return db.prepare('SELECT * FROM slo_evaluations WHERE reliability_run_id = ?').all(runId);
}
export function getErrorBudget(runId: string): any[] {
  return db.prepare('SELECT * FROM error_budget_snapshots WHERE reliability_run_id = ?').all(runId);
}
export function getRegression(runId: string): any[] {
  return db.prepare('SELECT * FROM performance_regressions WHERE reliability_run_id = ?').all(runId);
}
export function getPerformanceHistory(limit = 10): any[] {
  return db.prepare('SELECT * FROM performance_runs ORDER BY created_at DESC LIMIT ?').all(limit);
}

export { db };
