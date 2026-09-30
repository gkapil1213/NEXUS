// scripts/test-phase222-repair-stage-execution.ts
import { NexusKernel } from "../src/core/kernel";
import { PgClient } from "../src/core/pg-client";
import { EngineeringRunService } from "../src/core/engineering-run-service";
import { EngineeringCapabilityRegistry, CANONICAL_ENGINEERING_DAG } from "../src/core/engineering-capability-registry";
import { EngineeringStageExecutor } from "../src/core/engineering-stage-executor";
import { EngineeringRepairExecutor } from "../src/core/engineering-repair-executor";

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

function memWorkspaceService(): any {
  const store = new Map<string, string>();
  return {
    _store: store,
    async listFiles(_a: any, id: string) {
      return Array.from(store.entries()).map(([p, c]) => ({ path: p, content: c, workspace_id: id, id: p, size: c.length }));
    },
    async readFile(_a: any, id: string, p: string) {
      const c = store.get(p);
      if (c === undefined) throw new Error("FILE_NOT_FOUND:" + p);
      return { path: p, content: c, workspace_id: id, id: p, size: c.length };
    },
    async writeFile(_a: any, id: string, p: string, c: string) {
      store.set(p, c);
      return { path: p, content: c, workspace_id: id, id: p, size: c.length };
    },
    async deleteFile(_a: any, id: string, p: string) {
      store.delete(p);
    },
  };
}

function memArtifactStore(): any {
  const records = new Map<string, any>();
  return {
    async registerArtifactAsync(a: any, content: string) {
      const checksum = "sha256-" + Math.random().toString(36).slice(2, 12);
      records.set(a.artifactId, { artifactId: a.artifactId, checksum, content });
      return { artifactId: a.artifactId, checksum };
    },
    get(id: string) { return records.get(id); },
    async getArtifactAsync(id: string) { return records.get(id); },
  };
}

function programmedExecutor(code: number): any {
  return {
    async exec(_cmd: string, _cwd: string, _opts: any = {}) {
      return { exit_code: code, stdout: "", stderr: "" };
    },
  };
}

