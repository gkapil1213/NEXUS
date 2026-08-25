/**
 * NEXUS Phase 1 — centralized configuration.
 *
 * Runtime targets:
 *   1. Vite/browser
 *   2. Node/tsx host verification
 *
 * Design rules:
 *   - No secrets are stored here.
 *   - No direct dependency on the Node `process` type.
 *   - Browser and Node environment access are resolved safely.
 *   - Existing public configuration API is preserved.
 */

export type EnvName =
  | "DEVELOPMENT"
  | "STAGING"
  | "PRODUCTION";

export interface NexusConfig {
  env: EnvName;
  version: string;
  build: string;
  dbName: string;
  sessionTtlMs: number;
  pbkdf2Iterations: number;
  maxRequestChars: number;
  githubApi: string;
  issues: string[];
}

/**
 * Minimal runtime representation of Node's process object.
 *
 * We intentionally define only what this module needs instead of
 * importing Node typings into the browser/shared codebase.
 */
interface RuntimeProcess {
  env?: Record<string, string | undefined>;
}

/**
 * Safely access a possible Node process object.
 *
 * `globalThis.process` is intentionally used instead of the bare
 * `process` identifier so TypeScript does not require @types/node.
 */
function getNodeEnv(): Record<string, string | undefined> | undefined {
  const runtimeGlobal = globalThis as typeof globalThis & {
    process?: RuntimeProcess;
  };

  return runtimeGlobal.process?.env;
}

/**
 * Safely access Vite's import.meta.env.
 *
 * Vite provides this object during browser builds.
 *
 * Node/tsx does not normally provide Vite environment variables,
 * so this function deliberately falls back to Node's environment.
 */
function getViteEnv(): Record<string, string | undefined> | undefined {
  try {
    const candidate = import.meta.env;

    if (
      candidate &&
      typeof candidate === "object"
    ) {
      return candidate as Record<
        string,
        string | undefined
      >;
    }
  } catch {
    // Expected in non-Vite host execution.
  }

  return undefined;
}

/**
 * Resolve environment variables from the active runtime.
 *
 * Priority:
 *
 *   Vite/browser environment
 *          ↓
 *   Node host environment
 *
 * The result contains configuration values only.
 * Secrets must never be placed here.
 */
function getRuntimeEnv(): Record<string, string | undefined> {
  const viteEnv = getViteEnv();
  const nodeEnv = getNodeEnv();

  return {
    VITE_NEXUS_ENV:
      viteEnv?.VITE_NEXUS_ENV ??
      nodeEnv?.VITE_NEXUS_ENV,

    VITE_NEXUS_VERSION:
      viteEnv?.VITE_NEXUS_VERSION ??
      nodeEnv?.VITE_NEXUS_VERSION,

    VITE_NEXUS_BUILD:
      viteEnv?.VITE_NEXUS_BUILD ??
      nodeEnv?.VITE_NEXUS_BUILD,

    VITE_NEXUS_DB_NAME:
      viteEnv?.VITE_NEXUS_DB_NAME ??
      nodeEnv?.VITE_NEXUS_DB_NAME,

    VITE_NEXUS_SESSION_TTL_MS:
      viteEnv?.VITE_NEXUS_SESSION_TTL_MS ??
      nodeEnv?.VITE_NEXUS_SESSION_TTL_MS,

    VITE_NEXUS_PBKDF2_ITERATIONS:
      viteEnv?.VITE_NEXUS_PBKDF2_ITERATIONS ??
      nodeEnv?.VITE_NEXUS_PBKDF2_ITERATIONS,

    VITE_NEXUS_MAX_REQUEST_CHARS:
      viteEnv?.VITE_NEXUS_MAX_REQUEST_CHARS ??
      nodeEnv?.VITE_NEXUS_MAX_REQUEST_CHARS,

    VITE_NEXUS_GITHUB_API:
      viteEnv?.VITE_NEXUS_GITHUB_API ??
      nodeEnv?.VITE_NEXUS_GITHUB_API,
  };
}

