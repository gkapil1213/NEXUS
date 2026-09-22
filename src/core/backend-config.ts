// src/core/backend-config.ts
// Phase 183: shared-backend configuration resolution.
//
// Reads NEXUS_PERSISTENCE_MODE and DATABASE_URL from the environment.
// Never hardcodes credentials. Never logs the URL directly -- callers use
// sharedUrlRedacted. Configuration validity is a necessary but not
// sufficient condition for use: reachability is verified at boot.

export type BackendMode = "sqlite" | "shared";

export interface BackendConfig {
  mode: BackendMode;
  sharedBackend: "postgres" | null;
  sharedUrl: string | null;
  sharedUrlRedacted: string | null;
  reason: string;
  valid: boolean;
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

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "[REDACTED]";
    return u.toString();
  } catch {
    return "[unparseable URL]";
  }
}

function parsePostgresUrl(url: string): { ok: boolean; reason: string } {
  try {
    const u = new URL(url);
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
      return { ok: false, reason: "DATABASE_URL scheme must be postgres: or postgresql:" };
    }
    if (!u.hostname) return { ok: false, reason: "DATABASE_URL missing hostname" };
    return { ok: true, reason: "ok" };
  } catch (e) {
    return { ok: false, reason: "DATABASE_URL unparseable: " + (e as Error).message };
  }
}

export function resolveBackendConfig(): BackendConfig {
  const raw = (envRead("NEXUS_PERSISTENCE_MODE") ?? "sqlite").trim().toLowerCase();

  if (!raw || raw === "sqlite") {
    return {
      mode: "sqlite",
      sharedBackend: null,
      sharedUrl: null,
      sharedUrlRedacted: null,
      reason: "sqlite (default) - WAL + busy_timeout=5000",
      valid: true,
    };
  }

  if (raw === "shared") {
    const url = envRead("DATABASE_URL");
    if (!url) {
      return {
        mode: "shared",
        sharedBackend: null,
        sharedUrl: null,
        sharedUrlRedacted: null,
        reason: "shared mode requires DATABASE_URL to be set",
        valid: false,
      };
    }
    const p = parsePostgresUrl(url);
    if (!p.ok) {
      return {
        mode: "shared",
        sharedBackend: "postgres",
        sharedUrl: url,
        sharedUrlRedacted: redactUrl(url),
        reason: p.reason,
        valid: false,
      };
    }
    return {
      mode: "shared",
      sharedBackend: "postgres",
      sharedUrl: url,
      sharedUrlRedacted: redactUrl(url),
      reason: "shared postgres configured - reachability verified at boot",
      valid: true,
    };
  }

  return {
    mode: "shared",
    sharedBackend: null,
    sharedUrl: null,
    sharedUrlRedacted: null,
    reason: "unsupported NEXUS_PERSISTENCE_MODE value: " + raw,
    valid: false,
  };
}