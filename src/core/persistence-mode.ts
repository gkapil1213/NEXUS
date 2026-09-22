// src/core/persistence-mode.ts
// Phase 182: persistence/coordination mode resolution.
//
// The repository ships one durable backend today: SQLite via better-sqlite3,
// with WAL + busy_timeout=5000 (Phase 181). That combination genuinely
// supports multi-process coordination when multiple NEXUS processes share a
// filesystem path to the same database file. This module reports that fact
// truthfully.
//
// A network shared-database backend (Postgres/MySQL/etc.) is NOT implemented
// in this repository: no driver is a declared dependency, and ExecutionStore
// is directly coupled to better-sqlite3 (109 db.prepare() sites, 2634 lines).
// Adding one is a multi-phase architectural change, not a Phase 182 deliverable.
// Attempting NEXUS_PERSISTENCE_MODE=shared fails closed at boot rather than
// silently degrading to SQLite.

export type PersistenceMode = "sqlite" | "shared";
export type CoordinationMode = "single_process" | "multi_process" | "blocked";

export interface PersistenceModeInfo {
  /** The configured backend. "sqlite" | "shared". */
  mode: PersistenceMode;
  /** How many processes can safely coordinate on this backend right now. */
  coordination: CoordinationMode;
  /** Human-readable explanation of the coordination classification. */
  reason: string;
  /** Stable per-process id, when set via NEXUS_INSTANCE_ID. */
  instanceId: string | null;
  /** Concrete shared backend name when mode === "shared" and implemented.
   *  Always null today because no shared backend is implemented. */
  sharedBackend: string | null;
}

function envRead(name: string): string | undefined {
  try {
    if (typeof process === "undefined" || !process.env) return undefined;
    const v = process.env[name];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function resolvePersistenceMode(): PersistenceModeInfo {
  const raw = (envRead("NEXUS_PERSISTENCE_MODE") ?? "sqlite").trim().toLowerCase();
  const instanceId = envRead("NEXUS_INSTANCE_ID") ?? null;

  if (raw === "" || raw === "sqlite") {
    return {
      mode: "sqlite",
      coordination: "multi_process",
      reason:
        "sqlite WAL + busy_timeout=5000 supports real multi-process coordination on a shared filesystem path",
      instanceId,
      sharedBackend: null,
    };
  }

  if (raw === "shared") {
    return {
      mode: "shared",
      coordination: "blocked",
      reason:
        "shared persistence backend not implemented: no network database driver in package.json; " +
        "ExecutionStore is coupled to better-sqlite3 (109 db.prepare sites). " +
        "Multi-host coordination is BLOCKED pending a multi-phase store/backend migration.",
      instanceId,
      sharedBackend: null,
    };
  }

  return {
    mode: "shared",
    coordination: "blocked",
    reason: "unsupported NEXUS_PERSISTENCE_MODE value: " + raw,
    instanceId,
    sharedBackend: null,
  };
}