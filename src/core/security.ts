/**
 * NEXUS Phase 1 — security foundation.
 *
 *  - Roles + permission matrix with a policy-checking interface: can()
 *  - Session issue/validation/revocation (PBKDF2-hashed credentials)
 *  - SecretProvider abstraction with a safe local implementation — values
 *    live in a private WeakMap and are never serialized, logged or returned
 *    through normal API responses; only SecretReferences cross boundaries
 *  - Input validation for all external data
 */

import { CONFIG } from "./config";
import { digestOf, hashSecret, nid, randomTokenHex, timingSafeEqual, type NexusEngine } from "./db";
import { Err } from "./errors";
import type { Permission, PublicUser, Role, SecretReference, Session, User } from "./types";

/* ---------------------------------- RBAC ---------------------------------- */

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  OWNER: [
    "project:create", "project:read", "project:update", "project:archive",
    "execution:create", "execution:read", "execution:cancel",
    "agent:register", "agent:read",
    "event:read", "audit:read", "evidence:read",
    "secret:reference", "config:read", "system:health",
  ],
  ADMIN: [
    "project:create", "project:read", "project:update", "project:archive",
    "execution:create", "execution:read", "execution:cancel",
    "agent:register", "agent:read",
    "event:read", "audit:read", "evidence:read",
    "secret:reference", "config:read", "system:health",
  ],
  ENGINEER: [
    "project:create", "project:read", "project:update",
    "execution:create", "execution:read", "execution:cancel",
    "agent:read",
    "event:read", "evidence:read",
    "config:read", "system:health",
  ],
  VIEWER: ["project:read", "execution:read", "agent:read", "event:read", "system:health"],
};

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/** The single policy gate. Authentication is assumed already established;
 *  this answers "may this identity perform this action on this resource?". */
export function can(user: Pick<User, "role" | "status">, permission: Permission, _resource?: unknown): boolean {
  if (user.status !== "active") return false;
  return ROLE_PERMISSIONS[user.role].includes(permission);
}

/* -------------------------------- Validation ------------------------------- */

export function validateEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 254) {
    throw Err.validation("INVALID_EMAIL", "a valid email address is required");
  }
  return e;
}

export function validateName(name: string, label = "name", min = 2, max = 80): string {
  const v = name.trim();
  if (v.length < min || v.length > max) {
    throw Err.validation("INVALID_NAME", `${label} must be ${min}–${max} characters`);
  }
  return v;
}

export function validatePassword(pw: string): void {
  if (pw.length < 8) throw Err.validation("WEAK_PASSWORD", "password must be at least 8 characters");
  if (pw.length > 128) throw Err.validation("WEAK_PASSWORD", "password must be at most 128 characters");
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    throw Err.validation("WEAK_PASSWORD", "password must contain letters and digits");
  }
}

export function validateProjectInput(input: {
  name: string;
  description?: string;
  repository?: string;
  default_branch?: string;
}): { name: string; description: string; repository: string; default_branch: string } {
  const name = validateName(input.name, "project name");
  const description = (input.description ?? "").trim().slice(0, 500);
  const repository = (input.repository ?? "").trim();
  if (repository && !/^(https?:\/\/|git@)[^\s]+$/.test(repository)) {
    throw Err.validation("INVALID_REPOSITORY", "repository must be an https:// or git@ URL");
  }
  const default_branch = (input.default_branch ?? "main").trim() || "main";
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]{0,99}$/.test(default_branch)) {
    throw Err.validation("INVALID_BRANCH", "branch name contains unsupported characters");
  }
  return { name, description, repository, default_branch };
}

export function validateRequestText(text: string): string {
  const t = text.trim();
  if (t.length < 4) throw Err.validation("INVALID_REQUEST", "request must be at least 4 characters");
  if (t.length > CONFIG.maxRequestChars) {
    throw Err.validation("INVALID_REQUEST", `request exceeds the ${CONFIG.maxRequestChars} character limit`);
  }
  return t;
}

/* --------------------------------- Secrets -------------------------------- */

export interface SecretProvider {
  readonly providerName: SecretReference["provider"];
  /** Store a secret; only a reference crosses the boundary. */
  put(name: string, value: string): Promise<SecretReference>;
  /** Resolve a reference to its value. Callers must never persist or echo it. */
  resolve(ref: SecretReference): Promise<string>;
  list(): Promise<SecretReference[]>;
}

