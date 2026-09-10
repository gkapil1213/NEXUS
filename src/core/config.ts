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
  // Worker Gateway is opt-in. Default is disabled; kernel.boot() will never
  // open a TCP listener. Server-mode callers set enabled = true then call
  // NexusKernel.startGateway().
  gateway: {
    enabled: boolean;
    port: number;
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
    engine: "sqlite",
    dbName: "nexus.sqlite",
  },
  gateway: {
    enabled: false,
    port: 0,
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
    gateway: {
      enabled: CONFIG.gateway.enabled,
      port: CONFIG.gateway.port,
    },
    issues: [...CONFIG.issues],
  };
}
