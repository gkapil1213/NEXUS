import Database from "better-sqlite3";

export class WorkerFleetReleaseCoordinator {
  constructor(private db: Database.Database) {}

  promoteWave(releaseId: string, waveNumber: number, components: string[]): boolean {
    try {
      this.db.prepare(`
        INSERT INTO fleet_release_state (release_id, state, current_wave, promoted_workers, updated_at)
        VALUES (?, 'PROMOTING', ?, ?, ?)
      `).run(releaseId, waveNumber, JSON.stringify(components), Date.now());
      return true;
    } catch {
      return false;
    }
  }

  freezeComponent(releaseId: string, component: string): void {
    const row = this.db.prepare("SELECT * FROM fleet_release_state WHERE release_id = ?").get(releaseId) as any;
    if (row) {
      const blocked = row.blocked_workers ? JSON.parse(row.blocked_workers) : [];
      if (!blocked.includes(component)) blocked.push(component);
      this.db.prepare("UPDATE fleet_release_state SET blocked_workers = ?, updated_at = ? WHERE release_id = ?").run(JSON.stringify(blocked), Date.now(), releaseId);
    } else {
      this.db.prepare("INSERT INTO fleet_release_state (release_id, state, current_wave, blocked_workers, updated_at) VALUES (?, 'HELD', 0, ?, ?)").run(releaseId, JSON.stringify([component]), Date.now());
    }
  }

  getState(releaseId: string): any | undefined {
    return this.db.prepare("SELECT * FROM fleet_release_state WHERE release_id = ?").get(releaseId);
  }
}
