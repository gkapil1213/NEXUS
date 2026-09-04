import Database from "better-sqlite3";

export type HealingEffectiveness =
  | "SUCCESS"
  | "PARTIAL_SUCCESS"
  | "NO_EFFECT"
  | "REGRESSION"
  | "ROLLED_BACK"
  | "UNKNOWN";

export class WorkerHealingEffectiveness {
  constructor(private db: Database.Database) {}

  classify(beforeSli: number, afterSli: number, direction: "increase" | "decrease", rollbackOccurred: boolean): HealingEffectiveness {
    if (!Number.isFinite(beforeSli) || !Number.isFinite(afterSli)) return "UNKNOWN";
    if (rollbackOccurred) return "ROLLED_BACK";
    const delta = afterSli - beforeSli;
    const improved = direction === "increase" ? delta > 0 : delta < 0;
    if (improved) return "SUCCESS";
    if (delta === 0) return "NO_EFFECT";
    return "REGRESSION";
  }

  persist(healingId: string, classification: HealingEffectiveness, confidence: number): void {
    this.db.prepare(`
      INSERT INTO healing_effectiveness (effectiveness_id, healing_id, classification, confidence, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`he_${Date.now()}_${Math.random().toString(36).slice(2)}`, healingId, classification, confidence, JSON.stringify({}), Date.now());
  }
}
