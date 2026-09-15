// Phase 124 — durable RECOVERY_REQUIRED escalation & resumable reconciliation.
// Uses the REAL ExecutionStore (SQLite) + REAL intent service + REAL
// reconciler + REAL executor. No mock manufactures SUCCESS.
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ExecutionStore } from "../src/core/execution-store";
import type { NexusEngine } from "../src/core/db";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import { ReleaseRecoveryEvidenceReconciler } from "../src/core/release-recovery-evidence-reconciliation";
import { ReleaseRecoveryExecutor } from "../src/core/release-recovery-executor";

let PASS = 0, FAIL = 0;
function ok(c: any, m: string) {
  if (c) { PASS++; console.log("  \u2713 " + m); }
  else   { FAIL++; console.error("  \u2717 " + m); }
}
function section(n: string) { console.log("\n=== " + n + " ==="); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-phase124-"));
const DB_FILE      = path.join(TMP, "nexus.sqlite");
const EVENTS_FILE  = path.join(TMP, "events.json");
const AUDIT_FILE   = path.join(TMP, "audit.json");

function openStore(): ExecutionStore {
  const db = new Database(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS release_deployment_intents (
      intent_key TEXT PRIMARY KEY,
      release_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL, artifact_digest TEXT NOT NULL,
      commit_sha TEXT NOT NULL, environment TEXT NOT NULL, project_id TEXT,
      image_repository TEXT NOT NULL, image_tag TEXT NOT NULL, image_id TEXT,
      intent_kind TEXT NOT NULL DEFAULT 'DEPLOY',
      rollback_target_release_id TEXT, rollback_job_id TEXT,
      image_digest TEXT NOT NULL, container_name TEXT NOT NULL,
      container_port INTEGER NOT NULL, status TEXT NOT NULL,
      deployment_id TEXT, failure_reason TEXT, recovery_reason TEXT,
      leased_by TEXT, lease_expires_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return new ExecutionStore(db as unknown as NexusEngine);
}

class FileEventSink {
  constructor(private file: string) {}
  private read(): any[] { try { return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file,"utf8")) : []; } catch { return []; } }
  private write(rows: any[]) { fs.writeFileSync(this.file, JSON.stringify(rows)); }
  async emit(e: any) { const r = this.read(); r.push({ ...e, eventId: "e_"+r.length+"_"+Date.now(), timestamp: Date.now() }); this.write(r); return { ok:true }; }
  async byExecution(id: string) { return this.read().filter((r:any) => r.execution_id === id); }
  all() { return this.read(); }
}
class FileAuditSink {
  constructor(private file: string) {}
  async record(e: any) { const r = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file,"utf8")) : []; r.push(e); fs.writeFileSync(this.file, JSON.stringify(r)); return { ok:true }; }
  all() { return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file,"utf8")) : []; }
}

function newExecutor(store: ExecutionStore, events: FileEventSink, audit: FileAuditSink, workerId: string, reconciler?: ReleaseRecoveryEvidenceReconciler, rbCounter?: { n:number }) {
  const intents  = new ReleaseDeploymentIntentService(store);
  const recovery = new ReleaseRecoveryService();
  return new ReleaseRecoveryExecutor({
    intents, recovery,
    orchestrator: {} as any, history: {} as any, docker: {} as any, smoke: {} as any,
    svc: { events, audit } as any,
    workerId,
    reconciler,
    rollback: rbCounter ? { async rollback() { rbCounter.n++; return { status:"COMPLETED" as const, deploymentId:null, message:"noop" }; } } : undefined,
  });
}

function seedIntent(store: ExecutionStore, intentKey: string, status: string, extra: any = {}) {
  const intent = {
    intentKey, releaseId: "rel-1", executionId: "exec-" + intentKey,
    artifactId: "art-1", artifactDigest: "digest-art-1", commitSha: "deadbeef",
    environment: "prod", projectId: "proj-1",
    imageRepository: "reg/img", imageTag: "v1", imageId: extra.imageId ?? "sha256:expected",
    intentKind: "ROLLBACK" as const, rollbackTargetReleaseId: "rel-target", rollbackJobId: "job-1",
    imageDigest: "digest-img-1", containerName: "c-1", containerPort: 8080,
    ...extra,
  };
  store.createReleaseIntentIdempotent(intent as any);
  store.updateReleaseIntentStatus(intentKey, status as any, { recoveryReason: extra.recoveryReason ?? null });
  return intent;
}