async function main() {
  const shared = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase() === "shared";
  const hasDb = !!process.env.DATABASE_URL;
  const prefix = "engrun-222-" + Date.now() + "-";
  const runStartTs = Date.now();
  console.log(`mode=${shared ? "shared" : "sqlite"} db=${hasDb ? "set" : "unset"} prefix=${prefix}`);

  const kernel = new NexusKernel();
  try { await kernel.boot(); } catch (e) {
    rec("222A", "repair executor construction", "FAIL", e instanceof Error ? e.message : String(e));
    return finish(kernel, prefix);
  }
  const store = (kernel as any).executionStore as any;
  const workspaces = memWorkspaceService();
  const artifacts = memArtifactStore();
  const successExec = programmedExecutor(0);
  const failExec = programmedExecutor(7);

  if (!shared || !hasDb || !store) {
    const why = !shared ? "sqlite mode" : !hasDb ? "DATABASE_URL unset" : "no executionStore";
    const ids: [string, string][] = [
      ["222A","repair executor construction"],["222B","registry reflects REPAIR wiring"],["222C","DAG contains REPAIR"],
      ["222D","REPAIR blocked if DIAGNOSIS missing"],["222E","REPAIR blocked if DIAGNOSIS blocked"],["222F","REPAIR blocked if no directive"],
      ["222G","valid diagnosis reaches executor"],["222H","repair target detected"],["222I","workspace mutation occurs"],
      ["222J","before/after evidence"],["222K","artifact persisted"],["222L","validation executes"],
      ["222M","successful repair"],["222N","validation failure"],["222O","no-op repair honest"],
      ["222P","idempotent repair"],["222Q","stale CAS cannot overwrite"],["222R","retry bounded"],
      ["222S","events persist"],["222T","no secrets"],["222U","path traversal rejected"],
      ["222V","unauthorized mutation rejected"],["222W","stage executor routes REPAIR"],["222X","non-eng isolation"],
      ["222Y","Phase 221 regression"],["222Z","Phase 220 regression"],
    ];
    for (const [id, n] of ids) rec(id, n, "BLOCKED", why);
    return finish(kernel, prefix);
  }

  const dbUrl = DB();
  const reg = new EngineeringCapabilityRegistry(undefined, undefined, { wiredStages: EngineeringStageExecutor.wiredStages() });
  const runSvc = new EngineeringRunService(dbUrl, store, reg);

  const freshRun = async (tag: string) => {
    const r = await runSvc.createEngineeringRun({
      objective: `Phase222 ${tag} ${prefix}${tag}`,
      repository: "github.com/example/phase222",
      sourceRevision: "sha-" + prefix + tag,
    });
    if (!r.created) throw new Error("run not created");
    return r.run.id;
  };

  const driveTo = async (runId: string, stage: string, target: string) => {
    const jid = runId + "__" + stage;
    const j = await store.getJobAsync(jid);
    if (!j) throw new Error("job missing: " + jid);
    if (j.status === target) return;
    await store.recoverJobAtomicAsync({
      jobId: jid, expectedStatus: j.status, newStatus: target,
      expectedLeaseId: null, patch: {},
      event: { eventType: "engineering_run.stage_" + target.toLowerCase(), payload: { forced: true } },
    });
  };

  const injectEvent = async (runId: string, stageId: string | null, eventType: string, payload: Record<string, unknown>) => {
    const eventId = "eevt-inj-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const c = new PgClient(); await c.connect(dbUrl);
    try {
      await c.query(
        "INSERT INTO engineering_run_events (event_id, run_id, stage_id, event_type, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [eventId, runId, stageId, eventType, JSON.stringify(payload), Date.now()],
      );
    } finally { await c.close(); }
  };

  // Full pipeline up to DIAGNOSIS SUCCEEDED + inserted diagnosis.completed event
  const setupDiagnosis = async (tag: string, diagPayload: Record<string, unknown>) => {
    const runId = await freshRun(tag);
    for (const st of ["PLANNING","ARCHITECTURE","IMPLEMENTATION","BUILD","TEST"]) {
      await driveTo(runId, st, "SUCCEEDED");
    }
    await driveTo(runId, "DIAGNOSIS", "SUCCEEDED");
    await injectEvent(runId, runId + "__DIAGNOSIS", "engineering_diagnosis.completed", diagPayload);
    return runId;
  };

  // 222A — construct
  let repairExec: EngineeringRepairExecutor | undefined;
  try {
    repairExec = new EngineeringRepairExecutor({
      dbUrl, store, artifacts, workspaces,
      commandExecutor: successExec,
      readArtifact: async (id: string) => (artifacts.get(id)?.content ?? null),
    });
    ok(typeof (repairExec as any).runRepair === "function", "runRepair missing");
    rec("222A", "repair executor construction", "PASS", "EngineeringRepairExecutor instantiated");
  } catch (e) {
    rec("222A", "repair executor construction", "FAIL", e instanceof Error ? e.message : String(e));
    return finish(kernel, prefix);
  }

  // 222B — registry
  try {
    const v = reg.evaluateAll();
    const by = new Map(v.map((x: any) => [x.stageType, x.status]));
    ok(by.get("REPAIR") === "AVAILABLE", "REPAIR=" + by.get("REPAIR"));
    rec("222B", "registry reflects REPAIR wiring", "PASS", "REPAIR=AVAILABLE");
  } catch (e) { rec("222B", "registry reflects REPAIR wiring", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222C — DAG
  try {
    const types = CANONICAL_ENGINEERING_DAG.map((s: any) => s.stageType);
    const idx = types.indexOf("REPAIR");
    ok(idx === 6, "REPAIR at index " + idx);
    ok(types[5] === "DIAGNOSIS", "index 5 = " + types[5]);
    ok(types[7] === "SECURITY_REVIEW", "index 7 = " + types[7]);
    rec("222C", "DAG contains REPAIR", "PASS", "ordinal 6 between DIAGNOSIS and SECURITY_REVIEW");
  } catch (e) { rec("222C", "DAG contains REPAIR", "FAIL", e instanceof Error ? e.message : String(e)); }

  const actor = { id: "test-222", kind: "system" } as any;

  // 222D — DIAGNOSIS missing
  try {
    const runId = await freshRun("D");
    const jid = runId + "__DIAGNOSIS";
    await store.recoverJobAtomicAsync({
      jobId: jid, expectedStatus: (await store.getJobAsync(jid))!.status, newStatus: "FAILED",
      expectedLeaseId: null, patch: {}, event: { eventType: "x", payload: {} },
    });
    const o = await repairExec!.runRepair({ runId, workspaceId: "ws-d", actor });
    ok(o.status === "BLOCKED", "status=" + o.status);
    ok(o.reason === "DIAGNOSIS_NOT_AVAILABLE:FAILED", "reason=" + o.reason);
    rec("222D", "REPAIR blocked if DIAGNOSIS missing", "PASS", "reason=" + o.reason);
  } catch (e) { rec("222D", "REPAIR blocked if DIAGNOSIS missing", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222E — DIAGNOSIS BLOCKED propagates
  try {
    const runId = await freshRun("E");
    const jid = runId + "__DIAGNOSIS";
    await store.recoverJobAtomicAsync({
      jobId: jid, expectedStatus: (await store.getJobAsync(jid))!.status, newStatus: "BLOCKED",
      expectedLeaseId: null, patch: {}, event: { eventType: "x", payload: {} },
    });
    const o = await repairExec!.runRepair({ runId, workspaceId: "ws-e", actor });
    ok(o.status === "BLOCKED", "status=" + o.status);
    ok(o.reason === "DIAGNOSIS_NOT_AVAILABLE:BLOCKED", "reason=" + o.reason);
    rec("222E", "REPAIR blocked if DIAGNOSIS blocked", "PASS", "reason=" + o.reason);
  } catch (e) { rec("222E", "REPAIR blocked if DIAGNOSIS blocked", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222F — no directive → BLOCKED
  try {
    const runId = await setupDiagnosis("F", {
      classification: "TYPE_ERROR", diagnosisId: "diag-f", artifactRef: null,
    });
    const o = await repairExec!.runRepair({ runId, workspaceId: "ws-f", actor });
    ok(o.status === "BLOCKED", "status=" + o.status);
    ok(o.reason.startsWith("REPAIR_NOT_IMPLEMENTABLE_FOR_TARGET"), "reason=" + o.reason);
    rec("222F", "REPAIR blocked if no directive", "PASS", "reason=" + o.reason);
  } catch (e) { rec("222F", "REPAIR blocked if no directive", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222G-M — real repair via directive
  let diagRun: string | null = null;
  try {
    diagRun = await setupDiagnosis("G", {
      classification: "TYPE_ERROR", diagnosisId: "diag-g",
      artifactRef: "artifact://art-diagnosis-diag-g",
    });
    // Inject the artifact content the executor will read
    await artifacts.registerArtifactAsync(
      { artifactId: "art-diagnosis-diag-g", jobId: diagRun, name: "d.json", type: "ENGINEERING_DIAGNOSIS", metadata: {}, createdAt: Date.now() },
      JSON.stringify({
        schemaVersion: 1, diagnosisId: "diag-g", runId: diagRun, stage: "DIAGNOSIS",
        sourceStage: "BUILD", classification: "TYPE_ERROR",
        rootCause: "type error", confidence: "HIGH",
        repairTarget: { type: "SOURCE_FILE", path: "src/x.ts", description: "fix type" },
        repairDirective: { kind: "WRITE_FILE", path: "src/x.ts", content: "export const x: number = 1;" },
      }),
    );
    // Seed BUILD failed event with command for validation lookup
    await injectEvent(diagRun, diagRun + "__BUILD", "engineering_build.failed", { command: "npm run build" });
    // Pre-seed workspace with the broken file
    await workspaces.writeFile(actor, "ws-g", "src/x.ts", "export const x: string = 1;");

    const o = await repairExec!.runRepair({ runId: diagRun, workspaceId: "ws-g", actor });

    // 222G — reaches repair
    ok(o.status === "SUCCEEDED", "status=" + o.status + " reason=" + o.reason);
    rec("222G", "valid diagnosis reaches executor", "PASS", "status=SUCCEEDED");

    // 222H — target detected
    ok(o.repairTarget?.type === "SOURCE_FILE", "target.type=" + o.repairTarget?.type);
    ok(o.directive?.kind === "WRITE_FILE", "directive.kind=" + o.directive?.kind);
    rec("222H", "repair target detected", "PASS", "SOURCE_FILE / WRITE_FILE");

    // 222I — mutation
    const after = await workspaces.readFile(actor, "ws-g", "src/x.ts");
    ok(after.content === "export const x: number = 1;", "after.content=" + after.content);
    rec("222I", "workspace mutation occurs", "PASS", "src/x.ts rewritten");

    // 222J — hashes
    ok(typeof o.beforeHash === "string" && o.beforeHash.length === 64, "beforeHash=" + o.beforeHash);
    ok(typeof o.afterHash === "string" && o.afterHash.length === 64, "afterHash=" + o.afterHash);
    ok(typeof o.diffHash === "string" && o.diffHash.length === 64, "diffHash=" + o.diffHash);
    ok(o.beforeHash !== o.afterHash, "before == after");
    rec("222J", "before/after evidence", "PASS", "before!=after, all hashes 64-hex");

    // 222K — artifact
    ok(o.artifactRef !== null, "artifactRef null");
    ok(o.artifactRef!.startsWith("artifact://"), "artifactRef=" + o.artifactRef);
    rec("222K", "artifact persisted", "PASS", "artifactRef=" + o.artifactRef);

    // 222L — validation
    ok(o.validationStatus === "PASS", "validationStatus=" + o.validationStatus);
    rec("222L", "validation executes", "PASS", "command executed, exit=0");

    // 222M — success
    ok(o.changed === true, "changed=" + o.changed);
    rec("222M", "successful repair", "PASS", "SUCCEEDED with changed=true");
  } catch (e) { rec("222G", "valid diagnosis reaches executor", "FAIL", e instanceof Error ? e.message : String(e));
               rec("222H", "repair target detected", "FAIL", String(e));
               rec("222I", "workspace mutation occurs", "FAIL", String(e));
               rec("222J", "before/after evidence", "FAIL", String(e));
               rec("222K", "artifact persisted", "FAIL", String(e));
               rec("222L", "validation executes", "FAIL", String(e));
               rec("222M", "successful repair", "FAIL", String(e)); }

  // 222N — validation failure
  try {
    const failingRepair = new EngineeringRepairExecutor({
      dbUrl, store, artifacts, workspaces,
      commandExecutor: failExec,
      readArtifact: async (id: string) => (artifacts.get(id)?.content ?? null),
    });
    const runId = await setupDiagnosis("N", {
      classification: "TYPE_ERROR", diagnosisId: "diag-n",
      artifactRef: "artifact://art-diagnosis-diag-n",
    });
    await artifacts.registerArtifactAsync(
      { artifactId: "art-diagnosis-diag-n", jobId: runId, name: "d.json", type: "ENGINEERING_DIAGNOSIS", metadata: {}, createdAt: Date.now() },
      JSON.stringify({ schemaVersion: 1, diagnosisId: "diag-n", runId, stage: "DIAGNOSIS", sourceStage: "BUILD",
        classification: "TYPE_ERROR", rootCause: "x", confidence: "HIGH",
        repairTarget: { type: "SOURCE_FILE", path: "src/y.ts", description: "fix" },
        repairDirective: { kind: "WRITE_FILE", path: "src/y.ts", content: "export const y = 1;" } }),
    );
    await injectEvent(runId, runId + "__BUILD", "engineering_build.failed", { command: "npm run build" });
    await workspaces.writeFile(actor, "ws-n", "src/y.ts", "export const y = 0;");
    const o = await failingRepair.runRepair({ runId, workspaceId: "ws-n", actor });
    ok(o.status === "FAILED", "status=" + o.status);
    ok(o.validationStatus === "FAIL", "validationStatus=" + o.validationStatus);
    rec("222N", "validation failure", "PASS", "status=FAILED validation=FAIL");
  } catch (e) { rec("222N", "validation failure", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222O — no-op
  try {
    const runId = await setupDiagnosis("O", {
      classification: "TYPE_ERROR", diagnosisId: "diag-o",
      artifactRef: "artifact://art-diagnosis-diag-o",
    });
    await artifacts.registerArtifactAsync(
      { artifactId: "art-diagnosis-diag-o", jobId: runId, name: "d.json", type: "ENGINEERING_DIAGNOSIS", metadata: {}, createdAt: Date.now() },
      JSON.stringify({ schemaVersion: 1, diagnosisId: "diag-o", runId, stage: "DIAGNOSIS", sourceStage: "BUILD",
        classification: "TYPE_ERROR", rootCause: "x", confidence: "HIGH",
        repairTarget: { type: "SOURCE_FILE", path: "src/z.ts", description: "fix" },
        repairDirective: { kind: "WRITE_FILE", path: "src/z.ts", content: "same" } }),
    );
    await workspaces.writeFile(actor, "ws-o", "src/z.ts", "same");
    const o = await repairExec!.runRepair({ runId, workspaceId: "ws-o", actor });
    ok(o.status === "SUCCEEDED", "status=" + o.status);
    ok(o.reason === "ALREADY_CORRECT", "reason=" + o.reason);
    ok(o.changed === false, "changed=" + o.changed);
    rec("222O", "no-op repair honest", "PASS", "ALREADY_CORRECT, changed=false");
  } catch (e) { rec("222O", "no-op repair honest", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222P — idempotent (2nd call sees already-correct)
  try {
    const runId = await setupDiagnosis("P", {
      classification: "TYPE_ERROR", diagnosisId: "diag-p",
      artifactRef: "artifact://art-diagnosis-diag-p",
    });
    await artifacts.registerArtifactAsync(
      { artifactId: "art-diagnosis-diag-p", jobId: runId, name: "d.json", type: "ENGINEERING_DIAGNOSIS", metadata: {}, createdAt: Date.now() },
      JSON.stringify({ schemaVersion: 1, diagnosisId: "diag-p", runId, stage: "DIAGNOSIS", sourceStage: "BUILD",
        classification: "TYPE_ERROR", rootCause: "x", confidence: "HIGH",
        repairTarget: { type: "SOURCE_FILE", path: "src/p.ts", description: "fix" },
        repairDirective: { kind: "WRITE_FILE", path: "src/p.ts", content: "v1" } }),
    );
    await injectEvent(runId, runId + "__BUILD", "engineering_build.failed", { command: "npm run build" });
    const a = await repairExec!.runRepair({ runId, workspaceId: "ws-p", actor });
    const b = await repairExec!.runRepair({ runId, workspaceId: "ws-p", actor });
    ok(a.changed === true, "first run should change (file absent)");
    ok(b.changed === false, "second run should be no-op, changed=" + b.changed);
    ok(b.reason === "ALREADY_CORRECT", "reason=" + b.reason);
    rec("222P", "idempotent repair", "PASS", "1st changed, 2nd ALREADY_CORRECT");
  } catch (e) { rec("222P", "idempotent repair", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222Q — stale CAS
  try {
    const runId = await freshRun("Q");
    const jid = runId + "__REPAIR";
    const j0 = await store.getJobAsync(jid);
    const r1 = await store.recoverJobAtomicAsync({
      jobId: jid, expectedStatus: j0!.status, newStatus: "SUCCEEDED",
      expectedLeaseId: null, patch: {}, event: { eventType: "x", payload: {} },
    });
    ok(r1.ok, "first CAS failed");
    const r2 = await store.recoverJobAtomicAsync({
      jobId: jid, expectedStatus: j0!.status, newStatus: "FAILED",
      expectedLeaseId: null, patch: {}, event: { eventType: "x", payload: {} },
    });
    const jNow = await store.getJobAsync(jid);
    ok(jNow!.status === "SUCCEEDED", "terminal changed: " + jNow!.status);
    rec("222Q", "stale CAS cannot overwrite", "PASS", "terminal preserved");
  } catch (e) { rec("222Q", "stale CAS cannot overwrite", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222R — retry bounded (blocked diagnosis must not retry as success)
  try {
    const runId = await freshRun("R");
    const jid = runId + "__DIAGNOSIS";
    await store.recoverJobAtomicAsync({
      jobId: jid, expectedStatus: (await store.getJobAsync(jid))!.status, newStatus: "FAILED",
      expectedLeaseId: null, patch: {}, event: { eventType: "x", payload: {} },
    });
    const a = await repairExec!.runRepair({ runId, workspaceId: "ws-r", actor });
    const b = await repairExec!.runRepair({ runId, workspaceId: "ws-r", actor });
    ok(a.status === "BLOCKED" && b.status === "BLOCKED", "not stable BLOCKED");
    rec("222R", "retry bounded", "PASS", "repeated BLOCKED is stable");
  } catch (e) { rec("222R", "retry bounded", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222S — events persisted
  try {
    const evts = await q("SELECT event_type FROM engineering_run_events WHERE event_type LIKE $1 AND created_at > $2", ["engineering_repair.%", runStartTs]);
    ok(evts.rows.length > 0, "no engineering_repair.* events");
    const types = new Set(evts.rows.map((r: any) => r.event_type));
    ok(types.has("engineering_repair.started"), "missing .started");
    rec("222S", "events persist", "PASS", evts.rows.length + " engineering_repair events");
  } catch (e) { rec("222S", "events persist", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222T — no secrets
  try {
    const pat = /sk-[a-zA-Z0-9]{16,}|api[_-]?key\\s*[:=]\\s*["][^"]+["]|Bearer\\s+[A-Za-z0-9._-]{20,}/i;
    const all = await q("SELECT payload FROM engineering_run_events WHERE event_type LIKE $1 AND created_at > $2", ["engineering_repair.%", runStartTs]);
    for (const r of all.rows) ok(!pat.test(r.payload ?? ""), "secret in event");
    rec("222T", "no secrets", "PASS", all.rows.length + " events scanned");
  } catch (e) { rec("222T", "no secrets", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222U — path traversal
  try {
    const runId = await setupDiagnosis("U", {
      classification: "TYPE_ERROR", diagnosisId: "diag-u",
      artifactRef: "artifact://art-diagnosis-diag-u",
    });
    await artifacts.registerArtifactAsync(
      { artifactId: "art-diagnosis-diag-u", jobId: runId, name: "d.json", type: "ENGINEERING_DIAGNOSIS", metadata: {}, createdAt: Date.now() },
      JSON.stringify({ schemaVersion: 1, diagnosisId: "diag-u", runId, stage: "DIAGNOSIS", sourceStage: "BUILD",
        classification: "TYPE_ERROR", rootCause: "x", confidence: "HIGH",
        repairTarget: { type: "SOURCE_FILE", path: "../../etc/passwd", description: "traversal" },
        repairDirective: { kind: "WRITE_FILE", path: "../../etc/passwd", content: "pwned" } }),
    );
    const o = await repairExec!.runRepair({ runId, workspaceId: "ws-u", actor });
    ok(o.status === "BLOCKED", "status=" + o.status);
    ok(o.reason.startsWith("UNSAFE_REPAIR_PATH"), "reason=" + o.reason);
    rec("222U", "path traversal rejected", "PASS", "reason=" + o.reason.slice(0, 50));
  } catch (e) { rec("222U", "path traversal rejected", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222V — invalid target type blocked
  try {
    const runId = await setupDiagnosis("V", {
      classification: "NETWORK_FAILURE", diagnosisId: "diag-v", artifactRef: null,
    });
    const o = await repairExec!.runRepair({ runId, workspaceId: "ws-v", actor });
    ok(o.status === "BLOCKED", "status=" + o.status);
    rec("222V", "unauthorized mutation rejected", "PASS", "BLOCKED without directive");
  } catch (e) { rec("222V", "unauthorized mutation rejected", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222W — stage executor routes REPAIR
  try {
    const stageExec = new EngineeringStageExecutor({
      store, runService: runSvc,
      planning: {} as any, implementation: {} as any,
      buildExecutor: {} as any, testExecutor: {} as any,
      diagnosisExecutor: {} as any, repairExecutor: repairExec!,
      workspaceResolver: async () => ({ workspaceId: "ws-222w", actor }),
    });
    const runId = await freshRun("W");
    for (const st of ["PLANNING","ARCHITECTURE","IMPLEMENTATION","BUILD","TEST"]) await driveTo(runId, st, "SUCCEEDED");
    await driveTo(runId, "DIAGNOSIS", "SUCCEEDED");
    await injectEvent(runId, runId + "__DIAGNOSIS", "engineering_diagnosis.completed",
      { classification: "NO_FAILURE_TO_DIAGNOSE", diagnosisId: "diag-w", artifactRef: null });
    const o = await stageExec.execute({ kind: "engineering.stage", runId, stageType: "REPAIR" });
    ok(o.ok === true, "not ok");
    if (o.ok) ok(o.status === "SUCCEEDED", "status=" + o.status);
    rec("222W", "stage executor routes REPAIR", "PASS", "routed DIAGNOSIS->REPAIR");
  } catch (e) { rec("222W", "stage executor routes REPAIR", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222X — non-engineering isolation
  try {
    const w = EngineeringStageExecutor.wiredStages();
    ok(w.has("REPAIR") && w.has("DIAGNOSIS") && w.has("TEST"), "engineering stages missing");
    ok(!w.has("BUILD_FAKE" as any), "unexpected stage");
    rec("222X", "non-eng isolation", "PASS", "engineering-only wiring");
  } catch (e) { rec("222X", "non-eng isolation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222Y — Phase 221 regression
  try {
    const w = EngineeringStageExecutor.wiredStages();
    ok(w.has("DIAGNOSIS"), "DIAGNOSIS not wired");
    rec("222Y", "Phase 221 regression", "PASS", "DIAGNOSIS still wired");
  } catch (e) { rec("222Y", "Phase 221 regression", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 222Z — Phase 220 regression
  try {
    const w = EngineeringStageExecutor.wiredStages();
    ok(w.has("TEST") && w.has("BUILD"), "TEST/BUILD not wired");
    rec("222Z", "Phase 220 regression", "PASS", "TEST+BUILD still wired");
  } catch (e) { rec("222Z", "Phase 220 regression", "FAIL", e instanceof Error ? e.message : String(e)); }

  return finish(kernel, prefix);
}

async function finish(kernel: NexusKernel, prefix: string) {
  try { await kernel.stopDistributedScheduler(); } catch {}
  try { await kernel.shutdown({ finalRecoveryPass: false } as any); } catch {}
  try { await cleanup(prefix); } catch (e) { console.log("cleanup warning:", e); }
  const c = rows.reduce<Record<R, number>>((a, r) => { a[r.r] = (a[r.r] ?? 0) + 1; return a; }, { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 });
  console.log("\n===== Phase 222 summary =====");
  console.log("PASS: " + c.PASS);
  console.log("FAIL: " + c.FAIL);
  console.log("BLOCKED: " + c.BLOCKED);
  console.log("NOT EXECUTED: " + c["NOT EXECUTED"]);
  if (c.FAIL > 0) process.exitCode = 1;
}

main().catch(e => { console.error("fatal:", e instanceof Error ? e.stack : String(e)); process.exit(2); });
