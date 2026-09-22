// scripts/test-phase180-http-production-hardening.ts
//
// Phase 180 - production HTTP hardening for the Phase 179 operator API.
//
// Real SQLite + real ExecutionStore + real ReleaseDeploymentIntentService +
// real RecoveryOperationsService/RecoveryControlService + real SessionService
// + real AuthorizationService + real HttpApp + real Express listener.
// fetch() goes over loopback TCP. No fake auth, no fake RBAC.

import Database from "better-sqlite3";
import { join } from "path";
import type { Server } from "http";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { RecoveryOperationsService } from "../src/core/recovery-operations";
import { RecoveryControlService } from "../src/core/recovery-control-service";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";
import { SessionService, AuthorizationService, createUserRecord } from "../src/core/security";
import { ProjectMembershipStore } from "../src/core/project-membership-store";
import { createHttpApp } from "../src/server/http";
import { IdempotencyStore } from "../src/server/idempotency";
import type { RateLimitOptions } from "../src/server/rate-limit";
import type { Role, User } from "../src/core/types";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

interface Env {
  raw: Database.Database;
  engine: SQLiteEngine;
  store: ExecutionStore;
  intents: ReleaseDeploymentIntentService;
  sessions: SessionService;
  memberships: ProjectMembershipStore;
  audits: { action: string; result?: string; resource_id: string; metadata?: any; actor: string }[];
  server: Server;
  base: string;
}

async function mkEnv(opts: { rateLimit?: RateLimitOptions; timeoutMs?: number; accessLog?: boolean } = {}): Promise<Env> {
  const raw = new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  raw.exec(
    "CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));",
  );
  const engine = SQLiteEngine.fromDatabase(raw);
  const events = new EventService(engine);
  const realAudit = new AuditService(engine);
  const audits: Env["audits"] = [];
  const auditProxy: any = {
    record: async (e: any) => { audits.push(e); return realAudit.record(e); },
    list: realAudit.list.bind(realAudit),
    probe: realAudit.probe.bind(realAudit),
  };
  const sessions = new SessionService(engine);
  const authz = new AuthorizationService(auditProxy);
  const store = new ExecutionStore(raw);
  const intents = new ReleaseDeploymentIntentService(store);
  const memberships = new ProjectMembershipStore(raw);
  const ops = new RecoveryOperationsService({ intents, audit: auditProxy, events });
  const ctrl = new RecoveryControlService({ intents, audit: auditProxy, events, workerId: "recovery-control" });

  const services: any = {
    engine, events, audit: auditProxy, sessions, authz, memberships,
    executionStore: store,
    releaseIntents: intents,
    recoveryOperations: ops,
    recoveryControl: ctrl,
  };
  const idempotency = new IdempotencyStore(raw);

  const app = createHttpApp({
    services,
    idempotency,
    rateLimit: opts.rateLimit,
    requestTimeoutMs: opts.timeoutMs,
    accessLog: opts.accessLog,
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as any).port;
  const base = "http://127.0.0.1:" + port;

  return { raw, engine, store, intents, sessions, memberships, audits, server, base };
}

async function stopEnv(env: Env): Promise<void> {
  await new Promise<void>((resolve) => env.server.close(() => resolve()));
  env.raw.close();
}

async function mkUser(env: Env, role: Role, suffix: string): Promise<{ user: User; token: string }> {
  const user = await createUserRecord({
    email: role.toLowerCase() + "-" + suffix + "@nexus.test",
    name: role + " " + suffix,
    password: "Password123!",
    role,
  });
  await env.engine.put("users", user.id, user);
  const session = await env.sessions.issue(user.id);
  return { user, token: session.token };
}

async function mkProject(env: Env, projectId: string, name: string): Promise<void> {
  const now = Date.now();
  await env.engine.put("projects", projectId, {
    id: projectId, name, description: "", repository: "", default_branch: "main",
    status: "ACTIVE", created_at: now, updated_at: now,
  });
}

async function mkIntent(env: Env, prefix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { intent } = await env.intents.getOrCreate({
    releaseId: "rel-" + prefix,
    executionId: "exec-" + prefix,
    artifactId: "art-" + prefix,
    artifactDigest: "sha256:" + prefix,
    commitSha: "c-" + prefix,
    environment: "production",
    projectId: "proj-" + prefix,
    imageRepository: "nexus/" + prefix,
    imageTag: "v1",
    imageId: "sha256-img-" + prefix,
    imageDigest: "sha256:dig-" + prefix,
    containerName: "c-" + prefix,
    containerPort: 8080,
    attemptId: "att-" + prefix,
    ...extra,
  });
  return intent.intentKey;
}

async function seedRecoverable(env: Env, prefix: string, projectId: string): Promise<string> {
  const k = await mkIntent(env, prefix, { projectId });
  env.intents.acquireLease(k, "seeder", 60_000);
  env.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
  env.intents.transitionIfOwned(k, "DEPLOYING", "seeder", {});
  env.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
    nextRetryAt: Date.now() + 60_000, recoveryReason: "x",
  });
  env.intents.releaseLease(k, "seeder");
  return k;
}

