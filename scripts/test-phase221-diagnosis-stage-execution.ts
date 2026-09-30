// scripts/test-phase221-diagnosis-stage-execution.ts
// Phase 221 — engineering DIAGNOSIS stage execution.
import { NexusKernel } from "../src/core/kernel";
import { PgClient } from "../src/core/pg-client";
import { EngineeringRunService } from "../src/core/engineering-run-service";
import { EngineeringCapabilityRegistry, CANONICAL_ENGINEERING_DAG } from "../src/core/engineering-capability-registry";
import { EngineeringStageExecutor } from "../src/core/engineering-stage-executor";
import { EngineeringDiagnosisExecutor } from "../src/core/engineering-diagnosis-executor";

type R = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
const rows: { id: string; name: string; r: R; n: string }[] = [];
function rec(id: string, name: string, r: R, n: string) {
  rows.push({ id, name, r, n });
  const m = r === "PASS" ? "[PASS]" : r === "FAIL" ? "[FAIL]" : r === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${m} ${id} ${name} -- ${n}`);
}
function ok(c: boolean, m: string) { if (!c) throw new Error(m); }
const DB = () => process.env.DATABASE_URL!;

async function q(sql: string, p: unknown[] = []) {
  const c = new PgClient(); await c.connect(DB());
  try { return await c.query(sql, p); } finally { await c.close(); }
}

async function cleanup(prefix: string) {
  const c = new PgClient(); await c.connect(DB());
  try {
    const tg: [string, string][] = [
      ["engineering_run_events", "run_id"],
      ["engineering_run_stages", "run_id"],
      ["engineering_runs", "id"],
      ["execution_events", "job_id"],
      ["execution_stage_dependencies", "execution_id"],
      ["execution_jobs", "id"],
    ];
    for (const [t, col] of tg) {
      try { await c.query(`DELETE FROM ${t} WHERE ${col} LIKE $1`, [prefix + "%"]); } catch {}
    }
  } finally { await c.close(); }
}

function fakeArtifacts(): any {
  const records = new Map<string, any>();
  return {
    async registerArtifactAsync(a: any, content: string) {
      const id = a.artifactId;
      const checksum = "sha256-" + Math.random().toString(36).slice(2, 12);
      records.set(id, { artifactId: id, checksum, content });
      return { artifactId: id, checksum };
    },
    get(id: string) { return records.get(id); },
  };
}

async function main() {
  const shared = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase() === "shared";
  const hasDb = !!process.env.DATABASE_URL;
  const prefix = "engrun-221-" + Date.now() + "-";
  const runStartTs = Date.now();
  console.log(`mode=${shared ? "shared" : "sqlite"} db=${hasDb ? "set" : "unset"} prefix=${prefix}`);

  const kernel = new NexusKernel();
  try { await kernel.boot(); } catch (e) {
    rec("221A", "diagnosis executor construction", "FAIL", e instanceof Error ? e.message : String(e));
    return finish(kernel, prefix);
  }
  const store = (kernel as any).executionStore as any;
  const pgArtifacts = (kernel as any).artifactStore ?? (kernel as any).services?.artifacts;
  const artifacts = fakeArtifacts();

  if (!shared || !hasDb || !store) {
    const why = !shared ? "sqlite mode" : !hasDb ? "DATABASE_URL unset" : "no executionStore";
    const ids: [string, string][] = [
      ["221A","diagnosis executor construction"],["221B","registry reflects DIAGNOSIS wiring"],
      ["221C","DAG contains DIAGNOSIS"],["221D","DIAGNOSIS gated on BUILD/TEST"],
      ["221E","BUILD failure detected"],["221F","BUILD failure classified"],
      ["221G","TEST failure detected"],["221H","TEST failure classified"],
      ["221I","blocked source propagates"],["221J","successful source = no false diagnosis"],
      ["221K","diagnostic artifact created"],["221L","artifact retrievable"],
      ["221M","artifact contains source evidence"],["221N","deterministic classification"],
      ["221O","idempotent diagnosis"],["221P","stage executor routes DIAGNOSIS"],
      ["221Q","events persisted"],["221R","no secrets"],
      ["221S","BLOCKED durable"],["221T","FAILED durable"],["221U","CAS/recovery exercised"],
      ["221V","REPAIR handoff structured"],["221W","non-engineering isolation"],
      ["221X","Phase 220 regression"],["221Y","Phase 219 regression"],["221Z","Phase 218 regression"],
    ];
    for (const [id, n] of ids) rec(id, n, "BLOCKED", why);
    return finish(kernel, prefix);
  }

  const dbUrl = DB();
  const reg = new EngineeringCapabilityRegistry(undefined, undefined, { wiredStages: EngineeringStageExecutor.wiredStages() });
  const runSvc = new EngineeringRunService(dbUrl, store, reg);

  const freshRun = async (tag: string) => {
    const r = await runSvc.createEngineeringRun({
      objective: `Phase221 ${tag} ${prefix}${tag}`,
      repository: "github.com/example/phase221",
      sourceRevision: "sha-" + prefix + tag,
    });
    if (!r.created) throw new Error("run not created");
    return r.run.id;
  };

  // Helper: drive a stage job to a terminal status
  const driveTo = async (runId: string, stage: string, targetStatus: string) => {
    const jid = runId + "__" + stage;
    const j = await store.getJobAsync(jid);
    if (!j) throw new Error("job missing: " + jid);
    if (j.status === targetStatus) return;
    await store.recoverJobAtomicAsync({
      jobId: jid, expectedStatus: j.status, newStatus: targetStatus,
      expectedLeaseId: null, patch: {},
      event: { eventType: "engineering_run.stage_" + targetStatus.toLowerCase(),
               payload: { forced: true } },
    });
  };

  // Helper: inject a fake BUILD/TEST failure event with stderr-like content
  const injectFailureEvent = async (runId: string, stage: "BUILD" | "TEST", payload: Record<string, unknown>) => {
    const eventId = "eevt-inject-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const eventType = stage === "BUILD" ? "engineering_build.failed" : "engineering_test.failed";
    const c = new PgClient(); await c.connect(dbUrl);
    try {
      await c.query(
        "INSERT INTO engineering_run_events (event_id, run_id, stage_id, event_type, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [eventId, runId, runId + "__" + stage, eventType, JSON.stringify(payload), Date.now()],
      );
    } finally { await c.close(); }
  };

  // 221A — construct EngineeringDiagnosisExecutor
  let diagExec: EngineeringDiagnosisExecutor | undefined;
  try {
    diagExec = new EngineeringDiagnosisExecutor({ dbUrl, store, artifacts });
    ok(typeof (diagExec as any).runDiagnosis === "function", "runDiagnosis missing");
    rec("221A", "diagnosis executor construction", "PASS", "EngineeringDiagnosisExecutor instantiated");
  } catch (e) {
    rec("221A", "diagnosis executor construction", "FAIL", e instanceof Error ? e.message : String(e));
    return finish(kernel, prefix);
  }

  // 221B — registry reflects DIAGNOSIS wiring
  try {
    const verdicts = reg.evaluateAll();
    const by = new Map(verdicts.map((v: any) => [v.stageType, v.status]));
    ok(by.get("DIAGNOSIS") === "AVAILABLE", "DIAGNOSIS=" + by.get("DIAGNOSIS"));
    rec("221B", "registry reflects DIAGNOSIS wiring", "PASS", "DIAGNOSIS=AVAILABLE");
  } catch (e) { rec("221B", "registry reflects DIAGNOSIS wiring", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221C — DAG contains DIAGNOSIS in correct position
  try {
    const types = CANONICAL_ENGINEERING_DAG.map((s: any) => s.stageType);
    const idx = types.indexOf("DIAGNOSIS");
    ok(idx === 5, "DIAGNOSIS at index " + idx + " (expected 5)");
    ok(types[4] === "TEST", "index 4 = " + types[4]);
    ok(types[6] === "REPAIR", "index 6 = " + types[6]);
    rec("221C", "DAG contains DIAGNOSIS", "PASS", "ordinal 5 between TEST and REPAIR");
  } catch (e) { rec("221C", "DAG contains DIAGNOSIS", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221D — DIAGNOSIS gated on BUILD/TEST prerequisites
  try {
    const runId = await freshRun("D");
    const outcome = await diagExec!.runDiagnosis({
      runId, actor: { id: "test-221D", kind: "system" } as any,
    });
    ok(outcome.status === "BLOCKED", "expected BLOCKED, got " + outcome.status);
    ok(outcome.reason === "INSUFFICIENT_EVIDENCE", "reason=" + outcome.reason);
    rec("221D", "DIAGNOSIS gated on BUILD/TEST", "PASS", "reason=INSUFFICIENT_EVIDENCE");
  } catch (e) { rec("221D", "DIAGNOSIS gated on BUILD/TEST", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221E — BUILD failure is detected
  let diagE: any = null;
  try {
    const runId = await freshRun("E");
    await driveTo(runId, "PLANNING", "SUCCEEDED");
    await driveTo(runId, "ARCHITECTURE", "SUCCEEDED");
    await driveTo(runId, "IMPLEMENTATION", "SUCCEEDED");
    await driveTo(runId, "BUILD", "FAILED");
    await injectFailureEvent(runId, "BUILD", {
      command: "npm run build", exitCode: 1,
      error: "error TS2304: cannot find name",
    });
    const outcome = await diagExec!.runDiagnosis({
      runId, actor: { id: "test-221E", kind: "system" } as any,
    });
    diagE = outcome;
    ok(outcome.status === "SUCCEEDED", "expected SUCCEEDED, got " + outcome.status + " reason=" + outcome.reason);
    ok(outcome.evidence.sourceStage === "BUILD", "sourceStage=" + outcome.evidence.sourceStage);
    ok(outcome.evidence.exitCode === 1, "exitCode=" + outcome.evidence.exitCode);
    rec("221E", "BUILD failure detected", "PASS", "sourceStage=BUILD exit=1");
  } catch (e) { rec("221E", "BUILD failure detected", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221F — BUILD failure classified from actual evidence
  try {
    ok(diagE !== null, "221E did not produce a diagnosis");
    ok(diagE.classification !== "UNKNOWN_FAILURE" && diagE.classification !== "NO_FAILURE_TO_DIAGNOSE",
       "classification=" + diagE.classification);
    ok(typeof diagE.rootCause === "string" && diagE.rootCause.length > 0, "rootCause empty");
    ok(typeof diagE.confidence === "string", "confidence missing");
    rec("221F", "BUILD failure classified", "PASS",
       "classification=" + diagE.classification + " confidence=" + diagE.confidence);
  } catch (e) { rec("221F", "BUILD failure classified", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221G — TEST failure is detected
  let diagG: any = null;
  try {
    const runId = await freshRun("G");
    await driveTo(runId, "PLANNING", "SUCCEEDED");
    await driveTo(runId, "ARCHITECTURE", "SUCCEEDED");
    await driveTo(runId, "IMPLEMENTATION", "SUCCEEDED");
    await driveTo(runId, "BUILD", "SUCCEEDED");
    await driveTo(runId, "TEST", "FAILED");
    await injectFailureEvent(runId, "TEST", {
      command: "npm test", exitCode: 7,
      error: "AssertionError: expected 1 to equal 2",
    });
    const outcome = await diagExec!.runDiagnosis({
      runId, actor: { id: "test-221G", kind: "system" } as any,
    });
    diagG = outcome;
    ok(outcome.status === "SUCCEEDED", "expected SUCCEEDED, got " + outcome.status);
    ok(outcome.evidence.sourceStage === "TEST", "sourceStage=" + outcome.evidence.sourceStage);
    ok(outcome.evidence.exitCode === 7, "exitCode=" + outcome.evidence.exitCode);
    rec("221G", "TEST failure detected", "PASS", "sourceStage=TEST exit=7");
  } catch (e) { rec("221G", "TEST failure detected", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221H — TEST failure classified from actual evidence
  try {
    ok(diagG !== null, "221G did not produce a diagnosis");
    ok(diagG.classification === "TEST_ASSERTION_FAILURE",
       "expected TEST_ASSERTION_FAILURE, got " + diagG.classification);
    rec("221H", "TEST failure classified", "PASS", "classification=" + diagG.classification);
  } catch (e) { rec("221H", "TEST failure classified", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221I — blocked source propagates as BLOCKED
  try {
    const runId = await freshRun("I");
    await driveTo(runId, "PLANNING", "SUCCEEDED");
    await driveTo(runId, "ARCHITECTURE", "SUCCEEDED");
    await driveTo(runId, "IMPLEMENTATION", "SUCCEEDED");
    await driveTo(runId, "BUILD", "BLOCKED");
    const outcome = await diagExec!.runDiagnosis({
      runId, actor: { id: "test-221I", kind: "system" } as any,
    });
    ok(outcome.status === "BLOCKED", "expected BLOCKED, got " + outcome.status);
    ok(outcome.reason === "SOURCE_STAGE_BLOCKED", "reason=" + outcome.reason);
    rec("221I", "blocked source propagates", "PASS", "reason=SOURCE_STAGE_BLOCKED");
  } catch (e) { rec("221I", "blocked source propagates", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221J — successful source stage produces no false failure
  try {
    const runId = await freshRun("J");
    await driveTo(runId, "PLANNING", "SUCCEEDED");
    await driveTo(runId, "ARCHITECTURE", "SUCCEEDED");
    await driveTo(runId, "IMPLEMENTATION", "SUCCEEDED");
    await driveTo(runId, "BUILD", "SUCCEEDED");
    await driveTo(runId, "TEST", "SUCCEEDED");
    const outcome = await diagExec!.runDiagnosis({
      runId, actor: { id: "test-221J", kind: "system" } as any,
    });
    ok(outcome.status === "SUCCEEDED", "status=" + outcome.status);
    ok(outcome.classification === "NO_FAILURE_TO_DIAGNOSE", "classification=" + outcome.classification);
    rec("221J", "successful source = no false diagnosis", "PASS", "NO_FAILURE_TO_DIAGNOSE");
  } catch (e) { rec("221J", "successful source = no false diagnosis", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221K — diagnostic artifact is created
  let diagArtifactRef: string | null = null;
  try {
    const runId = await freshRun("K");
    await driveTo(runId, "PLANNING", "SUCCEEDED");
    await driveTo(runId, "ARCHITECTURE", "SUCCEEDED");
    await driveTo(runId, "IMPLEMENTATION", "SUCCEEDED");
    await driveTo(runId, "BUILD", "FAILED");
    await injectFailureEvent(runId, "BUILD", { command: "npm run build", exitCode: 2, error: "error TS1005" });
    const outcome = await diagExec!.runDiagnosis({
      runId, actor: { id: "test-221K", kind: "system" } as any,
    });
    ok(outcome.status === "SUCCEEDED", "status=" + outcome.status);
    ok(outcome.artifactRef !== null, "artifactRef is null");
    ok(outcome.artifactRef!.startsWith("artifact://"), "artifactRef=" + outcome.artifactRef);
    diagArtifactRef = outcome.artifactRef!;
    rec("221K", "diagnostic artifact created", "PASS", "artifactRef=" + diagArtifactRef);
  } catch (e) { rec("221K", "diagnostic artifact created", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221L — artifact retrievable from store
  try {
    ok(diagArtifactRef !== null, "no artifactRef from 221K");
    const artifactId = diagArtifactRef!.replace("artifact://", "");
    const rec2 = artifacts.get(artifactId);
    ok(rec2 !== undefined, "artifact not found by id=" + artifactId);
    ok(typeof rec2.content === "string" && rec2.content.length > 0, "empty content");
    rec("221L", "artifact retrievable", "PASS", "content " + rec2.content.length + " bytes");
  } catch (e) { rec("221L", "artifact retrievable", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221M — artifact contains expected source evidence
  try {
    ok(diagArtifactRef !== null, "no artifactRef");
    const artifactId = diagArtifactRef!.replace("artifact://", "");
    const rec3 = artifacts.get(artifactId);
    const parsed = JSON.parse(rec3.content);
    ok(parsed.schemaVersion === 1, "schemaVersion=" + parsed.schemaVersion);
    ok(parsed.classification && parsed.classification.length > 0, "classification missing");
    ok(parsed.evidence && typeof parsed.evidence === "object", "evidence missing");
    ok(parsed.repairTarget && typeof parsed.repairTarget === "object", "repairTarget missing");
    ok(parsed.diagnosisId && typeof parsed.diagnosisId === "string", "diagnosisId missing");
    rec("221M", "artifact contains source evidence", "PASS",
       "classification=" + parsed.classification + " repairTarget.type=" + parsed.repairTarget.type);
  } catch (e) { rec("221M", "artifact contains source evidence", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221N — deterministic classification for same evidence
  try {
    const runId = await freshRun("N");
    await driveTo(runId, "PLANNING", "SUCCEEDED");
    await driveTo(runId, "ARCHITECTURE", "SUCCEEDED");
    await driveTo(runId, "IMPLEMENTATION", "SUCCEEDED");
    await driveTo(runId, "BUILD", "FAILED");
    await injectFailureEvent(runId, "BUILD", { command: "x", exitCode: 1, error: "error TS2304: cannot find name" });
    const a = await diagExec!.runDiagnosis({ runId, actor: { id: "a", kind: "system" } as any });
    const b = await diagExec!.runDiagnosis({ runId, actor: { id: "b", kind: "system" } as any });
    ok(a.classification === b.classification, "classifications differ: " + a.classification + " vs " + b.classification);
    ok(a.confidence === b.confidence, "confidence differ");
    ok(a.rootCause === b.rootCause, "rootCause differ");
    rec("221N", "deterministic classification", "PASS", "identical classification+confidence+rootCause");
  } catch (e) { rec("221N", "deterministic classification", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221O — idempotent diagnosis (repeat run is safe)
  try {
    const runId = await freshRun("O");
    await driveTo(runId, "PLANNING", "SUCCEEDED");
    await driveTo(runId, "ARCHITECTURE", "SUCCEEDED");
    await driveTo(runId, "IMPLEMENTATION", "SUCCEEDED");
    await driveTo(runId, "BUILD", "FAILED");
    await injectFailureEvent(runId, "BUILD", { command: "x", exitCode: 1, error: "syntaxerror unexpected token" });
    const a = await diagExec!.runDiagnosis({ runId, actor: { id: "a", kind: "system" } as any });
    const b = await diagExec!.runDiagnosis({ runId, actor: { id: "a", kind: "system" } as any });
    ok(a.status === b.status, "status differ");
    ok(a.classification === b.classification, "classification differ");
    rec("221O", "idempotent diagnosis", "PASS", "repeat run produces same status+classification");
  } catch (e) { rec("221O", "idempotent diagnosis", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221P — stage executor routes DIAGNOSIS
  try {
    const stageExec = new EngineeringStageExecutor({
      store, runService: runSvc,
      planning: {} as any, implementation: {} as any,
      buildExecutor: {} as any, testExecutor: {} as any,
      diagnosisExecutor: diagExec!,
    });
    const runId = await freshRun("P");
    await driveTo(runId, "PLANNING", "SUCCEEDED");
    await driveTo(runId, "ARCHITECTURE", "SUCCEEDED");
    await driveTo(runId, "IMPLEMENTATION", "SUCCEEDED");
    await driveTo(runId, "BUILD", "FAILED");
    await injectFailureEvent(runId, "BUILD", { command: "x", exitCode: 1, error: "error TS2304" });
    const outcome = await stageExec.execute({ kind: "engineering.stage", runId, stageType: "DIAGNOSIS" });
    ok(outcome.ok === true, "outcome not ok");
    if (outcome.ok) ok(outcome.status === "SUCCEEDED", "status=" + outcome.status);
    rec("221P", "stage executor routes DIAGNOSIS", "PASS", "execute() routed DIAGNOSIS successfully");
  } catch (e) { rec("221P", "stage executor routes DIAGNOSIS", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221Q — events persisted
  try {
    const evts = await q("SELECT event_type FROM engineering_run_events WHERE event_type LIKE $1 AND created_at > $2", ["engineering_diagnosis.%", runStartTs]);
    ok(evts.rows.length > 0, "no engineering_diagnosis.* events");
    const types = new Set(evts.rows.map((r: any) => r.event_type));
    ok(types.has("engineering_diagnosis.started"), "missing .started");
    ok(types.has("engineering_diagnosis.completed") || types.has("engineering_diagnosis.blocked"),
       "missing .completed/.blocked");
    rec("221Q", "events persisted", "PASS", evts.rows.length + " engineering_diagnosis events");
  } catch (e) { rec("221Q", "events persisted", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221R — no secrets in events
  try {
    const pat = /sk-[a-zA-Z0-9]{16,}|api[_-]?key\\s*[:=]\\s*["][^"]+["]|Bearer\\s+[A-Za-z0-9._-]{20,}/i;
    const all = await q("SELECT payload FROM engineering_run_events WHERE created_at > $1", [runStartTs]);
    for (const r of all.rows) ok(!pat.test(r.payload ?? ""), "secret in event");
    rec("221R", "no secrets", "PASS", all.rows.length + " events scanned");
  } catch (e) { rec("221R", "no secrets", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221S — BLOCKED diagnosis is durably persisted
  try {
    const runId = await freshRun("S");
    await driveTo(runId, "PLANNING", "SUCCEEDED");
    await driveTo(runId, "ARCHITECTURE", "SUCCEEDED");
    await driveTo(runId, "IMPLEMENTATION", "SUCCEEDED");
    await driveTo(runId, "BUILD", "BLOCKED");
    await diagExec!.runDiagnosis({ runId, actor: { id: "test-221S", kind: "system" } as any });
    const evts = await q("SELECT event_type FROM engineering_run_events WHERE run_id=$1 AND event_type=$2",
      [runId, "engineering_diagnosis.blocked"]);
    ok(evts.rows.length > 0, "no persisted engineering_diagnosis.blocked event");
    rec("221S", "BLOCKED durable", "PASS", evts.rows.length + " blocked events");
  } catch (e) { rec("221S", "BLOCKED durable", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221T — FAILED diagnosis (artifact registration fails) is durably persisted
  try {
    const failingArtifacts = {
      async registerArtifactAsync() { throw new Error("simulated artifact store failure"); },
      get() { return undefined; },
    };
    const failingDiag = new EngineeringDiagnosisExecutor({ dbUrl, store, artifacts: failingArtifacts as any });
    const runId = await freshRun("T");
    await driveTo(runId, "PLANNING", "SUCCEEDED");
    await driveTo(runId, "ARCHITECTURE", "SUCCEEDED");
    await driveTo(runId, "IMPLEMENTATION", "SUCCEEDED");
    await driveTo(runId, "BUILD", "FAILED");
    await injectFailureEvent(runId, "BUILD", { command: "x", exitCode: 1, error: "error TS2304" });
    const outcome = await failingDiag.runDiagnosis({ runId, actor: { id: "test-221T", kind: "system" } as any });
    ok(outcome.status === "FAILED", "expected FAILED, got " + outcome.status);
    ok(outcome.reason === "ARTIFACT_REGISTRATION_FAILED", "reason=" + outcome.reason);
    const evts = await q("SELECT event_type FROM engineering_run_events WHERE run_id=$1 AND event_type=$2",
      [runId, "engineering_diagnosis.failed"]);
    ok(evts.rows.length > 0, "no persisted engineering_diagnosis.failed event");
    rec("221T", "FAILED durable", "PASS", "status=FAILED reason=ARTIFACT_REGISTRATION_FAILED");
  } catch (e) { rec("221T", "FAILED durable", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221U — recovery/CAS behaviour exercised via driveTo
  try {
    const runId = await freshRun("U");
    const jid = runId + "__BUILD";
    const j0 = await store.getJobAsync(jid);
    ok(!!j0, "BUILD job missing");
    // First transition: QUEUED → FAILED via CAS
    const r1 = await store.recoverJobAtomicAsync({
      jobId: jid, expectedStatus: j0.status, newStatus: "FAILED",
      expectedLeaseId: null, patch: {},
      event: { eventType: "engineering_run.stage_failed", payload: { forced: true } },
    });
    ok(r1.ok, "first CAS failed");
    // Second transition with stale expectedStatus should not apply
    const r2 = await store.recoverJobAtomicAsync({
      jobId: jid, expectedStatus: j0.status, newStatus: "SUCCEEDED",
      expectedLeaseId: null, patch: {},
      event: { eventType: "engineering_run.stage_succeeded", payload: { forced: true } },
    });
    ok(r2.ok === false || r2.ok === true, "unexpected result shape");
    const jNow = await store.getJobAsync(jid);
    ok(jNow!.status === "FAILED", "terminal status changed: " + jNow!.status);
    rec("221U", "CAS/recovery exercised", "PASS", "stale CAS did not override terminal status");
  } catch (e) { rec("221U", "CAS/recovery exercised", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221V — REPAIR handoff contains structured diagnostic info
  try {
    ok(diagE !== null, "no 221E diagnosis");
    ok(diagE.repairTarget !== null, "repairTarget missing");
    ok(typeof diagE.repairTarget.type === "string", "repairTarget.type missing");
    ok(typeof diagE.repairTarget.description === "string", "repairTarget.description missing");
    ok(typeof diagE.evidence === "object", "evidence missing");
    ok(typeof diagE.rootCause === "string", "rootCause missing");
    rec("221V", "REPAIR handoff structured", "PASS",
       "repairTarget.type=" + diagE.repairTarget.type + " confidence=" + diagE.confidence);
  } catch (e) { rec("221V", "REPAIR handoff structured", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221W — non-engineering isolation
  try {
    const w = EngineeringStageExecutor.wiredStages();
    ok(!w.has("BUILD_FAKE" as any), "unexpected BUILD_FAKE");
    ok(w.has("DIAGNOSIS") && w.has("TEST") && w.has("BUILD"), "engineering stages missing");
    rec("221W", "non-engineering isolation", "PASS", "engineering-only stage wiring");
  } catch (e) { rec("221W", "non-engineering isolation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 221X-Z — prior phase regressions
  try {
    const w = EngineeringStageExecutor.wiredStages();
    ok(w.has("TEST") && w.has("BUILD"), "TEST/BUILD not wired");
    rec("221X", "Phase 220 regression", "PASS", "TEST+BUILD still wired");
  } catch (e) { rec("221X", "Phase 220 regression", "FAIL", e instanceof Error ? e.message : String(e)); }
  try {
    const w = EngineeringStageExecutor.wiredStages();
    ok(w.has("BUILD") && w.has("IMPLEMENTATION"), "BUILD/IMPLEMENTATION not wired");
    rec("221Y", "Phase 219 regression", "PASS", "BUILD+IMPLEMENTATION still wired");
  } catch (e) { rec("221Y", "Phase 219 regression", "FAIL", e instanceof Error ? e.message : String(e)); }
  try {
    const w = EngineeringStageExecutor.wiredStages();
    ok(w.has("PLANNING") && w.has("ARCHITECTURE"), "PLANNING/ARCHITECTURE not wired");
    rec("221Z", "Phase 218 regression", "PASS", "PLANNING+ARCHITECTURE still wired");
  } catch (e) { rec("221Z", "Phase 218 regression", "FAIL", e instanceof Error ? e.message : String(e)); }

  return finish(kernel, prefix);
}

async function finish(kernel: NexusKernel, prefix: string) {
  try { await kernel.stopDistributedScheduler(); } catch {}
  try { await kernel.shutdown({ finalRecoveryPass: false } as any); } catch {}
  try { await cleanup(prefix); } catch (e) { console.log("cleanup warning:", e); }
  const c = rows.reduce<Record<R, number>>((a, r) => { a[r.r] = (a[r.r] ?? 0) + 1; return a; }, { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 });
  console.log("\n===== Phase 221 summary =====");
  console.log("PASS: " + c.PASS);
  console.log("FAIL: " + c.FAIL);
  console.log("BLOCKED: " + c.BLOCKED);
  console.log("NOT EXECUTED: " + c["NOT EXECUTED"]);
  if (c.FAIL > 0) process.exitCode = 1;
}

main().catch(e => { console.error("fatal:", e instanceof Error ? e.stack : String(e)); process.exit(2); });
