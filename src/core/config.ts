/**
 * NEXUS configuration — all runtime settings and validation.
 */
export type EngineKind = "memory" | "idb" | "sqlite";
export type NexusEnv = "DEVELOPMENT" | "STAGING" | "PRODUCTION";

export const CONFIG: {
  env: NexusEnv;
  version: string;
  build: string;
  issues: string[];
  sessionTtlMs: number;
  pbkdf2Iterations: number;
  maxRequestChars: number;
  persistence: {
    engine: EngineKind;
    dbName: string;
  };
} = {
  env: "DEVELOPMENT",
  version: "0.1.0",
  build: "local",
  issues: [],
  sessionTtlMs: 8 * 60 * 60 * 1000, // 8 hours
  pbkdf2Iterations: 100_000,
  maxRequestChars: 4_000,
  persistence: {
    engine: "memory",
    dbName: "nexus.sqlite",
  },
};

export function configBlocked(): boolean {
  return CONFIG.issues.some((i) => i.startsWith("BLOCKED:"));
}

export function safeConfigView(): Record<string, unknown> {
  return {
    env: CONFIG.env,
    version: CONFIG.version,
    build: CONFIG.build,
    persistence: {
      engine: CONFIG.persistence.engine,
      dbName: CONFIG.persistence.dbName,
    },
    sessionTtlMs: CONFIG.sessionTtlMs,
    pbkdf2Iterations: CONFIG.pbkdf2Iterations,
    maxRequestChars: CONFIG.maxRequestChars,
    issues: [...CONFIG.issues],
  };
}