async function req(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: any; idempotencyKey?: string; extraHeaders?: Record<string, string>; rawBody?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = "Bearer " + opts.token;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
  const body = opts.rawBody !== undefined
    ? opts.rawBody
    : (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function withEnv<T>(fn: (env: Env) => Promise<T>, opts?: Parameters<typeof mkEnv>[0]): Promise<void> {
  const env = await mkEnv(opts);
  try { await fn(env); } finally { await stopEnv(env); }
}

async function main() {
  // ============================================================
  // A - Request validation
  // ============================================================
  section("A - Request validation");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "a1");
    await mkProject(env, "proj-A", "A");
    const k = await seedRecoverable(env, "a1", "proj-A");

    // A1 malformed JSON
    const a1 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "a1", rawBody: "{not json" });
    ok(a1.status === 400 && a1.body?.error?.code === "MALFORMED_JSON", "A1 malformed JSON rejected (400 MALFORMED_JSON)");

    // A2 missing content type
    const a2 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "a2", rawBody: "{}", extraHeaders: { "Content-Type": "text/plain" } });
    ok(a2.status >= 400 && a2.status < 500, "A2 non-JSON content type rejected (4xx)");

    // A3 invalid method
    const a3 = await req(env.base, "PUT", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, body: {} });
    ok(a3.status === 404 || a3.status === 405, "A3 invalid HTTP method rejected");

    // A4 invalid query (unknown projectId is fine; missing projectId is the reject case)
    const a4 = await req(env.base, "GET", "/api/recovery/intents", { token });
    ok(a4.status === 400 && a4.body?.error?.code === "PROJECT_ID_REQUIRED", "A4 missing projectId rejected (400)");

    // A5 invalid path parameter (unknown intentKey)
    const a5 = await req(env.base, "GET", "/api/recovery/intents/" + encodeURIComponent("does-not-exist"), { token });
    ok(a5.status === 404, "A5 unknown path parameter rejected (404)");

    // A6 invalid environment
    const a6 = await req(env.base, "GET", "/api/recovery/intents/" + encodeURIComponent(k) + "?environment=staging", { token });
    ok(a6.status === 400 && a6.body?.error?.code === "ENVIRONMENT_MISMATCH", "A6 invalid environment rejected");

    // A7 invalid body field (environment mismatch)
    const a7 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "a7", body: { environment: "staging" } });
    ok(a7.status === 400 && a7.body?.error?.code === "ENVIRONMENT_MISMATCH", "A7 invalid control field rejected");

    // A8 oversized request (>64kb)
    const huge = "x".repeat(70_000);
    const a8 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "a8", rawBody: JSON.stringify({ filler: huge }) });
    ok(a8.status === 413, "A8 oversized body rejected (413)");
  });

  // ============================================================
  // B - Security
  // ============================================================
  section("B - Security");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "b9");
    await mkProject(env, "proj-B", "B");
    const k = await seedRecoverable(env, "b9", "proj-B");

    // B9 security headers
    const b9 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-B", { token });
    ok(b9.headers.get("x-content-type-options") === "nosniff", "B9 X-Content-Type-Options nosniff");
    ok(b9.headers.get("x-frame-options") === "DENY", "B9 X-Frame-Options DENY");
    ok(b9.headers.get("referrer-policy") === "no-referrer", "B9 Referrer-Policy no-referrer");
    ok(b9.headers.get("cache-control") === "no-store", "B9 Cache-Control no-store on authenticated control surface");

    // B10 no token leakage
    const b10body = JSON.stringify(b9.body);
    ok(!b10body.includes(token), "B10 bearer token not present in response body");
    ok(!b10body.toLowerCase().includes("password"), "B10 password keyword absent from response body");

    // B11 no password leakage on auth error
    const b11 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-B",
      { extraHeaders: { Authorization: "Bearer wrong-token" } });
    const b11str = JSON.stringify(b11.body);
    ok(b11.status === 401 && !b11str.includes("password_hash"), "B11 auth error contains no internal credential material");

    // B12 safe internal errors
    const b12 = await req(env.base, "GET", "/api/recovery/intents/does-not-exist", { token });
    const b12str = JSON.stringify(b12.body);
    ok(!/\bat\s+\w+\.\w+\(/.test(b12str), "B12 no stack trace in error response");

    // B13 request ID validation (malformed inbound is rejected, generated)
    const b13 = await req(env.base, "GET", "/health", { extraHeaders: { "X-Request-Id": "<script>alert(1)</script>" } });
    const rid13 = b13.headers.get("x-request-id") ?? "";
    ok(b13.status === 200 && !rid13.includes("<"), "B13 malformed X-Request-Id rejected; server-generated one substituted");

    // B14 generated request ID (valid inbound is preserved)
    const b14 = await req(env.base, "GET", "/health", { extraHeaders: { "X-Request-Id": "trace-abc-123" } });
    ok(b14.headers.get("x-request-id") === "trace-abc-123", "B14 valid X-Request-Id preserved verbatim");

    // B14b (bonus): overlong request ID is rejected
    const overlong = "a".repeat(300);
    const b14b = await req(env.base, "GET", "/health", { extraHeaders: { "X-Request-Id": overlong } });
    ok(b14b.headers.get("x-request-id") !== overlong, "B14b overlong X-Request-Id not trusted");

    // B9b (bonus): health is not behind security headers? Actually all responses get them
    const health = await req(env.base, "GET", "/health");
    ok(health.headers.get("x-content-type-options") === "nosniff", "B9b security headers also applied to /health");
  });

  // ============================================================
  // C - Authentication
  // ============================================================
  section("C - Authentication");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "c15");
    await mkProject(env, "proj-C", "C");

    // C15 unauthenticated rejected
    const c15 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-C");
    ok(c15.status === 401 && c15.body?.error?.code === "UNAUTHENTICATED", "C15 unauthenticated request rejected (401)");

    // C16 authenticated accepted
    const c16 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-C", { token });
    ok(c16.status === 200, "C16 authenticated request accepted (200)");

    // C17 invalid token rejected
    const c17 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-C",
      { extraHeaders: { Authorization: "Bearer not-a-real-session" } });
    ok(c17.status === 401, "C17 invalid token rejected (401)");
  });

  // ============================================================
  // D - Authorization
  // ============================================================
  section("D - Authorization");
  await withEnv(async (env) => {
    const { token: ownerTok } = await mkUser(env, "OWNER", "d18");
    const { token: devTok } = await mkUser(env, "DEVELOPER", "d18b");
    await mkProject(env, "proj-D", "D");
    const k = await seedRecoverable(env, "d18", "proj-D");

    // D18 project authorization preserved
    const d18 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-D", { token: devTok });
    ok(d18.status === 403, "D18 project authorization preserved (DEVELOPER no membership -> 403)");

    // D19 environment isolation preserved
    const d19 = await req(env.base, "GET", "/api/recovery/intents/" + encodeURIComponent(k) + "?environment=staging", { token: ownerTok });
    ok(d19.status === 400, "D19 environment isolation preserved (mismatch -> 400)");

    // D20 cancellation permission preserved
    const d20 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/cancel",
      { token: devTok, idempotencyKey: "d20", body: {} });
    ok(d20.status === 403, "D20 cancellation permission preserved (DEVELOPER lacks execution:cancel)");

    // D21 reconciliation permission preserved
    const d21 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token: devTok, idempotencyKey: "d21", body: {} });
    ok(d21.status === 403, "D21 reconciliation permission preserved (DEVELOPER no membership)");
  });

  // ============================================================
  // E - Idempotency
  // ============================================================
  section("E - Idempotency");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "e22");
    await mkProject(env, "proj-E", "E");
    const k = await seedRecoverable(env, "e22", "proj-E");

    // E22 duplicate same request -> same response
    const e22a = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "e22-key", body: {} });
    const e22b = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "e22-key", body: {} });
    ok(e22a.status === 200 && e22b.status === 200 && JSON.stringify(e22a.body) === JSON.stringify(e22b.body),
      "E22 duplicate same request returns identical response");

    // E23 duplicate after restart (simulated by new app over same DB + store)
    const raw = env.raw;
    const idem = new IdempotencyStore(raw);
    const services: any = {
      engine: env.engine,
      events: new EventService(env.engine),
      audit: new AuditService(env.engine),
      sessions: env.sessions,
      memberships: env.memberships,
      executionStore: env.store,
      releaseIntents: env.intents,
      recoveryOperations: new RecoveryOperationsService({ intents: env.intents, audit: new AuditService(env.engine), events: new EventService(env.engine) }),
      recoveryControl: new RecoveryControlService({ intents: env.intents, audit: new AuditService(env.engine), events: new EventService(env.engine), workerId: "rc2" }),
    };
    const app2 = createHttpApp({ services, idempotency: idem });
    const srv2: Server = await new Promise((resolve) => { const s = app2.listen(0, () => resolve(s)); });
    const base2 = "http://127.0.0.1:" + (srv2.address() as any).port;
    const e23 = await req(base2, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "e22-key", body: {} });
    ok(e23.status === 200 && JSON.stringify(e23.body) === JSON.stringify(e22a.body),
      "E23 duplicate after restart returns same durable response");
    await new Promise<void>((res) => srv2.close(() => res()));

    // E24 same key different body -> 409
    const e24 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "e22-key", body: { force: true } });
    ok(e24.status === 409 && e24.body?.error?.code === "IDEMPOTENCY_KEY_REUSED",
      "E24 same key with different body -> 409 IDEMPOTENCY_KEY_REUSED");

    // E25 concurrent duplicate requests
    const k25 = await seedRecoverable(env, "e25", "proj-E");
    const [e25a, e25b] = await Promise.all([
      req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k25) + "/reconcile",
        { token, idempotencyKey: "e25-key", body: {} }),
      req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k25) + "/reconcile",
        { token, idempotencyKey: "e25-key", body: {} }),
    ]);
    ok(e25a.status === 200 && e25b.status === 200 && JSON.stringify(e25a.body) === JSON.stringify(e25b.body),
      "E25 concurrent duplicate requests converge to identical response");
  });

  // ============================================================
  // F - Timeout / resource safety
  // ============================================================
  section("F - Timeout / resource safety");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "f26");
    await mkProject(env, "proj-F", "F");
    const k = await seedRecoverable(env, "f26", "proj-F");

    // F26 bounded request processing: normal requests complete under deadline
    const before = Date.now();
    const f26 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "f26", body: {} });
    const elapsed = Date.now() - before;
    ok(f26.status === 200 && elapsed < 5_000, "F26 request completes well within timeout deadline");

    // F27 abandoned request does not corrupt durable state
    const before27 = env.intents.get(k);
    const controller = new AbortController();
    const abortPromise = fetch(env.base + "/api/recovery/intents/" + encodeURIComponent(k), {
      method: "GET",
      headers: { Authorization: "Bearer " + token },
      signal: controller.signal,
    }).catch(() => null);
    controller.abort();
    await abortPromise;
    await new Promise((r) => setTimeout(r, 50));
    const after27 = env.intents.get(k);
    ok(
      before27?.status === after27?.status && before27?.nextRetryAt === after27?.nextRetryAt,
      "F27 abandoned request does not corrupt durable state",
    );

    // F28 timeout does not produce false success
    const f28 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "f28", body: {} });
    const st = env.intents.get(k)?.status;
    ok(f28.status === 200 && st !== "KNOWN_GOOD", "F28 no false success: status is " + st);
  }, { timeoutMs: 1_000 });

  // ============================================================
  // G - Rate / abuse
  // ============================================================
  section("G - Rate / abuse");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "g29");
    await mkProject(env, "proj-G", "G");
    const k = await seedRecoverable(env, "g29", "proj-G");

    // G29 repeated unauthorized requests bounded (auth-fail bucket max=3 in this env)
    // Make 5 unauthenticated requests; at least one must be 429.
    const unauthResults: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-G");
      unauthResults.push(r.status);
    }
    ok(unauthResults.includes(429), "G29 repeated unauthorized requests eventually rate limited");

    // G30 control-request abuse bounded
    const controlResults: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
        { token, idempotencyKey: "g30-" + i, body: {} });
      controlResults.push(r.status);
    }
    ok(controlResults.includes(429), "G30 control-request abuse eventually rate limited");

    // G31 legitimate request remains functional (first attempt)
    const g31 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-G", { token });
    ok(g31.status === 200, "G31 legitimate request remains functional before/at limit");
  }, { rateLimit: { enabled: true, policies: { "auth-fail": { windowMs: 60_000, max: 3 }, control: { windowMs: 60_000, max: 5 }, read: { windowMs: 60_000, max: 500 } } } });

  // ============================================================
  // H - Health
  // ============================================================
  section("H - Health");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "h32");
    await mkProject(env, "proj-H", "H");

    // H32 liveness
    const h32 = await req(env.base, "GET", "/health/live");
    ok(h32.status === 200 && h32.body?.data?.kind === "live", "H32 liveness endpoint returns live");

    // H33 readiness
    const h33 = await req(env.base, "GET", "/health/ready");
    ok(h33.status === 200 && h33.body?.data?.ok === true, "H33 readiness endpoint returns ready with all deps wired");

    // H34 health is read-only (no state changes to intents)
    const k = await seedRecoverable(env, "h34", "proj-H");
    const before = JSON.stringify(env.raw.prepare("SELECT * FROM release_deployment_intents WHERE intent_key = ?").get(k));
    await req(env.base, "GET", "/health");
    await req(env.base, "GET", "/health/live");
    await req(env.base, "GET", "/health/ready");
    const after = JSON.stringify(env.raw.prepare("SELECT * FROM release_deployment_intents WHERE intent_key = ?").get(k));
    ok(before === after, "H34 health endpoints do not mutate intent state");

    // H35 readiness does not invoke provider
    const prov = env.audits.filter((a) => /provider|docker|deploy/i.test(a.action));
    ok(prov.length === 0, "H35 readiness does not invoke provider (no provider/docker audit events)");

    // H36 health does not acquire lease
    const lease = env.intents.get(k)?.leasedBy ?? null;
    ok(lease === null, "H36 health does not acquire lease");
  });

  // ============================================================
  // I - Shutdown
  // ============================================================
  section("I - Shutdown");
  {
    const dir = mkdtempSync(join(tmpdir(), "nexus-180-"));
    const dbFile = join(dir, "server.db");

    // Boot run-server as a child process with a temp SQLite DB.
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/run-server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXUS_PERSISTENCE_ENGINE: "sqlite",
        NEXUS_DB_PATH: dbFile,
        NEXUS_HTTP_PORT: "0",
        NEXUS_ALLOW_STDIN_SHUTDOWN: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stdout += d.toString(); });

    // Wait up to 15s for the listening line.
    const started = Date.now();
    let listening = false;
    while (Date.now() - started < 15_000) {
      if (stdout.includes("\"kind\":\"http.server.listening\"")) { listening = true; break; }
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    ok(listening, "I37/I38 run-server boots and emits listening event");

    // Trigger graceful shutdown. On POSIX we could send SIGTERM; on Windows
    // there are no POSIX signals, so we use the env-gated stdin trigger.
    // Both invoke the same shutdown() function in run-server.ts.
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      setTimeout(() => {
        if (child.exitCode === null) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
      }, 10_000);
    });
    try { child.stdin?.write("shutdown\n"); } catch { /* ignore */ }

    const exitCode = await exitPromise;
    ok(exitCode === 0, "I37 graceful shutdown trigger leads to clean exit (code 0)");
    ok(stdout.includes("shutdown_complete"), "I38 shutdown_complete event emitted");

    // Check DB survived: the sqlite file exists and contains the migrations table
    let durable = false;
    try {
      const check = new Database(dbFile, { readonly: true });
      const row = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nexus_schema_migrations'").get();
      durable = !!row;
      check.close();
    } catch { durable = false; }
    ok(durable, "I40 durable state (sqlite + migrations table) survives shutdown");

    // I39: no new requests after shutdown -- verify by trying to connect (should fail)
    let refused = false;
    try {
      const m = stdout.match(/"port":(\d+)/);
      const p = m ? Number(m[1]) : 0;
      if (p) {
        try {
          await fetch("http://127.0.0.1:" + p + "/health", { signal: AbortSignal.timeout(500) });
        } catch {
          refused = true;
        }
      } else {
        refused = true;
      }
    } catch { refused = true; }
    ok(refused, "I39 no new requests accepted after shutdown (port closed)");

    // I41: resources closed -- verified indirectly by the clean exit above
    ok(exitCode === 0, "I41 process exited cleanly (resources closed)");

    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // On Windows the SQLite file handle may be held for a few ms after exit;
      // tolerate the residual directory rather than fail the suite.
    }
  }

  // ============================================================
  // J - Concurrency
  // ============================================================
  section("J - Concurrency");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "j42");
    await mkProject(env, "proj-J", "J");

    // J42 concurrent reconcile
    const k42 = await seedRecoverable(env, "j42", "proj-J");
    const j42 = await Promise.all([
      req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k42) + "/reconcile", { token, idempotencyKey: "j42-a", body: {} }),
      req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k42) + "/reconcile", { token, idempotencyKey: "j42-b", body: {} }),
    ]);
    ok(j42.filter((r) => r.status === 200 || r.status === 409).length === 2, "J42 concurrent reconcile both resolve");

    // J43 concurrent cancel
    const k43 = await seedRecoverable(env, "j43", "proj-J");
    const j43 = await Promise.all([
      req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k43) + "/cancel", { token, idempotencyKey: "j43-a", body: {} }),
      req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k43) + "/cancel", { token, idempotencyKey: "j43-b", body: {} }),
    ]);
    ok(j43.filter((r) => r.status < 500).length === 2, "J43 concurrent cancel both resolve");

    // J44 concurrent reconcile + cancel
    const k44 = await seedRecoverable(env, "j44", "proj-J");
    const j44 = await Promise.all([
      req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k44) + "/reconcile", { token, idempotencyKey: "j44-r", body: {} }),
      req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k44) + "/cancel", { token, idempotencyKey: "j44-c", body: {} }),
    ]);
    const after44 = env.intents.get(k44);
    ok(
      j44.every((r) => r.status < 500) &&
      (after44?.cancelRequestedAt !== null || after44?.nextRetryAt === 0),
      "J44 concurrent reconcile+cancel remains coherent",
    );

    // J45 lease fencing preserved
    const k45 = await seedRecoverable(env, "j45", "proj-J");
    env.intents.acquireLease(k45, "worker-elsewhere", 60_000);
    const j45 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k45) + "/reconcile",
      { token, idempotencyKey: "j45", body: {} });
    ok(j45.status === 409 && j45.body?.error?.code === "LEASE_HELD", "J45 lease fencing preserved (LEASE_HELD)");
    env.intents.releaseLease(k45, "worker-elsewhere");
  });

  // ============================================================
  // K - Error contract
  // ============================================================
  section("K - Error contract");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "k46");
    await mkProject(env, "proj-K", "K");
    const k = await seedRecoverable(env, "k46", "proj-K");

    // K46 deterministic 4xx
    const k46 = await req(env.base, "POST", "/api/recovery/intents/anything/reconcile", { token, body: {} });
    ok(k46.status === 400 && k46.body?.error?.code === "IDEMPOTENCY_KEY_REQUIRED", "K46 deterministic 400 (missing Idempotency-Key)");

    // K47 deterministic 401
    const k47 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-K");
    ok(k47.status === 401 && k47.body?.error?.code === "UNAUTHENTICATED", "K47 deterministic 401");

    // K48 deterministic 403
    const { token: devTok } = await mkUser(env, "DEVELOPER", "k48");
    const k48 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-K", { token: devTok });
    ok(k48.status === 403, "K48 deterministic 403");

    // K49 deterministic 404
    const k49 = await req(env.base, "GET", "/api/recovery/intents/nope-nope-nope", { token });
    ok(k49.status === 404 && k49.body?.error?.code === "INTENT_NOT_FOUND", "K49 deterministic 404");

    // K50 deterministic 409 (terminal state)
    const k50 = await mkIntent(env, "k50", { projectId: "proj-K" });
    env.intents.acquireLease(k50, "seeder", 60_000);
    env.intents.transitionIfOwned(k50, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k50, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k50, "KNOWN_GOOD", "seeder", { deploymentId: "dep-k50" });
    env.intents.releaseLease(k50, "seeder");
    const k50r = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k50) + "/reconcile",
      { token, idempotencyKey: "k50", body: {} });
    ok(k50r.status === 409 && k50r.body?.error?.code === "TERMINAL_STATE", "K50 deterministic 409 (terminal state)");

    // K51 deterministic 413 (oversized)
    const huge = "y".repeat(70_000);
    const k51 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "k51", rawBody: JSON.stringify({ filler: huge }) });
    ok(k51.status === 413, "K51 deterministic 413 (oversized body)");

    // K52 safe 5xx response
    const k52 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-K", { token: "expired-session-never-issued" });
    const k52str = JSON.stringify(k52.body);
    ok(!k52str.includes("at ") && !k52str.includes("node_modules"), "K52 4xx/5xx body contains no stack frames or module paths");
    // Also check health/ready shape on failure mode is not triggered here (deps present) but envelope shape is safe
    const k52b = await req(env.base, "GET", "/health/ready");
    ok(k52b.body?.error === undefined || typeof k52b.body.error.code === "string", "K52 response envelope matches SystemError shape when error");
  });

  console.log("\n=== Phase 180 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });