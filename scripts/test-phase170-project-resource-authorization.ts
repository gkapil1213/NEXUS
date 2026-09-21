// scripts/test-phase170-project-resource-authorization.ts
import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { AuditService } from "../src/core/audit";
import { EventService } from "../src/core/events";
import { ProjectMembershipStore } from "../src/core/project-membership-store";
import { ProjectMembershipService } from "../src/core/project-membership-service";
import {
  ProjectService,
  ExecutionService,
  EvidenceService,
  ArtifactService,
  type ServiceContext,
  type Actor,
} from "../src/core/services";
import { isNexusError } from "../src/core/errors";
import type { User } from "../src/core/types";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }
async function expectFail(fn: () => Promise<any>, msg: string): Promise<string | null> {
  try { await fn(); ok(false, msg + " (no throw)"); return null; }
  catch (e) { const c = isNexusError(e) ? e.code : "?"; ok(true, msg + " [" + c + "]"); return c; }
}

interface H {
  db: Database.Database; engine: SQLiteEngine; ctx: ServiceContext;
  projects: ProjectService; executions: ExecutionService;
  evidence: EvidenceService; artifacts: ArtifactService;
  memberships: ProjectMembershipService; store: ProjectMembershipStore;
}

function makeHarness(file?: string): H {
  const raw = file ? new Database(file) : new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  raw.exec("CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));");
  const engine = SQLiteEngine.fromDatabase(raw);
  const events = new EventService(engine);
  const audit = new AuditService(engine);
  const store = new ProjectMembershipStore(raw);
  const ctx: ServiceContext = { engine, events, audit, memberships: store };
  return {
    db: raw, engine, ctx,
    projects: new ProjectService(ctx),
    executions: new ExecutionService(ctx),
    evidence: new EvidenceService(ctx),
    artifacts: new ArtifactService(ctx),
    memberships: new ProjectMembershipService(ctx),
    store,
  };
}

function mkActor(id: string, role: string, status = "active"): Actor {
  return { id, email: id + "@test.nexus", name: id, role: role as any, status: status as any, created_at: Date.now(), updated_at: Date.now() } as Actor;
}

