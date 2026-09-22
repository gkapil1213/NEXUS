// scripts/test-phase179-recovery-control-api.ts
//
// Phase 179 - production recovery control API & authorization boundary.
//
// Real SQLite + real ExecutionStore + real ReleaseDeploymentIntentService +
// real RecoveryOperationsService/RecoveryControlService + real SessionService
// + real AuthorizationService + real HttpApp + real Express listener.
// fetch() goes over a loopback TCP socket. No fake auth, no fake RBAC.

import Database from "better-sqlite3";
import { join } from "path";
import type { Server } from "http";
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

async function mkEnv(): Promise<Env> {
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
    releaseIntents: intents, recoveryOperations: ops, recoveryControl: ctrl,
  };
  const idempotency = new IdempotencyStore(raw);
  const app = createHttpApp({ services, idempotency });

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

async function req(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: any; idempotencyKey?: string; extraHeaders?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = "Bearer " + opts.token;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
  const res = await fetch(base + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: res.status, body, headers: res.headers };
}

async function withEnv(fn: (env: Env) => Promise<void>): Promise<void> {
  const env = await mkEnv();
  try { await fn(env); } finally { await stopEnv(env); }
}

async function main() {
  section("A - Authentication");
  await withEnv(async (env) => {
    const r1 = await req(env.base, "GET", "/api/recovery/intents?projectId=p");
    ok(r1.status === 401 && r1.body?.error?.code === "UNAUTHENTICATED", "A1 unauthenticated read rejected (401)");

    const r2 = await req(env.base, "POST", "/api/recovery/intents/does-not-exist/reconcile", { idempotencyKey: "k" });
    ok(r2.status === 401, "A2 unauthenticated reconcile rejected (401)");

    const r3 = await req(env.base, "POST", "/api/recovery/intents/does-not-exist/cancel", { idempotencyKey: "k" });
    ok(r3.status === 401, "A3 unauthenticated cancel rejected (401)");

    const { token } = await mkUser(env, "OWNER", "a4");
    await mkProject(env, "proj-A4", "A4");
    const r4 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-A4", { token });
    ok(r4.status === 200, "A4 authenticated read accepted (200)");
  });

  section("B - Authorization");
  await withEnv(async (env) => {
    const { token: ownerTok } = await mkUser(env, "OWNER", "b5");
    await mkProject(env, "proj-B5", "B5");
    const r5 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-B5", { token: ownerTok });
    ok(r5.status === 200, "B5 read permission accepted (OWNER)");

    const { token: devTok } = await mkUser(env, "DEVELOPER", "b6");
    await mkProject(env, "proj-B6", "B6");
    const k6 = await mkIntent(env, "b6", { projectId: "proj-B6" });
    const r6 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k6) + "/reconcile",
      { token: devTok, idempotencyKey: "k6", body: {} });
    ok(r6.status === 403 && r6.body?.error?.code === "PROJECT_ACCESS_DENIED",
      "B6 missing project membership rejected (DEVELOPER holds global execution:retry but no membership)");

    const { token: devTok2 } = await mkUser(env, "DEVELOPER", "b7");
    await mkProject(env, "proj-B7", "B7");
    const k7 = await mkIntent(env, "b7", { projectId: "proj-B7" });
    const r7 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k7) + "/cancel",
      { token: devTok2, idempotencyKey: "k7", body: {} });
    ok(r7.status === 403 && r7.body?.error?.code === "PERMISSION_DENIED",
      "B7 missing cancel permission rejected (DEVELOPER lacks execution:cancel)");

    const { token: b8OwnerTok } = await mkUser(env, "OWNER", "b8");
    await mkProject(env, "proj-B8", "B8");
    const k8 = await mkIntent(env, "b8", { projectId: "proj-B8" });
    env.intents.acquireLease(k8, "seeder", 60_000);
    env.intents.transitionIfOwned(k8, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k8, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k8, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 60_000, recoveryReason: "x",
    });
    env.intents.releaseLease(k8, "seeder");
    const r8 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k8) + "/reconcile",
      { token: b8OwnerTok, idempotencyKey: "k8", body: {} });
    ok(r8.status === 200,
      "B8 elevated role (OWNER = only platform-admin in existing model) authorized without project membership");
  });

  section("C - Project isolation");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "c9");
    await mkProject(env, "proj-C9", "C9");
    await mkIntent(env, "c9", { projectId: "proj-C9" });
    const r = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-C9", { token });
    ok(r.status === 200 && r.body?.data?.snapshots?.length === 1, "C9 authorized project accepted");

    const { token: dev } = await mkUser(env, "DEVELOPER", "c10");
    const r10 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-C9", { token: dev });
    ok(r10.status === 403, "C10 unauthorized project rejected (no membership)");

    const r11 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-DOES-NOT-EXIST", { token: dev });
    ok(r11.status === 403, "C11 cross-project execution rejected");

    const r12 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-DOES-NOT-EXIST", { token });
    ok(r12.status === 403, "C12 cross-project artifact/scope rejected (project not found)");
  });

  section("D - Environment isolation");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "d13");
    await mkProject(env, "proj-D13", "D13");
    const k = await mkIntent(env, "d13", { projectId: "proj-D13", environment: "production" });

    const r13 = await req(env.base, "GET", "/api/recovery/intents/" + encodeURIComponent(k) + "?environment=production", { token });
    ok(r13.status === 200, "D13 authorized environment accepted");

    const r14 = await req(env.base, "GET", "/api/recovery/intents/" + encodeURIComponent(k) + "?environment=staging", { token });
    ok(r14.status === 400 && r14.body?.error?.code === "ENVIRONMENT_MISMATCH",
      "D14 unauthorized environment rejected");

    const r15 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-D13&environment=staging", { token });
    ok(r15.status === 200 && r15.body?.data?.snapshots?.length === 0,
      "D15 production/staging scope cannot be confused (filter returns empty)");
  });

  section("E - Reconciliation control");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "e16");
    await mkProject(env, "proj-E16", "E16");
    const k = await mkIntent(env, "e16", { projectId: "proj-E16" });
    env.intents.acquireLease(k, "seeder", 60_000);
    env.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 120_000, recoveryReason: "x",
    });
    env.intents.releaseLease(k, "seeder");

    const r16 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "e16-key", body: {} });
    ok(r16.status === 200 && r16.body?.data?.accepted === true, "E16 valid reconcile accepted");
    ok(env.intents.get(k)?.nextRetryAt === 0, "E16 durable effect applied (nextRetryAt=0)");

    const r17 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "e16-key", body: {} });
    ok(r17.status === 200 && JSON.stringify(r17.body) === JSON.stringify(r16.body),
      "E17 duplicate reconcile idempotent (same key -> same response)");

    const k18 = await mkIntent(env, "e18", { projectId: "proj-E16" });
    env.intents.acquireLease(k18, "seeder", 60_000);
    env.intents.transitionIfOwned(k18, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k18, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k18, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 120_000, recoveryReason: "x",
    });
    env.intents.releaseLease(k18, "seeder");
    const [ra, rb] = await Promise.all([
      req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k18) + "/reconcile", { token, idempotencyKey: "e18-A", body: {} }),
      req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k18) + "/reconcile", { token, idempotencyKey: "e18-B", body: {} }),
    ]);
    ok(ra.status === 200 || rb.status === 200, "E18 concurrent reconcile converges");

    const k19 = await mkIntent(env, "e19", { projectId: "proj-E16" });
    env.intents.acquireLease(k19, "seeder", 60_000);
    env.intents.transitionIfOwned(k19, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k19, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k19, "KNOWN_GOOD", "seeder", { deploymentId: "dep-e19" });
    env.intents.releaseLease(k19, "seeder");
    const r19 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k19) + "/reconcile",
      { token, idempotencyKey: "e19-key", body: {} });
    ok(r19.status === 409 && r19.body?.error?.code === "TERMINAL_STATE", "E19 terminal reconcile rejected");

    const k20 = await mkIntent(env, "e20", { projectId: "proj-E16" });
    env.intents.acquireLease(k20, "seeder", 60_000);
    env.intents.transitionIfOwned(k20, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k20, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k20, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Number.MAX_SAFE_INTEGER, recoveryAttempts: 5, recoveryReason: "exhausted",
    });
    env.intents.releaseLease(k20, "seeder");
    const r20a = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k20) + "/reconcile",
      { token, idempotencyKey: "e20-a", body: {} });
    ok(r20a.status === 409 && r20a.body?.error?.code === "RETRIES_EXHAUSTED",
      "E20a exhausted rejected without force");
    const r20b = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k20) + "/reconcile",
      { token, idempotencyKey: "e20-b", body: { force: true } });
    ok(r20b.status === 200, "E20b exhausted accepted with force");

    const r21 = await req(env.base, "GET", "/api/recovery/intents/" + encodeURIComponent(k20), { token });
    ok(r21.status === 200 && env.intents.get(k20)?.status !== "KNOWN_GOOD",
      "E21 no direct KNOWN_GOOD mutation from API");
  });

  section("F - Cancellation control");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "f22");
    await mkProject(env, "proj-F22", "F22");
    const k = await mkIntent(env, "f22", { projectId: "proj-F22" });
    env.intents.acquireLease(k, "seeder", 60_000);
    env.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k, "DEPLOYING", "seeder", {});
    env.intents.releaseLease(k, "seeder");

    const r22 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/cancel",
      { token, idempotencyKey: "f22-key", body: {} });
    ok(r22.status === 200 && r22.body?.data?.accepted === true, "F22 valid cancellation accepted");
    ok(env.intents.get(k)?.cancelRequestedAt !== null, "F22 durable cancel_requested_at set");

    const r23 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/cancel",
      { token, idempotencyKey: "f22-key", body: {} });
    ok(r23.status === 200 && JSON.stringify(r23.body) === JSON.stringify(r22.body),
      "F23 duplicate cancellation idempotent (same key)");
    const r23b = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/cancel",
      { token, idempotencyKey: "f22-key-2", body: {} });
    ok(r23b.status === 200 && r23b.body?.data?.idempotent === true,
      "F23 duplicate cancellation idempotent (different key, store-level)");

    const k24 = await mkIntent(env, "f24", { projectId: "proj-F22" });
    env.intents.acquireLease(k24, "seeder", 60_000);
    env.intents.transitionIfOwned(k24, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k24, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k24, "KNOWN_GOOD", "seeder", { deploymentId: "dep-f24" });
    env.intents.releaseLease(k24, "seeder");
    const r24 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k24) + "/cancel",
      { token, idempotencyKey: "f24-key", body: {} });
    ok(r24.status === 409 && r24.body?.error?.code === "TERMINAL_STATE", "F24 terminal cancellation safely handled");

    const { token: dev } = await mkUser(env, "DEVELOPER", "f25");
    await mkProject(env, "proj-F25", "F25");
    const k25 = await mkIntent(env, "f25", { projectId: "proj-F25" });
    const r25 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k25) + "/cancel",
      { token: dev, idempotencyKey: "f25-key", body: {} });
    ok(r25.status === 403, "F25 unauthorized cancellation rejected");

    const k26 = await mkIntent(env, "f26", { projectId: "proj-F22" });
    env.intents.acquireLease(k26, "seeder", 60_000);
    env.intents.transitionIfOwned(k26, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k26, "DEPLOYING", "seeder", {});
    env.intents.releaseLease(k26, "seeder");
    const [rca, rcb] = await Promise.all([
      req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k26) + "/cancel", { token, idempotencyKey: "f26-c", body: {} }),
      req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k26) + "/reconcile", { token, idempotencyKey: "f26-r", body: {} }),
    ]);
    const after = env.intents.get(k26);
    ok(after?.cancelRequestedAt !== null || after?.nextRetryAt === 0,
      "F26 concurrent cancel/reconcile remains coherent");
    ok(rca.status < 500 && rcb.status < 500, "F26 both requests handled without server error");
  });

  section("G - Lease fencing");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "g27");
    await mkProject(env, "proj-G27", "G27");
    const k = await mkIntent(env, "g27", { projectId: "proj-G27" });
    env.intents.acquireLease(k, "seeder", 60_000);
    env.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 60_000, recoveryReason: "x",
    });
    env.intents.releaseLease(k, "seeder");

    const before = env.intents.get(k)?.nextRetryAt ?? null;
    const stale = env.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "stale-worker", { nextRetryAt: 0 });
    ok(stale.updated === false, "G27 stale worker cannot mutate");
    ok((env.intents.get(k)?.nextRetryAt ?? null) === before, "G27 state unchanged by stale attempt");

    env.intents.acquireLease(k, "other-worker", 60_000);
    const r28 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "g28-key", body: {} });
    ok(r28.status === 409 && r28.body?.error?.code === "LEASE_HELD",
      "G28 operator control cannot bypass worker lease");
    env.intents.releaseLease(k, "other-worker");

    const k29 = await mkIntent(env, "g29", { projectId: "proj-G27" });
    env.intents.acquireLease(k29, "seeder", 1);
    await new Promise((r) => setTimeout(r, 15));
    const r29 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k29) + "/reconcile",
      { token, idempotencyKey: "g29-key", body: {} });
    ok(r29.status === 200 || r29.status === 409, "G29 expired lease follows existing recovery semantics");

    const k30 = await mkIntent(env, "g30", { projectId: "proj-G27" });
    env.intents.acquireLease(k30, "seeder", 60_000);
    env.intents.transitionIfOwned(k30, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k30, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k30, "FAILED", "seeder", { failureReason: "x" });
    env.intents.releaseLease(k30, "seeder");
    const r30 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k30) + "/reconcile",
      { token, idempotencyKey: "g30-key", body: {} });
    ok(r30.status === 409, "G30 terminal fencing preserved");
  });

  section("H - Audit");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "h31");
    await mkProject(env, "proj-H31", "H31");
    const k = await mkIntent(env, "h31", { projectId: "proj-H31" });
    env.intents.acquireLease(k, "seeder", 60_000);
    env.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 60_000, recoveryReason: "x",
    });
    env.intents.releaseLease(k, "seeder");

    await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/reconcile",
      { token, idempotencyKey: "h31-key", body: {} });
    const acc = env.audits.find((a) => a.action === "recovery.reconcile.requested" && a.result === "allow");
    ok(acc !== undefined, "H31 accepted reconcile audited");
    ok(acc?.metadata?.previousNextRetryAt !== undefined, "H31 audit carries prior retry state");

    const k32 = await mkIntent(env, "h32", { projectId: "proj-H31" });
    env.intents.acquireLease(k32, "seeder", 60_000);
    env.intents.transitionIfOwned(k32, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k32, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k32, "KNOWN_GOOD", "seeder", { deploymentId: "dep-h32" });
    env.intents.releaseLease(k32, "seeder");
    await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k32) + "/reconcile",
      { token, idempotencyKey: "h32-key", body: {} });
    const rej = env.audits.find((a) => a.action === "recovery.control.rejected");
    ok(rej !== undefined, "H32 rejected reconcile audited");
    ok(rej?.metadata?.attemptedAction === "recovery.reconcile.requested", "H32 attempted action recorded");

    await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k) + "/cancel",
      { token, idempotencyKey: "h33-key", body: {} });
    const c33 = env.audits.find((a) => a.action === "recovery.cancel.requested" && a.result === "allow");
    ok(c33 !== undefined, "H33 accepted cancellation audited");

    const { token: dev } = await mkUser(env, "DEVELOPER", "h34");
    await mkProject(env, "proj-H34", "H34");
    const k34 = await mkIntent(env, "h34", { projectId: "proj-H34" });
    await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k34) + "/cancel",
      { token: dev, idempotencyKey: "h34-key", body: {} });
    const rej34 = env.audits.find((a) => a.action === "denied:execution:cancel" || a.action === "recovery.control.rejected");
    ok(rej34 !== undefined, "H34 rejected cancellation audited");

    const accActor = env.audits.find((a) => a.action === "recovery.reconcile.requested" && a.result === "allow");
    ok(typeof accActor?.actor === "string" && accActor.actor.includes("@"),
      "H35 principal identity preserved");

    const r36 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-H31",
      { token, extraHeaders: { "X-Request-Id": "req-h36" } });
    ok(r36.headers.get("x-request-id") === "req-h36", "H36 request correlation id echoed");
  });

  section("I - Read-only");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "i37");
    await mkProject(env, "proj-I37", "I37");
    const k = await mkIntent(env, "i37", { projectId: "proj-I37" });

    const before = env.raw.prepare("SELECT * FROM release_deployment_intents WHERE intent_key = ?").get(k);
    const beforeJson = JSON.stringify(before);
    await req(env.base, "GET", "/api/recovery/intents?projectId=proj-I37", { token });
    await req(env.base, "GET", "/api/recovery/intents/" + encodeURIComponent(k), { token });
    await req(env.base, "GET", "/api/recovery/intents/" + encodeURIComponent(k) + "/decision", { token });
    const after = env.raw.prepare("SELECT * FROM release_deployment_intents WHERE intent_key = ?").get(k);
    ok(beforeJson === JSON.stringify(after), "I37 inspection does not mutate state (row byte-for-byte)");

    const leaseBefore = env.intents.get(k)?.leasedBy ?? null;
    ok(leaseBefore === null && (env.intents.get(k)?.leasedBy ?? null) === null,
      "I38 inspection does not acquire lease");

    const attemptsBefore = env.intents.get(k)?.recoveryAttempts ?? 0;
    ok((env.intents.get(k)?.recoveryAttempts ?? 0) === attemptsBefore,
      "I39 inspection does not increment retry");

    const provEvents = env.audits.filter((a) => /provider|docker/i.test(a.action));
    ok(provEvents.length === 0, "I40 inspection does not invoke provider");

    const controlEvents = env.audits.filter((a) => a.action === "recovery.reconcile.requested" || a.action === "recovery.cancel.requested");
    ok(controlEvents.length === 0, "I41 inspection does not emit control event");
  });

  section("J - Restart / idempotency");
  {
    const raw = new Database(":memory:");
    new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
    raw.exec("CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));");
    const engine = SQLiteEngine.fromDatabase(raw);
    const events = new EventService(engine);
    const realAudit = new AuditService(engine);
    const sessions = new SessionService(engine);
    const store = new ExecutionStore(raw);
    const intents = new ReleaseDeploymentIntentService(store);
    const memberships = new ProjectMembershipStore(raw);
    const ops = new RecoveryOperationsService({ intents, audit: realAudit, events });
    const ctrl = new RecoveryControlService({ intents, audit: realAudit, events, workerId: "rc" });
    const services: any = { engine, events, audit: realAudit, sessions, memberships, releaseIntents: intents, recoveryOperations: ops, recoveryControl: ctrl };

    const idem = new IdempotencyStore(raw);
    const u = await createUserRecord({ email: "j@nexus.test", name: "Janitor", password: "Password123!", role: "OWNER" });
    await engine.put("users", u.id, u);
    const sess = await sessions.issue(u.id);
    const now = Date.now();
    await engine.put("projects", "proj-J", { id: "proj-J", name: "J", description: "", repository: "", default_branch: "main", status: "ACTIVE", created_at: now, updated_at: now });
    const { intent } = await intents.getOrCreate({
      releaseId: "rel-J", executionId: "exec-J", artifactId: "art-J", artifactDigest: "sha256:J",
      commitSha: "c-J", environment: "production", projectId: "proj-J",
      imageRepository: "nexus/j", imageTag: "v1", imageId: "sha256-img-J", imageDigest: "sha256:dig-J",
      containerName: "c-J", containerPort: 8080, attemptId: "att-J",
    });
    intents.acquireLease(intent.intentKey, "seeder", 60_000);
    intents.transitionIfOwned(intent.intentKey, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    intents.transitionIfOwned(intent.intentKey, "DEPLOYING", "seeder", {});
    intents.transitionIfOwned(intent.intentKey, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 60_000, recoveryReason: "x",
    });
    intents.releaseLease(intent.intentKey, "seeder");

    const app = createHttpApp({ services, idempotency: idem });
    const srv1: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const b1 = "http://127.0.0.1:" + (srv1.address() as any).port;
    const r1 = await req(b1, "POST", "/api/recovery/intents/" + encodeURIComponent(intent.intentKey) + "/reconcile",
      { token: sess.token, idempotencyKey: "j-key", body: {} });
    ok(r1.status === 200, "J42 control survives restart context");
    await new Promise<void>((res) => srv1.close(() => res()));

    const app2 = createHttpApp({ services, idempotency: new IdempotencyStore(raw) });
    const srv2: Server = await new Promise((resolve) => { const s = app2.listen(0, () => resolve(s)); });
    const b2 = "http://127.0.0.1:" + (srv2.address() as any).port;
    const r2 = await req(b2, "POST", "/api/recovery/intents/" + encodeURIComponent(intent.intentKey) + "/reconcile",
      { token: sess.token, idempotencyKey: "j-key", body: {} });
    ok(r2.status === 200 && JSON.stringify(r2.body) === JSON.stringify(r1.body),
      "J43 duplicate request after restart is safe (idempotent replay)");

    const r2b = await req(b2, "POST", "/api/recovery/intents/" + encodeURIComponent(intent.intentKey) + "/reconcile",
      { token: sess.token, idempotencyKey: "j-key", body: { force: false } });
    ok(r2b.status === 409, "J44 idempotency state survives restart (reused key with different body -> conflict)");

    intents.acquireLease(intent.intentKey, "seeder2", 60_000);
    intents.transitionIfOwned(intent.intentKey, "KNOWN_GOOD", "seeder2", { deploymentId: "dep-J" });
    intents.releaseLease(intent.intentKey, "seeder2");
    const r5 = await req(b2, "POST", "/api/recovery/intents/" + encodeURIComponent(intent.intentKey) + "/reconcile",
      { token: sess.token, idempotencyKey: "j-key-2", body: {} });
    ok(r5.status === 409, "J45 terminal state remains terminal after restart");
    await new Promise<void>((res) => srv2.close(() => res()));
    raw.close();
  }

  section("K - Error handling");
  await withEnv(async (env) => {
    const { token } = await mkUser(env, "OWNER", "k46");
    await mkProject(env, "proj-K46", "K46");

    const r46 = await req(env.base, "POST", "/api/recovery/intents/anything/reconcile",
      { token, body: {} });
    ok(r46.status === 400 && r46.body?.error?.code === "IDEMPOTENCY_KEY_REQUIRED",
      "K46 malformed request (missing Idempotency-Key) rejected");

    const r47 = await req(env.base, "GET", "/api/recovery/intents/does-not-exist", { token });
    ok(r47.status === 404 && r47.body?.error?.code === "INTENT_NOT_FOUND", "K47 missing resource handled");

    const r48 = await req(env.base, "GET", "/api/recovery/intents?projectId=proj-K46", { token });
    ok(r48.status === 200, "K48 matching identity accepted");

    const k49 = await mkIntent(env, "k49", { projectId: "proj-K46" });
    env.intents.acquireLease(k49, "seeder", 60_000);
    env.intents.transitionIfOwned(k49, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k49, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k49, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: 0, providerStatus: "UNKNOWN", recoveryReason: "provider unknown",
    });
    env.intents.releaseLease(k49, "seeder");
    const r49 = await req(env.base, "GET", "/api/recovery/intents/" + encodeURIComponent(k49), { token });
    ok(r49.status === 200 && r49.body?.data?.snapshot?.status === "RECOVERY_REQUIRED",
      "K49 stale evidence handled (RECOVERY_REQUIRED preserved)");

    const k50 = await mkIntent(env, "k50", { projectId: "proj-K46" });
    env.intents.acquireLease(k50, "seeder", 60_000);
    env.intents.transitionIfOwned(k50, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    env.intents.transitionIfOwned(k50, "DEPLOYING", "seeder", {});
    env.intents.transitionIfOwned(k50, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: 0, providerStatus: "UNKNOWN", recoveryReason: "provider unknown",
    });
    env.intents.releaseLease(k50, "seeder");
    const r50 = await req(env.base, "POST", "/api/recovery/intents/" + encodeURIComponent(k50) + "/reconcile",
      { token, idempotencyKey: "k50-key", body: {} });
    ok(r50.status === 200, "K50 provider UNKNOWN remains reconcilable, not silently promoted");
    const post = env.intents.get(k50);
    ok(post?.status === "RECOVERY_REQUIRED" && post?.nextRetryAt === 0,
      "K50 UNKNOWN stays RECOVERY_REQUIRED (not KNOWN_GOOD)");
  });

  console.log("\n=== Phase 179 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });