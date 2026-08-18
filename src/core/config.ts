/**
 * NEXUS Phase 1 — centralized configuration.
 *
 * Environment-driven, validated at startup. No secrets are ever hardcoded:
 * API keys, database passwords, JWT secrets and provider tokens must come
 * from the environment (or a future SecretProvider integration) and are
 * never echoed into UI/API responses.
 */

export type EnvName = "DEVELOPMENT" | "STAGING" | "PRODUCTION";

export interface NexusConfig {
  env: EnvName;
  version: string;
  build: string;
  dbName: string;
  sessionTtlMs: number;
  pbkdf2Iterations: number;
  maxRequestChars: number;
  issues: string[]; // startup validation findings (safe to display)
}

const env = import.meta.env as Record<string, string | undefined>;

function pickEnv(raw: string | undefined): EnvName {
  const v = (raw ?? "").toUpperCase();
  return v === "PRODUCTION" || v === "STAGING" ? v : "DEVELOPMENT";
}

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function buildConfig(): NexusConfig {
  const issues: string[] = [];
  const envName = pickEnv(env.VITE_NEXUS_ENV);

  if (envName === "PRODUCTION" && !env.VITE_NEXUS_BUILD) {
    issues.push("PRODUCTION environment requires an explicit VITE_NEXUS_BUILD identifier");
  }
  if (env.VITE_NEXUS_PBKDF2_ITERATIONS && Number(env.VITE_NEXUS_PBKDF2_ITERATIONS) < 100_000) {
    issues.push("VITE_NEXUS_PBKDF2_ITERATIONS is below the 100,000 safety floor — using 100,000");
  }

  return {
    env: envName,
    version: env.VITE_NEXUS_VERSION ?? "0.1.0",
    build: env.VITE_NEXUS_BUILD ?? "phase1-foundation",
    dbName: env.VITE_NEXUS_DB_NAME ?? "nexus_platform",
    sessionTtlMs: num(env.VITE_NEXUS_SESSION_TTL_MS, 12 * 3_600_000, 10 * 60_000, 24 * 3_600_000),
    pbkdf2Iterations: num(env.VITE_NEXUS_PBKDF2_ITERATIONS, 150_000, 100_000, 1_000_000),
    maxRequestChars: num(env.VITE_NEXUS_MAX_REQUEST_CHARS, 2000, 100, 20_000),
    issues,
  };
}

export const CONFIG: NexusConfig = buildConfig();

/** Values that are safe to surface in the UI (no secrets by construction). */
export function safeConfigView(): Record<string, unknown> {
  return {
    env: CONFIG.env,
    version: CONFIG.version,
    build: CONFIG.build,
    dbName: CONFIG.dbName,
    sessionTtlHours: Math.round(CONFIG.sessionTtlMs / 3_600_000),
    pbkdf2Iterations: CONFIG.pbkdf2Iterations,
    maxRequestChars: CONFIG.maxRequestChars,
    issues: CONFIG.issues,
  };
}

/** True when config validation found blocking problems for the current env. */
export function configBlocked(): boolean {
  return CONFIG.env === "PRODUCTION" && CONFIG.issues.length > 0;
}
