import { NexusEngine } from "./db";

export class WorkerDecisionOutcome {
  constructor(private db: NexusEngine) {}

  persist(decisionId: string, classification: string, correlationId?: string): void {
    this.db.prepare(`INSERT INTO unified_decision_outcomes (outcome_id, decision_id, classification, evidence, correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      `outcome_${decisionId}_${Date.now()}`, decisionId, classification, JSON.stringify({}), correlationId, Date.now()
    );
  }
}