async function seedStarted(events: FileEventSink, intent: any) {
  await events.emit({ type: "release.recovery.rollback.verification_started", source: "ReleaseRecoveryExecutor", execution_id: intent.executionId, payload: {
    intentKey: intent.intentKey, intentKind: "ROLLBACK", executionId: intent.executionId,
    releaseId: intent.releaseId, artifactId: intent.artifactId,
    expectedArtifactDigest: intent.artifactDigest, expectedImageId: intent.imageId,
    observedImageId: intent.imageId, observedContainerId: "cid-x",
    rollbackTargetReleaseId: intent.rollbackTargetReleaseId,
    stagingUrl: "http://127.0.0.1:9999", hostPort: 9999,
  }});
}

async function main() {
  section("T1: RECOVERY_REQUIRED durably persisted");
  {
    const s = openStore();
    seedIntent(s, "i-t1", "RECOVERY_REQUIRED", { recoveryReason: "seed" });
    const r = s.getReleaseIntent("i-t1");
    ok(r?.status === "RECOVERY_REQUIRED", "status persisted");
    ok(r?.recoveryReason === "seed", "recoveryReason persisted");
  }

  section("T2/T4/T22: survives process/repository reload");
  {
    const s1 = openStore();
    seedIntent(s1, "i-t2", "RECOVERY_REQUIRED", { recoveryReason: "durable" });
    const s2 = openStore();
    ok(s2.getReleaseIntent("i-t2")?.status === "RECOVERY_REQUIRED", "status durable after reopen");
    ok(s2.listRecoverableReleaseIntents().some((x) => x.intentKey === "i-t2"), "listRecoverable includes it");
  }

  section("T3: fresh executor discovers obligation");
  {
    const s = openStore(); seedIntent(s, "i-t3", "RECOVERY_REQUIRED", { recoveryReason: "d" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    const ex = newExecutor(s, ev, au, "w-fresh");
    const r = await ex.runOnce();
    ok(r.scanned >= 1, "scanned >= 1");
    ok(r.actions.some((a) => a.intentKey === "i-t3" && a.action === "RECOVERY_REQUIRED"), "classified RECOVERY_REQUIRED");
  }

  section("T5/T6: two workers, one holds lease");
  {
    const s = openStore(); seedIntent(s, "i-t5", "RECOVERY_REQUIRED", { recoveryReason: "race" });
    const intents = new ReleaseDeploymentIntentService(s);
    const a = intents.acquireLease("i-t5", "w-A", 60_000);
    ok(a.acquired, "A acquired");
    const b = intents.acquireLease("i-t5", "w-B", 60_000);
    ok(!b.acquired, "B blocked");
    ok(b.holder === "w-A", "holder is w-A");
    intents.releaseLease("i-t5", "w-A");
  }

  section("T7: expired lease permits recovery");
  {
    const s = openStore(); seedIntent(s, "i-t7", "RECOVERY_REQUIRED", { recoveryReason: "exp" });
    const intents = new ReleaseDeploymentIntentService(s);
    intents.acquireLease("i-t7", "w-A", 1);
    await new Promise((r) => setTimeout(r, 15));
    const b = intents.acquireLease("i-t7", "w-B", 60_000);
    ok(b.acquired, "B acquired expired lease");
    intents.releaseLease("i-t7", "w-B");
  }

  section("T9: missing evidence stays RECOVERY_REQUIRED");
  {
    const s = openStore(); seedIntent(s, "i-t9", "RECOVERY_REQUIRED", { recoveryReason: "no ev" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    const intents = new ReleaseDeploymentIntentService(s);
    const rec = new ReleaseRecoveryEvidenceReconciler({ intents, events: ev as any, audit: au as any, workerId: "w-rec" });
    const res = await rec.reconcile("i-t9");
    ok(res.verdict === "RECOVERY_REQUIRED" && res.decision === "MISSING", "missing stays RECOVERY_REQUIRED");
  }

  section("T10: contradictory evidence");
  {
    const s = openStore(); const intent = seedIntent(s, "i-t10", "RECOVERY_REQUIRED", { recoveryReason: "con" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    await seedStarted(ev, intent);
    await ev.emit({ type: "release.recovery.rollback.verification_passed", execution_id: intent.executionId, payload: { intentKey: intent.intentKey } });
    await ev.emit({ type: "release.recovery.rollback.verification_failed", execution_id: intent.executionId, payload: { intentKey: intent.intentKey } });
    const rec = new ReleaseRecoveryEvidenceReconciler({ intents: new ReleaseDeploymentIntentService(s), events: ev as any, audit: au as any, workerId: "w-rec" });
    const res = await rec.reconcile("i-t10");
    ok(res.verdict === "RECOVERY_REQUIRED", "contradiction stays RECOVERY_REQUIRED");
  }

  section("T11: identity mismatch fails closed");
  {
    const s = openStore(); const intent = seedIntent(s, "i-t11", "RECOVERY_REQUIRED", { recoveryReason: "id" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    await ev.emit({ type: "release.recovery.rollback.verification_started", execution_id: intent.executionId, payload: {
      intentKey: intent.intentKey, intentKind: "ROLLBACK", executionId: "WRONG",
      releaseId: intent.releaseId, artifactId: intent.artifactId,
      expectedArtifactDigest: intent.artifactDigest, expectedImageId: intent.imageId,
      observedImageId: intent.imageId, observedContainerId: "cid",
      rollbackTargetReleaseId: intent.rollbackTargetReleaseId,
    }});
    await ev.emit({ type: "release.recovery.rollback.verification_passed", execution_id: intent.executionId, payload: { intentKey: intent.intentKey } });
    const rec = new ReleaseRecoveryEvidenceReconciler({ intents: new ReleaseDeploymentIntentService(s), events: ev as any, audit: au as any, workerId: "w-rec" });
    const res = await rec.reconcile("i-t11");
    ok(res.verdict === "RECOVERY_REQUIRED", "identity mismatch => RECOVERY_REQUIRED");
  }

  section("T12: PASS reconciles as terminal");
  {
    const s = openStore(); const intent = seedIntent(s, "i-t12", "FAILED", { recoveryReason: "pass" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    await seedStarted(ev, intent);
    await ev.emit({ type: "release.recovery.rollback.verification_passed", execution_id: intent.executionId, payload: { intentKey: intent.intentKey } });
    await ev.emit({ type: "release.recovery.rollback.verified", execution_id: intent.executionId, payload: { intentKey: intent.intentKey } });
    const rec = new ReleaseRecoveryEvidenceReconciler({ intents: new ReleaseDeploymentIntentService(s), events: ev as any, audit: au as any, workerId: "w-rec" });
    const res = await rec.reconcile("i-t12");
    ok(res.verdict === "CONSISTENT" && res.decision === "VERIFIED", "PASS reconciles");
  }

  section("T13: FAIL reconciles");
  {
    const s = openStore(); const intent = seedIntent(s, "i-t13", "VERIFICATION_FAILED", { recoveryReason: "fail" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    await seedStarted(ev, intent);
    await ev.emit({ type: "release.recovery.rollback.verification_failed", execution_id: intent.executionId, payload: { intentKey: intent.intentKey } });
    const rec = new ReleaseRecoveryEvidenceReconciler({ intents: new ReleaseDeploymentIntentService(s), events: ev as any, audit: au as any, workerId: "w-rec" });
    const res = await rec.reconcile("i-t13");
    ok(res.verdict === "CONSISTENT" && res.decision === "VERIFICATION_FAILED", "FAIL reconciles");
  }

  section("T14: BLOCKED stays RECOVERY_REQUIRED");
  {
    const s = openStore(); const intent = seedIntent(s, "i-t14", "RECOVERY_REQUIRED", { recoveryReason: "blk" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    await seedStarted(ev, intent);
    await ev.emit({ type: "release.recovery.rollback.verification_blocked", execution_id: intent.executionId, payload: { intentKey: intent.intentKey, verificationStatus: "BLOCKED", reason: "x" } });
    const rec = new ReleaseRecoveryEvidenceReconciler({ intents: new ReleaseDeploymentIntentService(s), events: ev as any, audit: au as any, workerId: "w-rec" });
    const res = await rec.reconcile("i-t14");
    ok(res.verdict === "CONSISTENT" && res.currentIntentStatus === "RECOVERY_REQUIRED", "BLOCKED reconciles");
  }

  section("T15: exception stays RECOVERY_REQUIRED");
  {
    const s = openStore(); const intent = seedIntent(s, "i-t15", "RECOVERY_REQUIRED", { recoveryReason: "exc" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    await seedStarted(ev, intent);
    await ev.emit({ type: "release.recovery.rollback.verification_blocked", execution_id: intent.executionId, payload: { intentKey: intent.intentKey, verificationStatus: "EXCEPTION", reason: "threw" } });
    const rec = new ReleaseRecoveryEvidenceReconciler({ intents: new ReleaseDeploymentIntentService(s), events: ev as any, audit: au as any, workerId: "w-rec" });
    const res = await rec.reconcile("i-t15");
    ok(res.verdict === "RECOVERY_REQUIRED" && res.decision === "EXCEPTION", "EXCEPTION never resolves as success");
  }

  section("T16: rollback not repeated after terminal");
  {
    const s = openStore(); seedIntent(s, "i-t16", "FAILED", { recoveryReason: "done" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    const counter = { n: 0 };
    const ex = newExecutor(s, ev, au, "w-t16", undefined, counter);
    await ex.runOnce();
    ok(counter.n === 0, "rollback delegate called 0 times");
  }

  section("T17: no duplicate reconciled event");
  {
    const s = openStore(); seedIntent(s, "i-t17", "RECOVERY_REQUIRED", { recoveryReason: "idem" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    const rec = new ReleaseRecoveryEvidenceReconciler({ intents: new ReleaseDeploymentIntentService(s), events: ev as any, audit: au as any, workerId: "w-rec" });
    await rec.reconcile("i-t17");
    await rec.reconcile("i-t17");
    await rec.reconcile("i-t17");
    const n = ev.all().filter((e: any) => e.type === "release.recovery.rollback.evidence.reconciled" && e.payload?.intentKey === "i-t17").length;
    ok(n === 1, "exactly one reconciled event (got " + n + ")");
  }

  section("T18: audit record durable");
  {
    const s = openStore(); seedIntent(s, "i-t18", "RECOVERY_REQUIRED", { recoveryReason: "audit" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    const rec = new ReleaseRecoveryEvidenceReconciler({ intents: new ReleaseDeploymentIntentService(s), events: ev as any, audit: au as any, workerId: "w-rec" });
    await rec.reconcile("i-t18");
    ok(new FileAuditSink(AUDIT_FILE).all().some((a: any) => a.resource_id === "i-t18"), "audit durable");
  }

  section("T19: no forbidden secrets persisted");
  {
    const s = openStore(); const intent = seedIntent(s, "i-t19", "FAILED", { recoveryReason: "sec" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    await seedStarted(ev, intent);
    await ev.emit({ type: "release.recovery.rollback.verification_passed", execution_id: intent.executionId, payload: { intentKey: intent.intentKey } });
    await ev.emit({ type: "release.recovery.rollback.verified", execution_id: intent.executionId, payload: { intentKey: intent.intentKey } });
    const rec = new ReleaseRecoveryEvidenceReconciler({ intents: new ReleaseDeploymentIntentService(s), events: ev as any, audit: au as any, workerId: "w-rec" });
    await rec.reconcile("i-t19");
    const dump = JSON.stringify(au.all());
    ok(!/password|token|secret|authorization|cookie|api[_-]?key|credential/i.test(dump), "no forbidden key in audit");
  }

  section("T20: persistence failure never manufactures success");
  {
    const s = openStore(); seedIntent(s, "i-t20", "RECOVERY_REQUIRED", { recoveryReason: "pf" });
    const ev = new FileEventSink(EVENTS_FILE), au = new FileAuditSink(AUDIT_FILE);
    const original = s.updateReleaseIntentStatus.bind(s);
    (s as any).updateReleaseIntentStatus = () => { throw new Error("persist down"); };
    const ex = newExecutor(s, ev, au, "w-t20");
    try { await ex.runOnce(); } catch { /* expected */ }
    (s as any).updateReleaseIntentStatus = original;
    ok(s.getReleaseIntent("i-t20")?.status === "RECOVERY_REQUIRED", "status unchanged after failure");
  }

  section("T23: lineage intact");
  {
    const ev = new FileEventSink(EVENTS_FILE);
    const types = new Set(ev.all().map((e: any) => e.type));
    ok(types.has("release.recovery.started"), "started present");
    ok(types.has("release.recovery.completed"), "completed present");
  }

  console.log("\n--- Phase 124: " + PASS + " passed, " + FAIL + " failed ---");
  if (FAIL > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
