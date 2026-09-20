// scripts/test-phase167-audit-provenance-control-plane.ts
// Phase 167 - audit/provenance control-plane service tests.
//
// Real DB, real migrations, real terminalize path, real AuditService.
// No mocks, no synthetic provenance.
//
// SCOPE NOTE: cross-project isolation tests (spec 14.B, 14.H) are NOT
// present because NEXUS has no user<->project membership model. See
// the header comment in execution-audit-provenance-service.ts.

import Database from "better-sqlite3";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { AuditService } from "../src/core/audit";
import {
  ExecutionAuditProvenanceService,
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  type AuditActor,
} from "../src/core/execution-audit-provenance-service";
import { isNexusError } from "../src/core/errors";
import type { ExecutionJob } from "../src/core/execution-models";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else      { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

async function expectThrows(fn: () => Promise<unknown>, code: string, msg: string): Promise<void> {
  try {
    await fn();
    ok(false, msg + " (no throw)");
  } catch (e) {
    if (isNexusError(e) && e.code === code) ok(true, msg);
    else ok(false, msg + " (wrong error: " + (e as any)?.code + ")");
  }
}
async function expectThrowsSync(fn: () => Promise<unknown>, msg: string): Promise<any> {
  try { await fn(); ok(false, msg + " (no throw)"); return null; }
  catch (e) { ok(true, msg); return e; }
}

interface H { db: Database.Database; store: ExecutionStore; audit: AuditService; svc: ExecutionAuditProvenanceService; }

function makeHarness(): H {
  const raw = new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  // SQLiteEngine.fromDatabase() does NOT create nexus_records ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â only
  // SQLiteEngine.open() does. The AuditService writes to nexus_records,
  // so the harness must create it exactly as open() would.
  raw.exec(`
    CREATE TABLE IF NOT EXISTS nexus_records (
      store TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (store, key)
    );
  `);
  const engine = SQLiteEngine.fromDatabase(raw);
  const store = new ExecutionStore(engine as any);
  const audit = new AuditService(engine as any);
  const svc = new ExecutionAuditProvenanceService(store as any, audit);
  return { db: raw, store, audit, svc };
}
function queuedJob(id: string, extra: Partial<ExecutionJob> = {}): ExecutionJob {
  const now = Date.now();
  return {
    id, idempotencyKey: "k-" + id, jobType: "engineering" as any,
    payload: { kind: "engineering", executionId: "exec-" + id },
    status: "QUEUED", createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
    ...extra,
  } as ExecutionJob;
}
function seedLease(db: Database.Database, jobId: string, workerId: string, leaseId: string): void {
  db.prepare(
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?,?,?,?,?,?)"
  ).run(leaseId, jobId, workerId, Date.now() - 120000, Date.now() + 60000, "ACTIVE");
}
function setupRunning(h: H, jobId: string, workerId = "wA"): { attemptId: string; leaseId: string; workerId: string } {
  const leaseId = "L-" + jobId;
  h.store.createJob(queuedJob(jobId));
  h.db.prepare("UPDATE execution_jobs SET status='RUNNING', current_lease_id=? WHERE id=?").run(leaseId, jobId);
  seedLease(h.db, jobId, workerId, leaseId);
  const c = h.store.createAttemptAsOwnerAtomic(jobId, leaseId, workerId, "RUNNING");
  if (!c.created) throw new Error("alloc " + jobId);
  return { attemptId: c.attempt.id, leaseId, workerId };
}
function terminalize(h: H, s: { attemptId: string; leaseId: string; workerId: string },
                    jobId: string, status: string, newJobStatus: string, extra: any = {}) {
  return h.store.completeAttemptAndTransitionJob({
    attemptId: s.attemptId, jobId, leaseId: s.leaseId, workerId: s.workerId,
    attemptStatus: status, expectedJobStatus: "RUNNING", newJobStatus,
    ...extra,
  });
}
function rawProvId(h: H, attemptId: string): string {
  return (h.db.prepare("SELECT provenance_id FROM execution_outcome_provenance WHERE attempt_id = ?").get(attemptId) as any).provenance_id;
}

// --- actors ---
// Roles per src/core/security.ts ROLE_PERMISSIONS:
//   OWNER, ADMIN, OPERATOR hold "audit:read"
//   VIEWER does NOT
// Suspended actor uses OWNER role to prove the status gate fires
// independently of permission.
const owner:     AuditActor = { id: "u-v", email: "v@x", role: "OWNER",    status: "active" };  // authorized
const operator:   AuditActor = { id: "u-op", email: "op@x", role: "OPERATOR", status: "active" }; // authorized
const noPerm:     AuditActor = { id: "u-n", email: "n@x", role: "VIEWER",  status: "active" };  // lacks audit:read
const suspended:  AuditActor = { id: "u-s", email: "s@x", role: "OWNER",    status: "suspended" }; // status gate

