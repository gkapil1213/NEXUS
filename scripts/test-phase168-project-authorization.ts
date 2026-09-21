// scripts/test-phase168-project-authorization.ts
// Phase 168 - durable project-scoped authorization.
//
// Uses real services + real persistence layer (in-memory for most tests,
// file-backed tmpdir for the reopen test). No mocks.

import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { AuditService } from "../src/core/audit";
import { EventService } from "../src/core/events";
import { ProjectMembershipStore } from "../src/core/project-membership-store";
import { ProjectService, ExecutionService, type ServiceContext, type Actor } from "../src/core/services";
import { ExecutionAuditProvenanceService } from "../src/core/execution-audit-provenance-service";
import { WorkspaceService, FileAccessPolicy, DEFAULT_WORKSPACE_LIMITS } from "../src/core/workspace";
import { AuthorizationService } from "../src/core/security";
import { isNexusError } from "../src/core/errors";
import { resolveProjectForJobId } from "../src/core/project-authorization";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

async function expectDenied(fn: () => Promise<any>, msg: string): Promise<void> {
  try { await fn(); ok(false, msg + " (no throw)"); }
  catch (e) {
    const code = isNexusError(e) ? e.code : "?";
    const cat = isNexusError(e) ? e.category : "?";
    const denied =
      code === "PROJECT_ACCESS_DENIED" ||
      code === "PERMISSION_DENIED" ||
      code === "AUDIT_READ_DENIED" ||
      cat === "authorization";
    ok(denied, msg + " [" + code + "]");
  }
}

interface H {
  db: Database.Database;
  engine: SQLiteEngine;
  ctx: ServiceContext;
  projects: ProjectService;
  executions: ExecutionService;
  workspaces: WorkspaceService;
  provenance: ExecutionAuditProvenanceService;
  execStore: ExecutionStore;
  memberships: ProjectMembershipStore;
}

function makeHarness(filePath?: string): H {
  const raw = filePath ? new Database(filePath) : new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  raw.exec(
    "CREATE TABLE IF NOT EXISTS nexus_records (" +
    "  store TEXT NOT NULL," +
    "  key TEXT NOT NULL," +
    "  value TEXT NOT NULL," +
    "  PRIMARY KEY (store, key)" +
    ");"
  );
  const engine = SQLiteEngine.fromDatabase(raw);
  const events = new EventService(engine);
  const audit = new AuditService(engine);
  const memberships = new ProjectMembershipStore(raw);
  const ctx: ServiceContext = { engine, events, audit, memberships };
  const projects = new ProjectService(ctx);
  const executions = new ExecutionService(ctx);
  const authz = new AuthorizationService(audit);
  const policy = new FileAccessPolicy();
  const workspaces = new WorkspaceService({
    engine, authz, audit, events, policy, limits: DEFAULT_WORKSPACE_LIMITS, memberships,
  });
  const execStore = new ExecutionStore(raw);
  const provenance = new ExecutionAuditProvenanceService(execStore, ctx);
  return { db: raw, engine, ctx, projects, executions, workspaces, provenance, execStore, memberships };
}

// ADMIN has every global permission needed but is NOT a platform admin
// (only OWNER bypasses membership). Use ADMIN for isolation tests so the
// membership check actually runs.
function mkActor(id: string, role: string, status = "active"): Actor {
  return {
    id, email: id + "@test.nexus", name: id,
    role: role as any, status: status as any,
    created_at: Date.now(), updated_at: Date.now(),
  } as Actor;
}