/**
 * Safe local provider: values live in a private WeakMap keyed by reference
 * identity, so they are never serialized, enumerated or leaked through
 * structured cloning. Future phases can swap in Vault/AWS/GCP/Azure
 * implementations of the same interface.
 */
export class LocalSecretProvider implements SecretProvider {
  readonly providerName = "local" as const;
  private vault = new WeakMap<SecretReference, string>();
  private refs: SecretReference[] = [];
  private engine: NexusEngine;

  constructor(engine: NexusEngine) {
    this.engine = engine;
  }

  async put(name: string, value: string): Promise<SecretReference> {
    const cleanName = validateName(name, "secret name", 2, 64);
    if (!value) throw Err.validation("EMPTY_SECRET", "secret value must not be empty");
    const ref: SecretReference = {
      id: nid("sec"),
      name: cleanName,
      provider: "local",
      path: `local/${cleanName}`,
      created_at: Date.now(),
    };
    this.vault.set(ref, value);
    this.refs.push(ref);
    // Only the reference (never the value) is persisted.
    await this.engine.put("secrets", ref.id, ref);
    return ref;
  }

  async resolve(ref: SecretReference): Promise<string> {
    const value = this.vault.get(ref);
    if (value === undefined) {
      throw Err.security("SECRET_UNAVAILABLE", "secret value is not available in this runtime");
    }
    return value;
  }

  async list(): Promise<SecretReference[]> {
    const stored = await this.engine.all<SecretReference>("secrets");
    return stored.sort((a, b) => a.created_at - b.created_at);
  }
}

/* --------------------------------- Sessions -------------------------------- */

export class SessionService {
  private engine: NexusEngine;
  constructor(engine: NexusEngine) {
    this.engine = engine;
  }

  async issue(userId: string): Promise<Session> {
    const now = Date.now();
    const session: Session = {
      token: randomTokenHex(32),
      user_id: userId,
      created_at: now,
      expires_at: now + CONFIG.sessionTtlMs,
      revoked: false,
    };
    await this.engine.put("sessions", session.token, session);
    return session;
  }

  /** Validate a token; revokes it if expired. Returns the session or throws. */
  async validate(token: string | null): Promise<Session> {
    if (!token) throw Err.auth("UNAUTHENTICATED", "authentication required");
    const session = await this.engine.get<Session>("sessions", token);
    if (!session || session.revoked) throw Err.auth("INVALID_SESSION", "invalid session");
    if (session.expires_at <= Date.now()) {
      session.revoked = true;
      await this.engine.put("sessions", session.token, session);
      throw Err.auth("SESSION_EXPIRED", "session expired — sign in again");
    }
    return session;
  }

  async revoke(token: string): Promise<void> {
    const session = await this.engine.get<Session>("sessions", token);
    if (session) {
      session.revoked = true;
      await this.engine.put("sessions", session.token, session);
    }
  }
}

/* ------------------------------ User management ---------------------------- */

export function toPublicUser(u: User): PublicUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, created_at: u.created_at };
}

/** Hash a password with PBKDF2 — plaintext never persists. */
export async function createUserRecord(input: { email: string; name: string; password: string; role: Role }): Promise<User> {
  const email = validateEmail(input.email);
  const name = validateName(input.name);
  validatePassword(input.password);
  const salt = randomTokenHex(16);
  const password_hash = await hashSecret(input.password, salt, CONFIG.pbkdf2Iterations);
  return {
    id: nid("usr"),
    email,
    name,
    role: input.role,
    status: "active",
    password_hash,
    salt,
    iterations: CONFIG.pbkdf2Iterations,
    created_at: Date.now(),
  };
}

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  const candidate = await hashSecret(password, user.salt, user.iterations);
  return timingSafeEqual(candidate, user.password_hash);
}

/** True when a user record carries no plaintext credential material. */
export function userRecordIsSafe(u: User): boolean {
  return (
    !("password" in (u as unknown as Record<string, unknown>)) &&
    typeof u.password_hash === "string" &&
    u.password_hash.length === 64
  );
}

export { digestOf };