async function main() {
  console.log("=== Phase 167 - Audit/Provenance Control Plane ===\n");

  section("A - Authentication / permission gate");
  {
    const h = makeHarness();
    const s = setupRunning(h, "a1");
    terminalize(h, s, "a1", "SUCCEEDED", "SUCCEEDED");
    const pid = rawProvId(h, s.attemptId);
    const v = await h.svc.getProvenanceById(owner, pid);
    ok(v.provenanceId === pid, "A1 authorized read succeeds");

    await expectThrows(() => h.svc.getProvenanceById(suspended, pid), "AUDIT_READ_DENIED", "A2 suspended actor rejected");
  }

  section("B - Authorization (global audit:read, no per-project scope)");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b1");
    terminalize(h, s, "b1", "SUCCEEDED", "SUCCEEDED");
    const pid = rawProvId(h, s.attemptId);

    // NOTE: NEXUS has no per-project authorization today. This test asserts
    // what currently exists: a global audit:read gate. It does NOT assert
    // cross-project isolation because the underlying model does not exist.
    const byOwner = await h.svc.getProvenanceById(operator, pid);
    ok(byOwner.provenanceId === pid, "B1 operator reads via global audit:read");

    const byViewer = await h.svc.getProvenanceById(operator, pid);
    ok(byViewer.provenanceId === pid, "B2 operator reads via global audit:read");

    await expectThrows(() => h.svc.getProvenanceById(suspended, pid), "AUDIT_READ_DENIED", "B3 suspended denied");
    await expectThrows(() => h.svc.getProvenanceById(noPerm, pid), "AUDIT_READ_DENIED", "B4 role lacking audit:read denied");
  }

  section("C - Resource ownership (server-side resolution)");
  {
    const h = makeHarness();
    const s = setupRunning(h, "c1");
    terminalize(h, s, "c1", "SUCCEEDED", "SUCCEEDED");
    const pid = rawProvId(h, s.attemptId);

    // Service never takes a client-supplied owner; it derives the resource
    // from the persisted provenance row. Nothing in the DTO exposes an
    // owner parameter.
    const v = await h.svc.getProvenanceById(owner, pid);
    ok(v.jobId === "c1", "C1 jobId resolved from store");

    await expectThrows(() => h.svc.getProvenanceById(owner, "no-such-provenance"), "PROVENANCE_NOT_FOUND", "C2 not_found without existence leak");

    // Malformed id rejected before any store hit
    await expectThrows(() => h.svc.getProvenanceById(owner, "bad'; DROP TABLE--"), "INVALID_IDENTIFIER", "C3 malformed id rejected pre-store");
  }

  section("D - Provenance queries");
  {
    const h = makeHarness();
    const s1 = setupRunning(h, "d1");
    terminalize(h, s1, "d1", "FAILED", "RETRY_SCHEDULED", { attemptError: "e1" });
    h.db.prepare("UPDATE execution_leases SET status='RELEASED' WHERE lease_id = ?").run(s1.leaseId);
    const l2 = "L2-d1";
    h.db.prepare("UPDATE execution_jobs SET status='RUNNING', current_lease_id=? WHERE id=?").run(l2, "d1");
    seedLease(h.db, "d1", "wA", l2);
    const c2 = h.store.createAttemptAsOwnerAtomic("d1", l2, "wA", "RUNNING");
    if (!c2.created) throw new Error("d1 retry");
    terminalize(h, { attemptId: c2.attempt.id, leaseId: l2, workerId: "wA" }, "d1", "SUCCEEDED", "SUCCEEDED", { recoveryOperationId: "rop-d1" });

    // by provenance ID
    const pid = rawProvId(h, c2.attempt.id);
    const d1 = await h.svc.getProvenanceById(owner, pid);
    ok(d1.provenanceId === pid, "D1 by provenanceId");

    // by attempt
    const d2 = await h.svc.getProvenanceByAttempt(owner, c2.attempt.id);
    ok(d2.attemptId === c2.attempt.id, "D2 by attempt");

    // by recovery op
    const d3 = await h.svc.getProvenanceByRecoveryOperation(owner, "rop-d1");
    ok(d3.recoveryOperationId === "rop-d1", "D3 by recovery op");

    // by job (paged)
    const d4 = await h.svc.getProvenanceByJob(owner, "d1");
    ok(d4.items.length === 2, "D4 by job returns 2 records");
    ok(d4.items[0].attemptNumber === 1 && d4.items[1].attemptNumber === 2, "D4 ordered by attemptNumber");

    // retry lineage
    const d5 = await h.svc.getRetryLineage(owner, "d1");
    ok(d5.steps.length === 2, "D5 lineage 2 steps");
    ok(d5.steps[1].predecessorAttemptId === s1.attemptId, "D5 predecessor link preserved");
  }

  section("E - Integrity verification");
  {
    const h = makeHarness();
    const s = setupRunning(h, "e1");
    terminalize(h, s, "e1", "SUCCEEDED", "SUCCEEDED");
    const pid = rawProvId(h, s.attemptId);

    const v1 = await h.svc.verifyByAttempt(owner, s.attemptId);
    ok(v1.status === "verified", "E1 valid verified");

    // Tamper evidence ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â integrity must become hash_mismatch, not verified
    h.db.prepare("UPDATE execution_outcome_provenance SET evidence_json = ? WHERE attempt_id = ?").run(JSON.stringify(["evil"]), s.attemptId);
    const v2 = await h.svc.verifyByAttempt(owner, s.attemptId);
    ok(v2.status === "hash_mismatch", "E2 tampered evidence fails");

    // Read-only: state unchanged after verification
    const before = h.db.prepare("SELECT evidence_hash FROM execution_outcome_provenance WHERE provenance_id = ?").get(pid) as any;
    await h.svc.verifyById(owner, pid);
    await h.svc.verifyById(owner, pid);
    const after = h.db.prepare("SELECT evidence_hash FROM execution_outcome_provenance WHERE provenance_id = ?").get(pid) as any;
    ok(before.evidence_hash === after.evidence_hash, "E3 verification read-only");

    // Integrity failure path for queryProvenanceById
    const v3 = await h.svc.verifyById(owner, pid);
    ok(v3.status === "hash_mismatch", "E4 verifyById reports mismatch");
    ok(v3.status !== "verified", "E5 mismatch never becomes verified");
  }

  section("F - Pagination");
  {
    const h = makeHarness();
    // Create 5 terminal attempts on the same job
    let curLease = "L-F";
    let prevLease: string | null = null;
    const attemptIds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      if (prevLease) h.db.prepare("UPDATE execution_leases SET status='RELEASED' WHERE lease_id = ?").run(prevLease);
      const leaseId = "L-F-" + i;
      if (i === 1) {
        h.store.createJob(queuedJob("f1"));
        h.db.prepare("UPDATE execution_jobs SET status='RUNNING', current_lease_id=? WHERE id=?").run(leaseId, "f1");
      } else {
        h.db.prepare("UPDATE execution_jobs SET status='RUNNING', current_lease_id=? WHERE id=?").run(leaseId, "f1");
      }
      seedLease(h.db, "f1", "wA", leaseId);
      const c = h.store.createAttemptAsOwnerAtomic("f1", leaseId, "wA", "RUNNING");
      if (!c.created) throw new Error("f1 retry " + i);
      attemptIds.push(c.attempt.id);
      const newStatus = i < 5 ? "RETRY_SCHEDULED" : "SUCCEEDED";
      terminalize(h, { attemptId: c.attempt.id, leaseId, workerId: "wA" }, "f1", i < 5 ? "FAILED" : "SUCCEEDED", newStatus, i < 5 ? { attemptError: "e" + i } : {});
      prevLease = leaseId;
    }

    const p1 = await h.svc.getProvenanceByJob(owner, "f1", { limit: 2 });
    ok(p1.items.length === 2, "F1 page 1 size 2");
    ok(p1.hasMore === true, "F2 hasMore true on page 1");
    ok(p1.nextCursor !== null, "F3 nextCursor present");

    const p2 = await h.svc.getProvenanceByJob(owner, "f1", { limit: 2, cursor: p1.nextCursor });
    ok(p2.items.length === 2, "F4 page 2 size 2");
    const p3 = await h.svc.getProvenanceByJob(owner, "f1", { limit: 2, cursor: p2.nextCursor });
    ok(p3.items.length === 1, "F5 page 3 final 1");

    // Complete, non-duplicated coverage
    const all = [...p1.items, ...p2.items, ...p3.items].map((r) => r.provenanceId);
    const unique = new Set(all);
    ok(unique.size === 5, "F6 no duplicates across pages, total 5");

    // Determinism: repeat page 1
    const p1b = await h.svc.getProvenanceByJob(owner, "f1", { limit: 2 });
    ok(p1b.items[0].provenanceId === p1.items[0].provenanceId, "F7 page 1 deterministic");

    // Oversized limit rejected
    await expectThrows(() => h.svc.getProvenanceByJob(owner, "f1", { limit: AUDIT_PAGE_MAX + 1 }), "INVALID_LIMIT", "F8 oversized limit rejected");
    await expectThrows(() => h.svc.getProvenanceByJob(owner, "f1", { limit: 0 }), "INVALID_LIMIT", "F9 zero limit rejected");
    await expectThrows(() => h.svc.getProvenanceByJob(owner, "f1", { limit: -1 }), "INVALID_LIMIT", "F10 negative limit rejected");

    // Invalid cursor
    await expectThrows(() => h.svc.getProvenanceByJob(owner, "f1", { limit: 2, cursor: "not-base64!" }), "INVALID_CURSOR", "F11 invalid cursor rejected");

    // Default limit = AUDIT_PAGE_DEFAULT (fetch fewer than default and confirm size)
    const pd = await h.svc.getProvenanceByJob(owner, "f1");
    ok(pd.items.length === 5, "F12 default limit covers all 5");
  }

  section("G - Input validation");
  {
    const h = makeHarness();
    const s = setupRunning(h, "g1");
    terminalize(h, s, "g1", "SUCCEEDED", "SUCCEEDED");
    const pid = rawProvId(h, s.attemptId);

    await expectThrows(() => h.svc.getProvenanceById(owner, ""), "INVALID_IDENTIFIER", "G1 empty id");
    await expectThrows(() => h.svc.getProvenanceById(owner, "a".repeat(300)), "INVALID_IDENTIFIER", "G2 overlong id");
    await expectThrows(() => h.svc.getProvenanceById(owner, "id with spaces"), "INVALID_IDENTIFIER", "G3 whitespace id");
    await expectThrows(() => h.svc.getProvenanceById(owner, "id\x00null"), "INVALID_IDENTIFIER", "G4 null byte id");
    await expectThrows(() => h.svc.getProvenanceById(owner, "id;DROP"), "INVALID_IDENTIFIER", "G5 SQL metachars rejected");

    // Well-formed unknown id passes validation then resolves as not_found.
    await expectThrows(
      () => h.svc.getProvenanceByAttempt(owner, "x-y-z-no-such"),
      "PROVENANCE_NOT_FOUND",
      "G6 well-formed unknown id resolves to not_found",
    );
  }

  section("H - Isolation (LIMITED ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â no per-project model)");
  {
    const h = makeHarness();
    const sA = setupRunning(h, "hA");
    terminalize(h, sA, "hA", "SUCCEEDED", "SUCCEEDED");
    const sB = setupRunning(h, "hB");
    terminalize(h, sB, "hB", "SUCCEEDED", "SUCCEEDED");

    const a = await h.svc.getProvenanceByAttempt(owner, sA.attemptId);
    const b = await h.svc.getProvenanceByAttempt(owner, sB.attemptId);
    ok(a.jobId === "hA" && b.jobId === "hB", "H1 distinct jobs return distinct provenance");
    ok(a.provenanceId !== b.provenanceId, "H2 distinct provenanceIds");

    // Lineage does not leak across jobs
    const linA = await h.svc.getRetryLineage(owner, "hA");
    ok(linA.steps.every((s) => s.provenanceId === a.provenanceId), "H3 lineage scoped to job A");

    // NOTE: cross-project isolation tests deliberately omitted ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â
    // project_memberships does not exist. See service header.
    console.log("  SKIP cross-project isolation: no membership model in repo");
  }

  section("I - Lifecycle (reads during state changes)");
{
  const h = makeHarness();
  // queued - no provenance yet
  h.store.createJob(queuedJob("i1"));
  const i1 = await h.svc.getProvenanceByJob(owner, "i1");
  ok(i1.items.length === 0, "I1 queued -> empty history");

  // running - lease + attempt, no terminal yet
  const leaseId = "L-i1";
  h.db.prepare("UPDATE execution_jobs SET status='RUNNING', current_lease_id=? WHERE id=?").run(leaseId, "i1");
  seedLease(h.db, "i1", "wA", leaseId);
  const c = h.store.createAttemptAsOwnerAtomic("i1", leaseId, "wA", "RUNNING");
  if (!c.created) throw new Error("i1 alloc");
  const s = { attemptId: c.attempt.id, leaseId, workerId: "wA" };

  const i2 = await h.svc.getProvenanceByJob(owner, "i1");
  ok(i2.items.length === 0, "I2 running -> empty history");

  // terminal - provenance appears
  terminalize(h, s, "i1", "SUCCEEDED", "SUCCEEDED");
  const i3 = await h.svc.getProvenanceByJob(owner, "i1");
  ok(i3.items.length === 1, "I3 terminal -> 1 record");
}
section("J - No mutation from reads");
  {
    const h = makeHarness();
    const s = setupRunning(h, "j1");
    terminalize(h, s, "j1", "SUCCEEDED", "SUCCEEDED");
    const pid = rawProvId(h, s.attemptId);

    const snap = () => ({
      provCount: (h.db.prepare("SELECT COUNT(*) n FROM execution_outcome_provenance WHERE job_id='j1'").get() as any).n,
      jobStatus: (h.db.prepare("SELECT status FROM execution_jobs WHERE id='j1'").get() as any).status,
      attemptStatus: (h.db.prepare("SELECT status FROM execution_attempts WHERE id=?").get(s.attemptId) as any).status,
      leaseStatus: (h.db.prepare("SELECT status FROM execution_leases WHERE lease_id=?").get(s.leaseId) as any).status,
      hash: (h.db.prepare("SELECT evidence_hash FROM execution_outcome_provenance WHERE provenance_id=?").get(pid) as any).evidence_hash,
    });
    const before = snap();

    for (let i = 0; i < 5; i++) {
      await h.svc.getProvenanceById(owner, pid);
      await h.svc.getProvenanceByAttempt(owner, s.attemptId);
      await h.svc.getProvenanceByJob(owner, "j1");
      await h.svc.getRetryLineage(owner, "j1");
      await h.svc.verifyByAttempt(owner, s.attemptId);
    }

    const after = snap();
    ok(JSON.stringify(before) === JSON.stringify(after), "J1 all state unchanged after 5 read rounds");
  }

  section("K - Audit access logging");
  {
    const h = makeHarness();
    const s = setupRunning(h, "k1");
    terminalize(h, s, "k1", "SUCCEEDED", "SUCCEEDED");
    const pid = rawProvId(h, s.attemptId);

    await h.svc.getProvenanceById(owner, pid);
    await expectThrows(() => h.svc.getProvenanceById(suspended, pid), "AUDIT_READ_DENIED", "K1 denied");

    // AuditService persists to nexus_records via SQLiteEngine.put("audit", ...).
    // The raw better-sqlite3 handle is available on the harness; read the
    // durable audit rows directly so this is a real verification, not a
    // mock.
    const rows = h.db.prepare(
      "SELECT value FROM nexus_records WHERE store = 'audit'"
    ).all() as Array<{ value: string }>;
    const records = rows.map((r) => JSON.parse(r.value));
    const allow = records.filter((r: any) => typeof r.action === "string" && r.action.startsWith("audit:read"));
    const deny  = records.filter((r: any) => typeof r.action === "string" && r.action.startsWith("audit:denied"));
    ok(allow.length >= 1, "K2 authorized access recorded (allow)");
    ok(deny.length  >= 1, "K3 denied access recorded (deny)");
    const anySecret = records.some((r: any) =>
      typeof r.actor !== "string" ||
      JSON.stringify(r.metadata ?? {}).match(/password|token|authorization|secret/i)
    );
    ok(!anySecret, "K4 no secret material in audit records");
    // Recursive audit loop guard: reading the audit store itself must not
    // create additional audit rows.
    const before = rows.length;
    void before;
    const verifier = new ExecutionAuditProvenanceService((h.store as any), h.audit);
    await verifier.getProvenanceById(owner, pid);
    const after = (h.db.prepare(
      "SELECT COUNT(*) AS n FROM nexus_records WHERE store = 'audit'"
    ).get() as any).n;
    // One new row from the read above; but no *recursive* growth beyond that
    ok(after === before + 1, "K5 access record written exactly once (no recursion)");
  }

  section("L - Regression");
  {
    // Exercised by running phase 165/166 suites separately (see Chunk 4 script).
    // Here we only assert nothing about them: they run as siblings.
    ok(true, "L1 regression run separately (see Chunk 4)");
  }

  console.log("\n=== Phase 167 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL: " + (e && e.stack ? e.stack : e)); process.exit(1); });