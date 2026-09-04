import Database from "better-sqlite3";

export type JobRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

export interface JobRiskFactors {
  priority?: string;
  retryCount?: number;
  failureCount?: number;
  deadlineAt?: number;
  isRecoveryJob?: boolean;
}

export class JobRisk {
  constructor(private db: Database.Database) {}

  evaluate(jobId: string, factors: JobRiskFactors): { level: JobRiskLevel; reasons: string[] } {
    const reasons: string[] = [];
    let level: JobRiskLevel = "LOW";

    if (factors.isRecoveryJob) {
      // Recovery jobs are critical by definition; risk evaluation still must not deprioritize
      level = "CRITICAL";
      reasons.push("recovery_job");
      return { level, reasons };
    }

    if ((factors.retryCount ?? 0) > 2) {
      reasons.push("high_retry_count");
      level = "HIGH";
    }
    if ((factors.failureCount ?? 0) > 1) {
      reasons.push("previous_failures");
      level = level === "HIGH" ? "CRITICAL" : "MEDIUM";
    }
    if (factors.deadlineAt && Date.now() > factors.deadlineAt) {
      reasons.push("past_deadline");
      level = "CRITICAL";
    }
    if (factors.priority === "CRITICAL") {
      reasons.push("critical_priority");
      if (level === "LOW") level = "MEDIUM";
    }
    return { level, reasons };
  }

  persist(jobId: string, level: JobRiskLevel, reasons: string[]): void {
    this.db.prepare(`
      INSERT INTO job_risk_assessments (assessment_id, job_id, risk_level, factors, evidence, evaluated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `jobrisk_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      jobId,
      level,
      JSON.stringify({}),
      JSON.stringify(reasons),
      Date.now()
    );
  }
}
