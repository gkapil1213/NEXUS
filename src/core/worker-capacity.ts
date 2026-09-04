import Database from "better-sqlite3";

export interface CapacityReservation {
  reservationId: string;
  workerId: string;
  jobId: string;
  leaseId?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  concurrency: number;
  status: "ACTIVE" | "RELEASED" | "EXPIRED" | "CANCELLED";
  createdAt: number;
  expiresAt?: number;
  releasedAt?: number;
}

export class WorkerCapacityService {
  constructor(private db: Database.Database) {}

  reserve(reservation: CapacityReservation): void {
    this.db.prepare(`
      INSERT INTO worker_capacity_reservations (
        reservation_id, worker_id, job_id, lease_id, cpu, memory, disk,
        concurrency, status, created_at, expires_at, released_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reservation.reservationId,
      reservation.workerId,
      reservation.jobId,
      reservation.leaseId,
      reservation.cpu,
      reservation.memory,
      reservation.disk,
      reservation.concurrency,
      reservation.status,
      reservation.createdAt,
      reservation.expiresAt,
      reservation.releasedAt
    );
  }

  release(reservationId: string): void {
    this.db.prepare(`
      UPDATE worker_capacity_reservations SET status = 'RELEASED', released_at = ? WHERE reservation_id = ? AND status = 'ACTIVE'
    `).run(Date.now(), reservationId);
  }

  getActiveForWorker(workerId: string): CapacityReservation[] {
    return this.db.prepare(
      "SELECT * FROM worker_capacity_reservations WHERE worker_id = ? AND status = 'ACTIVE'"
    ).all(workerId).map(this.map);
  }

  getActiveConcurrency(workerId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(concurrency),0) as total FROM worker_capacity_reservations WHERE worker_id = ? AND status = 'ACTIVE'"
    ).get(workerId) as any;
    return row?.total ?? 0;
  }

  getReservedCpu(workerId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(cpu),0) as total FROM worker_capacity_reservations WHERE worker_id = ? AND status = 'ACTIVE'"
    ).get(workerId) as any;
    return row?.total ?? 0;
  }

  getReservedMemory(workerId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(memory),0) as total FROM worker_capacity_reservations WHERE worker_id = ? AND status = 'ACTIVE'"
    ).get(workerId) as any;
    return row?.total ?? 0;
  }

  getReservedDisk(workerId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(disk),0) as total FROM worker_capacity_reservations WHERE worker_id = ? AND status = 'ACTIVE'"
    ).get(workerId) as any;
    return row?.total ?? 0;
  }

  private map(row: any): CapacityReservation {
    return {
      reservationId: row.reservation_id,
      workerId: row.worker_id,
      jobId: row.job_id,
      leaseId: row.lease_id,
      cpu: row.cpu,
      memory: row.memory,
      disk: row.disk,
      concurrency: row.concurrency,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      releasedAt: row.released_at,
    };
  }
}