async function main(): Promise<void> {
  console.log("=== Phase 168 - Durable Project-Scoped Authorization ===\n");

  section("A - Authentication and global permission");
  {
    const h = makeHarness();
    const owner = mkActor("u-a1", "OWNER");
    const suspended = mkActor("u-a2", "OWNER", "suspended");
    const viewer = mkActor("u-a3", "VIEWER");
    const p = await h.projects.create(owner, { name: "A-project" });
    ok(!!p.id, "A1 owner creates project");
    await expectDenied(() => h.projects.get(suspended, p.id), "A2 suspended actor denied");
    await expectDenied(() => h.projects.create(viewer, { name: "viewer-project" }), "A3 viewer denied project:create");
  }

  section("B - Project creation and initial ownership");
  {
    const h = makeHarness();
    const owner = mkActor("u-b1", "OWNER");
    const p = await h.projects.create(owner, { name: "B-project" });
    const m = h.memberships.get(p.id, owner.id);
    ok(!!m, "B1 creator has membership row");
    ok(m?.role === "PROJECT_OWNER", "B2 role is PROJECT_OWNER");
    ok(m?.status === "ACTIVE", "B3 status is ACTIVE");
  }

  section("C - Membership lifecycle");
  {
    const h = makeHarness();
    const owner = mkActor("u-c1", "OWNER");
    const outsider = mkActor("u-c2", "ADMIN");
    const p = await h.projects.create(owner, { name: "C-project" });

    await expectDenied(() => h.projects.get(outsider, p.id), "C1 non-member denied");
    h.memberships.upsert(p.id, outsider.id, "PROJECT_VIEWER");
    const got = await h.projects.get(outsider, p.id);
    ok(got.id === p.id, "C2 viewer now reads");

    h.memberships.revoke(p.id, outsider.id);
    await expectDenied(() => h.projects.get(outsider, p.id), "C3 revoked denied");

    h.memberships.upsert(p.id, outsider.id, "PROJECT_VIEWER");
    h.memberships.suspend(p.id, outsider.id);
    await expectDenied(() => h.projects.get(outsider, p.id), "C4 suspended denied");

    h.memberships.upsert(p.id, outsider.id, "PROJECT_ADMIN");
    const m = h.memberships.get(p.id, outsider.id);
    ok(m?.status === "ACTIVE" && m?.role === "PROJECT_ADMIN", "C5 reactivation with new role");
  }

  section("D - Project isolation");
  {
    const h = makeHarness();
    const userA = mkActor("u-d-a", "ADMIN");
    const userB = mkActor("u-d-b", "ADMIN");
    const pA = await h.projects.create(userA, { name: "D-A" });
    const pB = await h.projects.create(userB, { name: "D-B" });

    const aOnA = await h.projects.get(userA, pA.id);
    ok(aOnA.id === pA.id, "D1 user A on project A allowed");
    await expectDenied(() => h.projects.get(userA, pB.id), "D2 user A on project B denied");

    const bOnB = await h.projects.get(userB, pB.id);
    ok(bOnB.id === pB.id, "D3 user B on project B allowed");
    await expectDenied(() => h.projects.get(userB, pA.id), "D4 user B on project A denied");

    const listA = await h.projects.list(userA);
    ok(listA.length === 1 && listA[0].id === pA.id, "D5 list scoped to membership");
  }

  section("E - Execution service isolation");
  {
    const h = makeHarness();
    const userA = mkActor("u-e-a", "ADMIN");
    const userB = mkActor("u-e-b", "ADMIN");
    const pA = await h.projects.create(userA, { name: "E-A" });
    const pB = await h.projects.create(userB, { name: "E-B" });

    const eA = await h.executions.createQueued(userA, pA.id, "run A");
    ok(eA.project_id === pA.id && eA.created_by === userA.id, "E1 create queued as member");

    await expectDenied(() => h.executions.createQueued(userA, pB.id, "run in B"), "E2 create in foreign project denied");

    const gotA = await h.executions.get(userA, eA.id);
    ok(gotA.id === eA.id, "E3 member reads own execution");

    await expectDenied(() => h.executions.get(userB, eA.id), "E4 cross-project read denied");

    const listA = await h.executions.list(userA);
    ok(listA.some((e) => e.id === eA.id), "E5 list scoped to membership");

    const listB = await h.executions.list(userB);
    ok(!listB.some((e) => e.id === eA.id), "E6 list excludes cross-project");

    await expectDenied(() => h.executions.cancel(userB, eA.id), "E7 cross-project cancel denied");
    await expectDenied(() => h.executions.transition(userB, eA.id, "RUNNING"), "E8 cross-project transition denied");

    const byP = await h.executions.byProject(userA, pA.id);
    ok(byP.some((e) => e.id === eA.id), "E9 byProject scoped");
    await expectDenied(() => h.executions.byProject(userB, pA.id), "E10 byProject cross-project denied");
  }

  section("F - Provenance isolation");
  {
    const h = makeHarness();
    const userA = mkActor("u-f-a", "ADMIN");
    const userB = mkActor("u-f-b", "ADMIN");
    const pA = await h.projects.create(userA, { name: "F-A" });
    await h.projects.create(userB, { name: "F-B" });

    const exeA = await h.executions.createQueued(userA, pA.id, "prov A");
    h.execStore.createJob({
      id: "job-F-A",
      idempotencyKey: "k-F-A",
      jobType: "engineering",
      payload: { kind: "engineering", executionId: exeA.id },
      status: "QUEUED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cancellationRequested: false,
      cancellationAcknowledged: false,
    });

    const resolved = await resolveProjectForJobId(h.engine, (id) => h.execStore.getJob(id), "job-F-A");
    ok(resolved === pA.id, "F1 authoritative project resolution works");

    const resolved2 = await resolveProjectForJobId(h.engine, (id) => h.execStore.getJob(id), "no-such-job");
    ok(resolved2 === null, "F2 missing job -> null (system-scoped)");

    // Member reads (empty page is fine — no provenance yet)
    const pageA = await h.provenance.getProvenanceByJob(userA, "job-F-A");
    ok(pageA.items.length === 0, "F3 member read succeeds (empty)");

    // Non-member denied (opaque PROVENANCE_NOT_FOUND)
    let sawDenial = false;
    try { await h.provenance.getProvenanceByJob(userB, "job-F-A"); }
    catch { sawDenial = true; }
    ok(sawDenial, "F4 cross-project provenance denied");
  }

  section("G - Workspace service isolation");
  {
    const h = makeHarness();
    const userA = mkActor("u-g-a", "ADMIN");
    const userB = mkActor("u-g-b", "ADMIN");
    const pA = await h.projects.create(userA, { name: "G-A" });
    await h.projects.create(userB, { name: "G-B" });

    const wsA = await h.workspaces.create(userA, { project_id: pA.id, execution_id: "exec-g-a" });
    ok(!!wsA.id, "G1 workspace create by member");

    await expectDenied(
      () => h.workspaces.create(userB, { project_id: pA.id, execution_id: "exec-g-b" }),
      "G2 workspace create in foreign project denied"
    );

    const got = await h.workspaces.get(userA, wsA.id);
    ok(got.id === wsA.id, "G3 member reads own workspace");

    await expectDenied(() => h.workspaces.get(userB, wsA.id), "G4 cross-project workspace read denied");
  }

  section("H - Security: fail-closed and enumeration resistance");
  {
    const h = makeHarness();
    const userA = mkActor("u-h-a", "ADMIN");
    await h.projects.create(userA, { name: "H-A" });

    await expectDenied(() => h.projects.get(userA, "no-such-project"), "H1 missing project denied");
    await expectDenied(() => h.executions.createQueued(userA, "no-such-project", "x"), "H2 missing project execution denied");

    const userB = mkActor("u-h-b", "ADMIN");
    const pB = await h.projects.create(userB, { name: "H-B" });
    await expectDenied(() => h.executions.createQueued(userA, pB.id, "x"), "H3 client project-id substitution denied");
  }

  section("I - Persistence across reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p168-"));
    const file = join(dir, "auth.db");
    const h1 = makeHarness(file);
    const userA = mkActor("u-i-a", "ADMIN");
    const pA = await h1.projects.create(userA, { name: "I-A" });
    const m = h1.memberships.get(pA.id, userA.id);
    ok(m?.role === "PROJECT_OWNER", "I1 membership persisted");
    h1.db.close();

    const h2 = makeHarness(file);
    const m2 = h2.memberships.get(pA.id, userA.id);
    ok(m2?.role === "PROJECT_OWNER", "I2 membership survives reopen");
    const got = await h2.projects.get(userA, pA.id);
    ok(got.id === pA.id, "I3 authorization still works after reopen");
    h2.db.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  section("J - Concurrency / idempotency");
  {
    const h = makeHarness();
    const userA = mkActor("u-j-a", "ADMIN");
    const pA = await h.projects.create(userA, { name: "J-A" });
    h.memberships.upsert(pA.id, "u-j-extra", "PROJECT_VIEWER");
    h.memberships.upsert(pA.id, "u-j-extra", "PROJECT_OPERATOR");
    const m = h.memberships.get(pA.id, "u-j-extra");
    ok(m?.role === "PROJECT_OPERATOR", "J1 upsert idempotent, role updated");

    const list = h.memberships.listForProject(pA.id);
    const count = list.filter((x) => x.userId === "u-j-extra").length;
    ok(count === 1, "J2 unique active membership");
  }

  section("K - Fail closed");
  {
    const h = makeHarness();
    const owner = mkActor("u-k-1", "OWNER");
    const outsider = mkActor("u-k-2", "ADMIN");
    const p = await h.projects.create(owner, { name: "K-project" });
    await expectDenied(() => h.projects.get(outsider, p.id), "K1 no membership -> deny");

    const bad = mkActor("u-k-3", "NOPE");
    let threw = false;
    try { await h.projects.get(bad, p.id); } catch { threw = true; }
    ok(threw, "K2 unknown role -> deny");
  }

  console.log("\n=== Phase 168 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL: " + (e && e.stack ? e.stack : e)); process.exit(1); });