async function seedUser(h: H, id: string, role = "VIEWER"): Promise<void> {
  const u: User = { id, email: id + "@test.nexus", name: id, role: role as any, status: "active" as any, password_hash: "x", salt: "x", iterations: 1, created_at: Date.now(), updated_at: Date.now() } as User;
  await h.engine.put("users", id, u);
}
async function main(): Promise<void> {
  console.log("=== Phase 170 - Project Resource Authorization ===\n");

  section("A - Evidence read authorization");
  {
    const h = makeHarness();
    const ownerA = mkActor("u-a-ownerA", "ADMIN");
    const pA = await h.projects.create(ownerA, { name: "A-project" });
    const eA = await h.executions.createQueued(ownerA, pA.id, "run A");
    await h.evidence.record(ownerA, eA.id, { type: "log", source: "REAL_EXECUTION", content: "hello" });

    await seedUser(h, "u-a-admin", "ADMIN");
    await seedUser(h, "u-a-op", "ADMIN");
    await seedUser(h, "u-a-vwr", "ADMIN");
    await seedUser(h, "u-a-outsider", "ADMIN");
    h.store.upsert(pA.id, "u-a-admin", "PROJECT_ADMIN");
    h.store.upsert(pA.id, "u-a-op", "PROJECT_OPERATOR");
    h.store.upsert(pA.id, "u-a-vwr", "PROJECT_VIEWER");

    ok((await h.evidence.list(ownerA, eA.id)).length === 1, "A1 owner lists evidence");
    ok((await h.evidence.list(mkActor("u-a-admin", "ADMIN"), eA.id)).length === 1, "A2 admin lists evidence");
    ok((await h.evidence.list(mkActor("u-a-op", "ADMIN"), eA.id)).length === 1, "A3 operator lists evidence");
    ok((await h.evidence.list(mkActor("u-a-vwr", "ADMIN"), eA.id)).length === 1, "A4 viewer lists evidence");
    await expectFail(() => h.evidence.list(mkActor("u-a-outsider", "ADMIN"), eA.id), "A5 outsider denied");

    h.store.suspendSafe(pA.id, "u-a-op");
    await expectFail(() => h.evidence.list(mkActor("u-a-op", "ADMIN"), eA.id), "A6 suspended denied");
    h.store.revokeSafe(pA.id, "u-a-vwr");
    await expectFail(() => h.evidence.list(mkActor("u-a-vwr", "ADMIN"), eA.id), "A7 revoked denied");
  }

  section("B - Evidence verification");
  {
    const h = makeHarness();
    const owner = mkActor("u-b-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "B-project" });
    const e = await h.executions.createQueued(owner, p.id, "run B");
    const rec = await h.evidence.record(owner, e.id, { type: "log", source: "REAL_EXECUTION", content: "verify me" });

    const verified = await h.evidence.verify(owner, rec.id);
    ok(verified.ok === true, "B1 valid verification");

    await seedUser(h, "u-b-outsider", "ADMIN");
    await expectFail(() => h.evidence.verify(mkActor("u-b-outsider", "ADMIN"), rec.id), "B2 unauthorized cannot verify");
    await expectFail(() => h.evidence.verify(owner, "no-such-evidence"), "B3 nonexistent evidence fails closed");

    await h.engine.put("evidence", rec.id, { ...rec, __content: "TAMPERED" });
    const tampered = await h.evidence.verify(owner, rec.id);
    ok(tampered.ok === false, "B4 tamper detected");

    const after = await h.engine.get("evidence", rec.id) as any;
    ok(after && after.__content === "TAMPERED", "B5 verify read-only");
  }

  section("C - Evidence creation");
  {
    const h = makeHarness();
    const owner = mkActor("u-c-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "C-project" });
    const e = await h.executions.createQueued(owner, p.id, "run C");

    const ok1 = await h.evidence.record(owner, e.id, { type: "log", source: "REAL_EXECUTION", content: "authorized" });
    ok(ok1.id.startsWith("evi_"), "C1 authorized creates");

    await seedUser(h, "u-c-outsider", "ADMIN");
    await expectFail(() => h.evidence.record(mkActor("u-c-outsider", "ADMIN"), e.id, { type: "log", source: "REAL_EXECUTION", content: "blocked" }), "C2 unauthorized cannot create");

    const internal = await h.evidence.record(null, e.id, { type: "log", source: "REAL_EXECUTION", content: "internal" });
    ok(internal.id.startsWith("evi_"), "C3 internal null path works");
  }
  section("D - Artifact read authorization");
  {
    const h = makeHarness();
    const owner = mkActor("u-d-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "D-project" });
    const e = await h.executions.createQueued(owner, p.id, "run D");
    await h.artifacts.register(owner, e.id, { kind: "report", name: "r.json", content: '{"ok":true}' });

    await seedUser(h, "u-d-adm", "ADMIN");
    await seedUser(h, "u-d-op", "ADMIN");
    await seedUser(h, "u-d-v", "ADMIN");
    await seedUser(h, "u-d-out", "ADMIN");
    h.store.upsert(p.id, "u-d-adm", "PROJECT_ADMIN");
    h.store.upsert(p.id, "u-d-op", "PROJECT_OPERATOR");
    h.store.upsert(p.id, "u-d-v", "PROJECT_VIEWER");

    ok((await h.artifacts.list(owner, e.id)).length === 1, "D1 owner lists");
    ok((await h.artifacts.list(mkActor("u-d-adm", "ADMIN"), e.id)).length === 1, "D2 admin lists");
    ok((await h.artifacts.list(mkActor("u-d-op", "ADMIN"), e.id)).length === 1, "D3 operator lists");
    ok((await h.artifacts.list(mkActor("u-d-v", "ADMIN"), e.id)).length === 1, "D4 viewer lists");
    await expectFail(() => h.artifacts.list(mkActor("u-d-out", "ADMIN"), e.id), "D5 outsider denied");

    h.store.suspendSafe(p.id, "u-d-op");
    await expectFail(() => h.artifacts.list(mkActor("u-d-op", "ADMIN"), e.id), "D6 suspended denied");
    h.store.revokeSafe(p.id, "u-d-v");
    await expectFail(() => h.artifacts.list(mkActor("u-d-v", "ADMIN"), e.id), "D7 revoked denied");
  }

  section("E - Artifact registration");
  {
    const h = makeHarness();
    const owner = mkActor("u-e-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "E-project" });
    const e = await h.executions.createQueued(owner, p.id, "run E");

    const a = await h.artifacts.register(owner, e.id, { kind: "report", name: "r.json", content: "hello" });
    ok(a.digest.startsWith("sha256:"), "E1 real digest");
    const content = "hello";
    const { digestOf } = await import("../src/core/db");
    const expected = await digestOf(content);
    ok(a.digest === expected, "E2 digest matches sha256 of content");

    await seedUser(h, "u-e-out", "ADMIN");
    await expectFail(() => h.artifacts.register(mkActor("u-e-out", "ADMIN"), e.id, { kind: "report", name: "x.json", content: "no" }), "E3 unauthorized cannot register");

    // internal trusted path
    const internal = await h.artifacts.register(null, e.id, { kind: "report", name: "i.json", content: "internal" });
    ok(internal.id.startsWith("art_"), "E4 internal null path works");

    // fence re-check
    let checks = 0;
    const fenced = { kind: "report", name: "f.json", content: "fenced", canWrite: () => { checks++; return checks <= 1; } };
    await expectFail(() => h.artifacts.register(owner, e.id, fenced), "E5 post-digest fence enforced");
  }

  section("F - Cross-resource isolation");
  {
    const h = makeHarness();
    const ownerA = mkActor("u-f-A", "ADMIN");
    const ownerB = mkActor("u-f-B", "ADMIN");
    const pA = await h.projects.create(ownerA, { name: "F-A" });
    const pB = await h.projects.create(ownerB, { name: "F-B" });
    const eA = await h.executions.createQueued(ownerA, pA.id, "run A");
    const eB = await h.executions.createQueued(ownerB, pB.id, "run B");
    await h.artifacts.register(ownerA, eA.id, { kind: "report", name: "a.json", content: "a" });
    await h.evidence.record(ownerB, eB.id, { type: "log", source: "REAL_EXECUTION", content: "b" });

    await expectFail(() => h.artifacts.list(ownerA, eB.id), "F1 A cannot read B artifacts");
    await expectFail(() => h.evidence.list(ownerA, eB.id), "F2 A cannot read B evidence");
    await expectFail(() => h.artifacts.register(ownerA, eB.id, { kind: "x", name: "x", content: "x" }), "F3 A cannot register into B");
    await expectFail(() => h.evidence.record(ownerA, eB.id, { type: "log", source: "REAL_EXECUTION", content: "x" }), "F4 A cannot record evidence into B");

    // enumeration resistance: same error for missing vs foreign execution
    const miss = await expectFail(() => h.artifacts.list(ownerA, "no-such-exec"), "F5a missing exec");
    const foreign = await expectFail(() => h.artifacts.list(ownerA, eB.id), "F5b foreign exec");
    ok(miss === "EXECUTION_NOT_FOUND", "F5a missing execution is not found");
    ok(foreign === "EXECUTION_NOT_FOUND", "F5b foreign execution masked as not_found");
  }
  section("G - Security invariants");
  {
    const h = makeHarness();
    const owner = mkActor("u-g-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "G-project" });
    const e = await h.executions.createQueued(owner, p.id, "run G");

    // G1: unauthenticated-ish callers (suspended globally) rejected
    const susp = mkActor("u-g-susp", "ADMIN", "suspended");
    await expectFail(() => h.evidence.list(susp, e.id), "G1 globally suspended denied");

    // G2: project membership without required global permission does not bypass global RBAC
    // VIEWER global role lacks artifact:create / evidence:create, even if project owner
    const viewerRole = mkActor("u-g-vglobal", "VIEWER");
    h.store.upsert(p.id, "u-g-vglobal", "PROJECT_VIEWER");
    // but platform-owner bypass applies only to OWNER role, not PROJECT_OWNER membership
    // test evidence.record which gates on evidence:read (VIEWER has evidence:read? no — VIEWER is not evidence:read)
    let rejected = false;
    try { await h.evidence.record(viewerRole, e.id, { type: "log", source: "REAL_EXECUTION", content: "x" }); }
    catch { rejected = true; }
    ok(rejected, "G2 global VIEWER cannot record evidence");

    // G3: no project_id added to execution_jobs
    const cols = h.db.prepare("PRAGMA table_info(execution_jobs)").all() as Array<{ name: string }>;
    const hasProjectId = cols.some((c) => c.name === "project_id");
    ok(!hasProjectId, "G3 execution_jobs still has no project_id");

    // G4: evidence and artifacts tables have no project_id column
    const evCols = h.db.prepare("PRAGMA table_info(evidence)").all() as Array<{ name: string }>;
    const evHasPid = evCols.some((c) => c.name === "project_id");
    const arCols = h.db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    const arHasPid = arCols.some((c) => c.name === "project_id");
    ok(!evHasPid && !arHasPid, "G4 no duplicate project_id on evidence/artifacts");
  }

  section("H - Persistence");
  {
    const dir = mkdtempSync(join(tmpdir(), "p170-"));
    const file = join(dir, "r.db");
    const h1 = makeHarness(file);
    const owner = mkActor("u-h-owner", "ADMIN");
    const p = await h1.projects.create(owner, { name: "H-project" });
    const e = await h1.executions.createQueued(owner, p.id, "run H");
    const ev = await h1.evidence.record(owner, e.id, { type: "log", source: "REAL_EXECUTION", content: "durable" });
    const art = await h1.artifacts.register(owner, e.id, { kind: "report", name: "r.json", content: "durable" });
    h1.db.close();

    const h2 = makeHarness(file);
    const evRec = await h2.engine.get("evidence", ev.id) as any;
    const artRec = await h2.engine.get("artifacts", art.id) as any;
    ok(evRec && evRec.execution_id === e.id, "H1 evidence survives reopen");
    ok(artRec && artRec.execution_id === e.id, "H2 artifact survives reopen");
    ok((await h2.evidence.list(owner, e.id)).length === 1, "H3 evidence auth works after reopen");
    ok((await h2.artifacts.list(owner, e.id)).length === 1, "H4 artifact auth works after reopen");
    await seedUser(h2, "u-h-out", "ADMIN");
    await expectFail(() => h2.artifacts.list(mkActor("u-h-out", "ADMIN"), e.id), "H5 denial survives reopen");
    h2.db.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  section("I - Concurrency");
  {
    const h = makeHarness();
    const owner = mkActor("u-i-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "I-project" });
    const e = await h.executions.createQueued(owner, p.id, "run I");

    // I1: concurrent authorized reads isolated
    const [r1, r2, r3] = await Promise.all([
      h.evidence.list(owner, e.id),
      h.evidence.list(owner, e.id),
      h.evidence.list(owner, e.id),
    ]);
    ok(r1.length === 0 && r2.length === 0 && r3.length === 0, "I1 concurrent reads consistent");

    // I2: concurrent unauthorized reads all denied
    await seedUser(h, "u-i-out", "ADMIN");
    const results = await Promise.allSettled([
      h.evidence.list(mkActor("u-i-out", "ADMIN"), e.id),
      h.evidence.list(mkActor("u-i-out", "ADMIN"), e.id),
      h.evidence.list(mkActor("u-i-out", "ADMIN"), e.id),
    ]);
    ok(results.every((r) => r.status === "rejected"), "I2 concurrent unauthorized all denied");

    // I3: concurrent registration preserves invariants (all succeed with unique ids)
    const [a1, a2, a3] = await Promise.all([
      h.artifacts.register(owner, e.id, { kind: "report", name: "r1.json", content: "one" }),
      h.artifacts.register(owner, e.id, { kind: "report", name: "r2.json", content: "two" }),
      h.artifacts.register(owner, e.id, { kind: "report", name: "r3.json", content: "three" }),
    ]);
    const ids = new Set([a1.id, a2.id, a3.id]);
    ok(ids.size === 3, "I3 concurrent registrations unique");
    ok((await h.artifacts.list(owner, e.id)).length === 3, "I4 list reflects concurrent writes");
  }
  console.log("\n=== Phase 170 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL: " + (e && e.stack ? e.stack : e)); process.exit(1); });
