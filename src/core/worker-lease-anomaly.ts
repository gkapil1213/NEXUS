import Database from "better-sqlite3";

export type LeaseAnomalyClassification =
  | "EXPIRED_ACTIVE_LEASE"
  | "ORPHAN_LEASE"
  | "WORKER_UNAVAILABLE"
  | "OWNER_MISMATCH"
  | "DUPLICATE_LEASE";

export interface LeaseAnomaly {
  leaseId: string;
  classification: LeaseAnomalyClassification;
  evidence: Record<string, any>;
}

export class WorkerLeaseAnomalyDetector {
  constructor(private db: Database.Database) {}

  detect(): LeaseAnomaly[] {
    const anomalies: LeaseAnomaly[] = [];
    const rows = this.db.prepare(`
      SELECT l.*, j.status as job_status, w.status as worker_status
      FROM execution_leases l
      LEFT JOIN execution_jobs j ON l.job_id = j.id
      LEFT JOIN remote_workers w ON l.worker_id = w.worker_id
    `).all() as any[];

    for (const row of rows) {
      if (row.status === "ACTIVE" && row.expires_at && Date.now() > row.expires_at) {
        anomalies.push({ leaseId: row.lease_id, classification: "EXPIRED_ACTIVE_LEASE", evidence: { lease_id: row.lease_id } });
      }
      if (!row.worker_id || row.worker_status === "REVOKED" || row.worker_status === "OFFLINE") {
        anomalies.push({ leaseId: row.lease_id, classification: "WORKER_UNAVAILABLE", evidence: { worker_id: row.worker_id } });
      }
      if (row.status === "ACTIVE" && row.job_status && row.job_status !== "RUNNING" && row.job_status !== "CLAIMED") {
        anomalies.push({ leaseId: row.lease_id, classification: "OWNER_MISMATCH", evidence: { job_status: row.job_status } });
      }
    }

    // Duplicate lease detection (same job with multiple active)
    const dupRows = this.db.prepare(`
      SELECT job_id, COUNT(*) as cnt FROM execution_leases WHERE status = 'ACTIVE' GROUP BY job_id HAVING cnt > 1
    `).all() as any[];
    for (const dup of dupRows) {
      anomalies.push({ leaseId: `job_${dup.job_id}`, classification: "DUPLICATE_LEASE", evidence: { job_id: dup.job_id } });
    }

    return anomalies;
  }

  persist(anomaly: LeaseAnomaly): void {
    this.db.prepare(`
      INSERT INTO worker_lease_anomalies (anomaly_id, lease_id, classification, evidence, detected_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      `anom_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      anomaly.leaseId,
      anomaly.classification,
      JSON.stringify(anomaly.evidence),
      Date.now()
    );
  }
}
