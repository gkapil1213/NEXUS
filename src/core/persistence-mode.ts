// src/core/persistence-mode.ts
// Phase 182: persistence/coordination mode resolution.
// Phase 183: extended to recognise a real shared Postgres backend.

import { resolveBackendConfig } from "./backend-config";

export type PersistenceMode = "sqlite" | "shared";
export type CoordinationMode = "single_process" | "multi_process" | "blocked";

export interface PersistenceModeInfo {
  mode: PersistenceMode;
  coordination: CoordinationMode;
  reason: string;
  instanceId: string | null;
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
  const instanceId = envRead("NEXUS_INSTANCE_ID") ?? null;
  const cfg = resolveBackendConfig();

  if (cfg.mode === "sqlite") {
    return {
      mode: "sqlite",
      coordination: "multi_process",
      reason:
        "sqlite WAL + busy_timeout=5000 supports real multi-process coordination on a shared filesystem path",
      instanceId,
      sharedBackend: null,
    };
  }

  if (cfg.mode === "shared" && cfg.valid) {
    return {
      mode: "shared",
      coordination: "multi_process",
      reason:
        "shared " + (cfg.sharedBackend ?? "unknown") +
        " backend configured for cross-instance idempotency and migration coordination; " +
        "ExecutionStore remains local SQLite (Phase 183a boundary)",
      instanceId,
      sharedBackend: cfg.sharedBackend,
    };
  }

  return {
    mode: "shared",
    coordination: "blocked",
    reason: cfg.reason,
    instanceId,
    sharedBackend: cfg.sharedBackend,
  };
}