const env = getRuntimeEnv();

/**
 * Convert arbitrary environment text into a supported NEXUS
 * environment without trusting invalid input.
 */
function pickEnv(raw: string | undefined): EnvName {
  const value = (raw ?? "").trim().toUpperCase();

  switch (value) {
    case "PRODUCTION":
      return "PRODUCTION";

    case "STAGING":
      return "STAGING";

    case "DEVELOPMENT":
    default:
      return "DEVELOPMENT";
  }
}

/**
 * Parse a bounded numeric configuration value.
 *
 * Invalid, NaN, infinite, or out-of-range values are safely
 * converted to the supplied fallback/bounds.
 */
function num(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(
    max,
    Math.max(min, value),
  );
}

/**
 * Build the immutable runtime configuration.
 */
function buildConfig(): NexusConfig {
  const issues: string[] = [];

  const envName = pickEnv(
    env.VITE_NEXUS_ENV,
  );

  /**
   * Production builds must have an explicit build identifier.
   *
   * This prevents an ambiguous production deployment from being
   * represented as the default development build.
   */
  if (
    envName === "PRODUCTION" &&
    !env.VITE_NEXUS_BUILD?.trim()
  ) {
    issues.push(
      "PRODUCTION environment requires an explicit VITE_NEXUS_BUILD identifier",
    );
  }

  /**
   * PBKDF2 security floor.
   *
   * We do not allow configuration to silently lower this security
   * boundary.
   */
  if (
    env.VITE_NEXUS_PBKDF2_ITERATIONS !== undefined &&
    Number.isFinite(
      Number(
        env.VITE_NEXUS_PBKDF2_ITERATIONS,
      ),
    ) &&
    Number(
      env.VITE_NEXUS_PBKDF2_ITERATIONS,
    ) < 100_000
  ) {
    issues.push(
      "VITE_NEXUS_PBKDF2_ITERATIONS is below the 100,000 safety floor — using 100,000",
    );
  }

  return {
    env: envName,

    version:
      env.VITE_NEXUS_VERSION?.trim() ||
      "0.1.0",

    build:
      env.VITE_NEXUS_BUILD?.trim() ||
      "phase1-foundation",

    dbName:
      env.VITE_NEXUS_DB_NAME?.trim() ||
      "nexus_platform",

    sessionTtlMs: num(
      env.VITE_NEXUS_SESSION_TTL_MS,
      12 * 3_600_000,
      10 * 60_000,
      24 * 3_600_000,
    ),

    pbkdf2Iterations: num(
      env.VITE_NEXUS_PBKDF2_ITERATIONS,
      150_000,
      100_000,
      1_000_000,
    ),

    maxRequestChars: num(
      env.VITE_NEXUS_MAX_REQUEST_CHARS,
      2_000,
      100,
      20_000,
    ),

    githubApi:
      env.VITE_NEXUS_GITHUB_API?.trim() ||
      "https://api.github.com",

    issues,
  };
}

/**
 * Single centralized NEXUS configuration instance.
 */
export const CONFIG: NexusConfig =
  buildConfig();

/**
 * Safe configuration representation for diagnostics/UI.
 *
 * No credentials or secret values are included.
 */
export function safeConfigView(): Record<
  string,
  unknown
> {
  return {
    env: CONFIG.env,
    version: CONFIG.version,
    build: CONFIG.build,
    dbName: CONFIG.dbName,

    sessionTtlHours: Math.round(
      CONFIG.sessionTtlMs /
        3_600_000,
    ),

    pbkdf2Iterations:
      CONFIG.pbkdf2Iterations,

    maxRequestChars:
      CONFIG.maxRequestChars,

    issues: [
      ...CONFIG.issues,
    ],
  };
}

/**
 * Production configuration is considered blocked when
 * mandatory production configuration issues exist.
 */
export function configBlocked(): boolean {
  return (
    CONFIG.env === "PRODUCTION" &&
    CONFIG.issues.length > 0
  );
}