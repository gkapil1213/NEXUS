// scripts/test-phase169-project-membership-administration.ts
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
import { ProjectService, type ServiceContext, type Actor } from "../src/core/services";
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
  projects: ProjectService; store: ProjectMembershipStore; svc: ProjectMembershipService;
}

function makeHarness(filePath?: string): H {
  const raw = filePath ? new Database(filePath) : new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  raw.exec("CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));");
  const engine = SQLiteEngine.fromDatabase(raw);
  const events = new EventService(engine);
  const audit = new AuditService(engine);
  const store = new ProjectMembershipStore(raw);
  const ctx: ServiceContext = { engine, events, audit, memberships: store };
  const projects = new ProjectService(ctx);
  const svc = new ProjectMembershipService(ctx);
  return { db: raw, engine, ctx, projects, store, svc };
}

function mkActor(id: string, role: string, status = "active"): Actor {
  return { id, email: id + "@test.nexus", name: id, role: role as any, status: status as any, created_at: Date.now(), updated_at: Date.now() } as Actor;
}

async function seedUser(h: H, id: string, role = "VIEWER"): Promise<void> {
  const u: User = { id, email: id + "@test.nexus", name: id, role: role as any, status: "active" as any, password_hash: "x", salt: "x", iterations: 1, created_at: Date.now(), updated_at: Date.now() } as User;
  await h.engine.put("users", id, u);
}
async function main(): Promise<void> {
  console.log("=== Phase 169 - Project Membership Administration ===\n");

  section("A - Member provisioning");
  {
    const h = makeHarness();
    const owner = mkActor("u-a-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "A-project" });
    await seedUser(h, "u-a-t1", "VIEWER");

    ok(h.store.get(p.id, owner.id)?.role === "PROJECT_OWNER", "A1 creator receives PROJECT_OWNER");

    const m = await h.svc.addMember(owner, p.id, "u-a-t1", "PROJECT_VIEWER");
    ok(m.role === "PROJECT_VIEWER" && m.status === "ACTIVE", "A2 add existing user as PROJECT_VIEWER");

    ok(h.store.get(p.id, "u-a-t1")?.role === "PROJECT_VIEWER", "A3 membership persisted");

    const m2 = await h.svc.addMember(owner, p.id, "u-a-t1", "PROJECT_VIEWER");
    ok(m2.membershipId === m.membershipId, "A4 same-role add idempotent");

    await expectFail(() => h.svc.addMember(owner, p.id, "u-a-t1", "PROJECT_ADMIN"), "A5 conflicting role rejected");
    await expectFail(() => h.svc.addMember(owner, p.id, "u-a-ghost", "PROJECT_VIEWER"), "A6 unknown user rejected");
    await expectFail(() => h.svc.addMember(owner, "no-such-project", "u-a-t1", "PROJECT_VIEWER"), "A7 unknown project rejected");

    const rows = h.store.listForProject(p.id).filter((x) => x.userId === "u-a-t1");
    ok(rows.length === 1 && rows[0].role === "PROJECT_VIEWER", "A8 no duplicates, authoritative");
  }

  section("B - Role administration");
  {
    const h = makeHarness();
    const owner = mkActor("u-b-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "B-project" });
    await seedUser(h, "u-b-t1", "VIEWER");
    await h.svc.addMember(owner, p.id, "u-b-t1", "PROJECT_VIEWER");

    const r1 = await h.svc.changeRole(owner, p.id, "u-b-t1", "PROJECT_OPERATOR");
    ok(r1.role === "PROJECT_OPERATOR", "B1 VIEWER -> OPERATOR");

    const r2 = await h.svc.changeRole(owner, p.id, "u-b-t1", "PROJECT_ADMIN");
    ok(r2.role === "PROJECT_ADMIN", "B2 OPERATOR -> ADMIN");

    await expectFail(() => h.svc.changeRole(owner, p.id, "u-b-t1", "PROJECT_OWNER" as any), "B3 cannot assign PROJECT_OWNER via changeRole");
    await expectFail(() => h.svc.changeRole(owner, p.id, "u-b-t1", "BOGUS" as any), "B4 invalid role rejected");
    await expectFail(() => h.svc.changeRole(owner, p.id, "u-b-ghost", "PROJECT_VIEWER"), "B5 nonexistent membership rejected");

    const outsider = mkActor("u-b-out", "ADMIN");
    await expectFail(() => h.svc.changeRole(outsider, p.id, "u-b-t1", "PROJECT_VIEWER"), "B6 unauthorized actor cannot mutate");

    const viewer = mkActor("u-b-v", "ADMIN");
    h.store.upsert(p.id, "u-b-v", "PROJECT_VIEWER");
    await expectFail(() => h.svc.changeRole(viewer, p.id, "u-b-t1", "PROJECT_VIEWER"), "B7 viewer cannot administer");
  }

  section("C - Suspend / restore / revoke");
  {
    const h = makeHarness();
    const owner = mkActor("u-c-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "C-project" });
    await seedUser(h, "u-c-t1", "VIEWER");
    await h.svc.addMember(owner, p.id, "u-c-t1", "PROJECT_OPERATOR");

    const s = await h.svc.suspendMember(owner, p.id, "u-c-t1");
    ok(s.status === "SUSPENDED", "C1 suspend succeeds");
    ok(h.store.get(p.id, "u-c-t1")?.status === "SUSPENDED", "C2 status persisted SUSPENDED");

    let denied = false;
    try { await h.projects.get(mkActor("u-c-t1", "ADMIN"), p.id); } catch { denied = true; }
    ok(denied, "C3 suspended member loses authorization");

    const r = await h.svc.restoreMember(owner, p.id, "u-c-t1");
    ok(r.status === "ACTIVE", "C4 restore succeeds");
    ok(r.role === "PROJECT_OPERATOR", "C5 role preserved after restore");

    const rv = await h.svc.revokeMember(owner, p.id, "u-c-t1");
    ok(rv.status === "REVOKED", "C6 revoke succeeds");

    denied = false;
    try { await h.projects.get(mkActor("u-c-t1", "ADMIN"), p.id); } catch { denied = true; }
    ok(denied, "C7 revoked loses authorization");

    await expectFail(() => h.svc.restoreMember(owner, p.id, "u-c-t1"), "C8 restore on REVOKED rejected");

    const re = await h.svc.addMember(owner, p.id, "u-c-t1", "PROJECT_VIEWER");
    ok(re.status === "ACTIVE" && re.role === "PROJECT_VIEWER", "C9 explicit add re-grants revoked");
  }
  section("D - Last active owner protection");
  {
    const h = makeHarness();
    const owner = mkActor("u-d-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "D-project" });
    await seedUser(h, "u-d-t1", "VIEWER");

    await expectFail(() => h.svc.changeRole(owner, p.id, owner.id, "PROJECT_ADMIN"), "D1 demote sole owner rejected");
    await expectFail(() => h.svc.suspendMember(owner, p.id, owner.id), "D2 suspend sole owner rejected");
    await expectFail(() => h.svc.revokeMember(owner, p.id, owner.id), "D3 revoke sole owner rejected");

    const m = h.store.get(p.id, owner.id);
    ok(m?.status === "ACTIVE" && m?.role === "PROJECT_OWNER", "D4 owner unchanged after failures");
    ok(h.store.countActiveOwners(p.id) === 1, "D5 exactly one active owner");

    await h.svc.addMember(owner, p.id, "u-d-t1", "PROJECT_VIEWER");
    const ch = await h.svc.changeRole(owner, p.id, "u-d-t1", "PROJECT_OPERATOR");
    ok(ch.role === "PROJECT_OPERATOR", "D6 non-owner member changeable");
    ok(h.store.countActiveOwners(p.id) === 1, "D7 still one owner after non-owner change");
  }

  section("E - Ownership transfer");
  {
    const h = makeHarness();
    const ownerA = mkActor("u-e-A", "ADMIN");
    const p = await h.projects.create(ownerA, { name: "E-project" });
    await seedUser(h, "u-e-B", "VIEWER");
    await seedUser(h, "u-e-C", "VIEWER");
    await h.svc.addMember(ownerA, p.id, "u-e-B", "PROJECT_ADMIN");
    await h.svc.addMember(ownerA, p.id, "u-e-C", "PROJECT_OPERATOR");

    const t1 = await h.svc.transferOwnership(ownerA, p.id, ownerA.id, "u-e-B");
    ok(t1.newOwner.role === "PROJECT_OWNER" && t1.newOwner.status === "ACTIVE", "E1 B becomes ACTIVE PROJECT_OWNER");
    ok(t1.demotedOwner.role === "PROJECT_ADMIN", "E2 A becomes PROJECT_ADMIN by default");
    ok(h.store.countActiveOwners(p.id) === 1, "E3 exactly one active owner after transfer");

    const t2 = await h.svc.transferOwnership(mkActor("u-e-B", "ADMIN"), p.id, "u-e-B", "u-e-C", "PROJECT_OPERATOR");
    ok(t2.newOwner.role === "PROJECT_OWNER", "E4 C becomes owner");
    ok(t2.demotedOwner.role === "PROJECT_OPERATOR", "E5 B becomes OPERATOR with explicit demotion role");
    ok(h.store.countActiveOwners(p.id) === 1, "E6 still one active owner");

    await expectFail(() => h.svc.transferOwnership(ownerA, p.id, "u-e-C", "u-e-C"), "E7 self-transfer rejected");
    await expectFail(() => h.svc.transferOwnership(ownerA, p.id, "u-e-A", "u-e-B"), "E8 source not owner rejected");
    await seedUser(h, "u-e-X", "VIEWER");
    await expectFail(() => h.svc.transferOwnership(ownerA, p.id, "u-e-C", "u-e-X"), "E9 inactive target rejected");
    await expectFail(() => h.svc.transferOwnership(ownerA, p.id, "u-e-C", "u-e-B", "PROJECT_OWNER" as any), "E10 demote-to-owner rejected");
    await expectFail(() => h.svc.transferOwnership(mkActor("u-e-outsider", "ADMIN"), p.id, "u-e-C", "u-e-B"), "E11 unauthorized actor rejected");
    ok(h.store.countActiveOwners(p.id) === 1, "E12 ownership state intact after failures");
  }
  section("F - Cross-project isolation");
  {
    const h = makeHarness();
    const ownerA = mkActor("u-f-A", "ADMIN");
    const ownerB = mkActor("u-f-B", "ADMIN");
    const pA = await h.projects.create(ownerA, { name: "F-A" });
    const pB = await h.projects.create(ownerB, { name: "F-B" });
    await seedUser(h, "u-f-t1", "VIEWER");
    await h.svc.addMember(ownerA, pA.id, "u-f-t1", "PROJECT_VIEWER");

    const listA = await h.svc.listMembers(ownerA, pA.id);
    ok(listA.length === 2, "F1 A can list own project members");

    await expectFail(() => h.svc.listMembers(ownerA, pB.id), "F2 A cannot list B memberships");
    await expectFail(() => h.svc.addMember(ownerA, pB.id, "u-f-t1", "PROJECT_VIEWER"), "F3 A cannot add to B");
    await expectFail(() => h.svc.changeRole(ownerA, pB.id, ownerB.id, "PROJECT_ADMIN"), "F4 A cannot change B role");
    await expectFail(() => h.svc.suspendMember(ownerA, pB.id, ownerB.id), "F5 A cannot suspend B member");
    await expectFail(() => h.svc.transferOwnership(ownerA, pB.id, ownerB.id, "u-f-t1"), "F6 A cannot transfer B ownership");

    const errOwn = await expectFail(() => h.svc.listMembers(ownerA, pB.id), "F7a A on B rejected");
    const errMiss = await expectFail(() => h.svc.listMembers(ownerA, "ghost"), "F7b A on ghost rejected");
    ok(errOwn === errMiss, "F7 same error code (enumeration resistant)");
  }

  section("G - Global RBAC + project RBAC");
  {
    const h = makeHarness();
    const owner = mkActor("u-g-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "G-project" });
    await seedUser(h, "u-g-t1", "VIEWER");
    await h.svc.addMember(owner, p.id, "u-g-t1", "PROJECT_OPERATOR");

    // Globally suspended
    await expectFail(() => h.svc.listMembers(mkActor("u-g-susp", "ADMIN", "suspended"), p.id), "G1 globally suspended denied");

    // Global role with no membership:permission
    const noGlobal = mkActor("u-g-v", "VIEWER");
    h.store.upsert(p.id, "u-g-v", "PROJECT_ADMIN");
    await expectFail(() => h.svc.addMember(noGlobal, p.id, "u-g-t1", "PROJECT_VIEWER"), "G2 global VIEWER lacks membership perms even as project admin");

    // Project operator cannot administer
    const op = mkActor("u-g-op", "ADMIN");
    h.store.upsert(p.id, "u-g-op", "PROJECT_OPERATOR");
    await expectFail(() => h.svc.addMember(op, p.id, "u-g-t1", "PROJECT_VIEWER"), "G3 project operator cannot administer");

    // Project viewer cannot administer
    const v = mkActor("u-g-vwr", "ADMIN");
    h.store.upsert(p.id, "u-g-vwr", "PROJECT_VIEWER");
    await expectFail(() => h.svc.addMember(v, p.id, "u-g-t1", "PROJECT_VIEWER"), "G4 project viewer cannot administer");

    // Project admin CAN administer
    const adm = mkActor("u-g-adm", "ADMIN");
    h.store.upsert(p.id, "u-g-adm", "PROJECT_ADMIN");
    await seedUser(h, "u-g-t2", "VIEWER");
    const okAdd = await h.svc.addMember(adm, p.id, "u-g-t2", "PROJECT_VIEWER");
    ok(okAdd.status === "ACTIVE", "G5 project admin can administer");
  }

  section("H - Audit provenance");
  {
    const h = makeHarness();
    const owner = mkActor("u-h-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "H-project" });
    await seedUser(h, "u-h-t1", "VIEWER");
    await h.svc.addMember(owner, p.id, "u-h-t1", "PROJECT_VIEWER");
    await h.svc.changeRole(owner, p.id, "u-h-t1", "PROJECT_OPERATOR");
    await h.svc.suspendMember(owner, p.id, "u-h-t1");
    await h.svc.restoreMember(owner, p.id, "u-h-t1");
    await h.svc.revokeMember(owner, p.id, "u-h-t1");

    await seedUser(h, "u-h-t2", "VIEWER");
    await h.svc.addMember(owner, p.id, "u-h-t2", "PROJECT_ADMIN");
    await h.svc.transferOwnership(owner, p.id, owner.id, "u-h-t2");

    const audits = await h.ctx.audit.list(500) as any[];
    const mine = audits.filter((a) => a.resource_id === p.id && a.resource_type === "project_membership");
    ok(mine.some((a) => a.action === "project.member.add"), "H1 add audited");
    ok(mine.some((a) => a.action === "project.member.role_change"), "H2 role change audited");
    ok(mine.some((a) => a.action === "project.member.suspend"), "H3 suspend audited");
    ok(mine.some((a) => a.action === "project.member.restore"), "H4 restore audited");
    ok(mine.some((a) => a.action === "project.member.revoke"), "H5 revoke audited");
    ok(mine.some((a) => a.action === "project.ownership.transfer"), "H6 transfer audited");

    const addRec = mine.find((a) => a.action === "project.member.add" && a.metadata && (a.metadata as any).target_user === "u-h-t1");
    ok(!!addRec && typeof (addRec as any).actor === "string" && (addRec as any).actor.length > 0, "H7 audit has actor");
    ok(!!addRec && !!(addRec as any).metadata && (addRec as any).metadata.target_user === "u-h-t1", "H8 audit has specific target user");
  }

  section("I - Domain events");
  {
    const h = makeHarness();
    const owner = mkActor("u-i-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "I-project" });
    await seedUser(h, "u-i-t1", "VIEWER");
    await h.svc.addMember(owner, p.id, "u-i-t1", "PROJECT_OPERATOR");
    await h.svc.changeRole(owner, p.id, "u-i-t1", "PROJECT_ADMIN");
    await h.svc.suspendMember(owner, p.id, "u-i-t1");
    await h.svc.restoreMember(owner, p.id, "u-i-t1");
    await seedUser(h, "u-i-t2", "VIEWER");
    await h.svc.addMember(owner, p.id, "u-i-t2", "PROJECT_ADMIN");
    await h.svc.transferOwnership(owner, p.id, owner.id, "u-i-t2");
    await h.svc.revokeMember(mkActor("u-i-t2", "ADMIN"), p.id, "u-i-t1");

    const events = await h.ctx.events.list(500) as any[];
    const mine = events.filter((e) => e.payload && e.payload.project_id === p.id);
    ok(mine.some((e) => e.type === "project.member.added"), "I1 added event");
    ok(mine.some((e) => e.type === "project.member.role_changed"), "I2 role_changed event");
    ok(mine.some((e) => e.type === "project.member.suspended"), "I3 suspended event");
    ok(mine.some((e) => e.type === "project.member.restored"), "I4 restored event");
    ok(mine.some((e) => e.type === "project.member.revoked"), "I5 revoked event");
    ok(mine.some((e) => e.type === "project.ownership.transferred"), "I6 transferred event");

    const added = mine.find((e) => e.type === "project.member.added");
    ok(!!added && added.payload.user_id === "u-i-t1", "I7 event payload has user_id");
    ok(!!added && added.payload.project_id === p.id, "I8 event payload has project_id");
  }
  section("J - Persistence / reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p169-"));
    const file = join(dir, "m.db");
    const h1 = makeHarness(file);
    const owner = mkActor("u-j-owner", "ADMIN");
    const p = await h1.projects.create(owner, { name: "J-project" });
    await seedUser(h1, "u-j-t1", "VIEWER");
    await seedUser(h1, "u-j-t2", "VIEWER");
    await h1.svc.addMember(owner, p.id, "u-j-t1", "PROJECT_OPERATOR");
    await h1.svc.changeRole(owner, p.id, "u-j-t1", "PROJECT_ADMIN");
    await h1.svc.addMember(owner, p.id, "u-j-t2", "PROJECT_ADMIN");
    await h1.svc.transferOwnership(owner, p.id, owner.id, "u-j-t2");
    h1.db.close();

    const h2 = makeHarness(file);
    const m1 = h2.store.get(p.id, "u-j-t1");
    ok(m1?.role === "PROJECT_ADMIN" && m1?.status === "ACTIVE", "J1 roles + statuses survive reopen");
    const m2 = h2.store.get(p.id, "u-j-t2");
    ok(m2?.role === "PROJECT_OWNER" && m2?.status === "ACTIVE", "J2 ownership survives reopen");
    const mA = h2.store.get(p.id, owner.id);
    ok(mA?.role === "PROJECT_ADMIN" && mA?.status === "ACTIVE", "J3 demoted owner role survives reopen");
    ok(h2.store.countActiveOwners(p.id) === 1, "J4 exactly one active owner");
    await seedUser(h2, "u-j-t3", "VIEWER");
    const post = await h2.svc.addMember(mkActor("u-j-t2", "ADMIN"), p.id, "u-j-t3", "PROJECT_VIEWER");
    ok(post.status === "ACTIVE", "J5 authorization + mutation work after reopen");
    h2.db.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  section("K - Unique / concurrency safety");
  {
    const h = makeHarness();
    const owner = mkActor("u-k-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "K-project" });
    await seedUser(h, "u-k-t1", "VIEWER");

    await h.svc.addMember(owner, p.id, "u-k-t1", "PROJECT_VIEWER");
    await h.svc.addMember(owner, p.id, "u-k-t1", "PROJECT_VIEWER");
    const dup = h.store.listForProject(p.id).filter((m) => m.userId === "u-k-t1");
    ok(dup.length === 1, "K1 repeated add -> one row");

    for (let i = 0; i < 5; i++) h.store.upsert(p.id, "u-k-t1", "PROJECT_VIEWER");
    const dup2 = h.store.listForProject(p.id).filter((m) => m.userId === "u-k-t1");
    ok(dup2.length === 1, "K2 repeated upsert -> one row");

    // Raw DB check: unique (project_id, user_id) index exists and is enforced
    const idx = h.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='project_memberships'"
    ).all() as Array<{ name: string }>;
    ok(idx.some((i) => i.name === "uq_pm_project_user"), "K3 unique index present");

    // Concurrent-ish: sequential-interleaved transfer attempts
    await seedUser(h, "u-k-a", "VIEWER");
    await seedUser(h, "u-k-b", "VIEWER");
    h.store.upsert(p.id, "u-k-a", "PROJECT_ADMIN");
    h.store.upsert(p.id, "u-k-b", "PROJECT_ADMIN");
    const r1 = await h.svc.transferOwnership(owner, p.id, owner.id, "u-k-a");
    const r2Attempt = await (async () => { try { return await h.svc.transferOwnership(mkActor("u-k-a","ADMIN"), p.id, owner.id, "u-k-b"); } catch { return null; } })();
    const owners = h.store.countActiveOwners(p.id);
    ok(owners === 1, "K4 interleaved transfers leave exactly one active owner");
  }

  section("L - Fail-closed / security invariants");
  {
    const h = makeHarness();
    const owner = mkActor("u-l-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "L-project" });
    await seedUser(h, "u-l-t1", "VIEWER");

    await expectFail(() => h.svc.addMember(owner, "no-such-project", "u-l-t1", "PROJECT_VIEWER"), "L1 unknown project fails closed");
    await expectFail(() => h.svc.addMember(owner, p.id, "u-l-ghost", "PROJECT_VIEWER"), "L2 unknown user fails closed");
    await expectFail(() => h.svc.addMember(owner, p.id, "u-l-t1", "NOPE" as any), "L3 unknown role fails closed");
    await expectFail(() => h.svc.addMember(owner, p.id, "u-l-t1", "PROJECT_OWNER" as any), "L4 OWNER not assignable via addMember");
    await h.svc.addMember(owner, p.id, "u-l-t1", "PROJECT_VIEWER");
    await expectFail(() => h.svc.changeRole(owner, p.id, "u-l-t1", "PROJECT_OWNER" as any), "L5 OWNER not assignable via changeRole");
    ok(h.store.countActiveOwners(p.id) === 1, "L6 only transferOwnership creates owners");
    await expectFail(() => h.svc.revokeMember(owner, p.id, owner.id), "L7 last owner cannot be revoked");

    const other = mkActor("u-l-other", "ADMIN");
    const pOther = await h.projects.create(other, { name: "L-other" });
    await expectFail(() => h.svc.addMember(owner, pOther.id, "u-l-t1", "PROJECT_VIEWER"), "L8 cross-project mutation denied");
  }

  section("M - Migration 159");
  {
    const h = makeHarness();
    const row = h.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_pm_single_active_owner'"
    ).get() as any;
    ok(!!row, "M1 partial unique index uq_pm_single_active_owner exists");
    ok(typeof row?.sql === "string" && /PROJECT_OWNER/.test(row.sql) && /ACTIVE/.test(row.sql), "M2 index is a partial index scoped to ACTIVE OWNER");
  }

  console.log("\n=== Phase 169 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL: " + (e && e.stack ? e.stack : e)); process.exit(1); });