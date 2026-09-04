import Database from "better-sqlite3";
import { WorkerLearningConfidence } from "./worker-learning-confidence";

export class WorkerAdaptiveLearning {
  constructor(private db: Database.Database, private confidence: WorkerLearningConfidence) {}

  ingestOutcome(outcome: {
    outcomeId: string;
    objectiveId: string;
    expectedImprovement: number;
    actualImprovement: number;
  }): void {
    const success = outcome.actualImprovement >= outcome.expectedImprovement ? 1 : 0;
    this.db.prepare(`
      INSERT INTO worker_learning_outcomes (
        outcome_id, objective_id, expected_improvement, actual_improvement, success, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      outcome.outcomeId,
      outcome.objectiveId,
      outcome.expectedImprovement,
      outcome.actualImprovement,
      success,
      JSON.stringify({}),
      Date.now()
    );
  }

  getSuccessRate(objectiveId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(success),0) as s, COUNT(*) as c FROM worker_learning_outcomes WHERE objective_id = ?
    `).get(objectiveId) as any;
    if (!row || row.c === 0) return 0;
    return row.s / row.c;
  }

  proposeAdaptation(parameterPath: string, current: number, delta: number, sampleCount: number, consistency: number, predictionConfidence: number): { accept: boolean; newValue: number; reason: string } {
    const confidence = this.confidence.evaluate(sampleCount, consistency, predictionConfidence);
    if (confidence === "INSUFFICIENT" || confidence === "LOW") {
      return { accept: false, newValue: current, reason: "insufficient_learning_confidence" };
    }
    const param = this.db.prepare("SELECT * FROM worker_adaptation_parameters WHERE parameter_path = ?").get(parameterPath) as any;
    if (!param) return { accept: false, newValue: current, reason: "parameter_not_found" };
    const maxDelta = param.max_delta;
    const newValue = Math.min(param.max_value, Math.max(param.min_value, current + Math.max(-maxDelta, Math.min(maxDelta, delta))));
    return { accept: true, newValue, reason: "bounded_adaptation" };
  }

  applyAdaptation(event: {
    eventId: string;
    parameterPath: string;
    oldValue: number;
    newValue: number;
    reason: string;
    policyVersion: number;
    learningVersion: number;
    correlationId?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO worker_adaptation_events (
        event_id, parameter_path, old_value, new_value, reason, confidence,
        policy_version, learning_version, correlation_id, created_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.parameterPath,
      event.oldValue,
      event.newValue,
      event.reason,
      0.0,
      event.policyVersion,
      event.learningVersion,
      event.correlationId,
      Date.now(),
      event.eventId
    );
    this.db.prepare("UPDATE worker_adaptation_parameters SET current_value = ?, updated_at = ? WHERE parameter_path = ?").run(event.newValue, Date.now(), event.parameterPath);
  }
}
