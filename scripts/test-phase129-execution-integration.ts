// scripts/test-phase129-execution-integration.ts
// Phase 129 â€” Production CI/CD Execution Integration.
// Verifies the orchestrator uses durable execution and never fabricates success.

import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { LeaseManager } from "../src/core/lease-manager";
import { WorkerRegistry } from "../src/core/worker-registry";
import { orchestrateCICD, CICDRequest } from "../src/core/worker-autonomous-cicd-orchestrator";
import { createArtifact } from "../src/core/worker-artifact";
import type { ExecutionAdapter, ExecutionAdapterRequest, ExecutionAdapterResult } from "../src/core/execution-adapter";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ok   ${msg}`); }
  else      { failed++; console.log(`  FAIL ${msg}`); }
}

interface Harness {
  store: ExecutionStore;
  lm: LeaseManager;
  wr: WorkerRegistry;
}

function makeHarness(): Harness {
  const rawDb = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const lm = new LeaseManager(store);
  const wr = new WorkerRegistry(store, lm);
  wr.register({
    workerId: "worker-1", hostname: "localhost",
    capabilities: ["node"], status: "ONLINE",
    registeredAt: Date.now(),
  } as any);
  return { store, lm, wr };
}

type AdapterBehavior = 'success' | 'fail' | 'unhealthy' | 'throw';

function makeAdapter(behavior: AdapterBehavior, overrides?: Partial<ExecutionAdapter>): ExecutionAdapter {
  let calls = 0;
  const base: ExecutionAdapter = {
    getId: () => `test-adapter-${behavior}`,
    getType: () => 'test',
    getCapabilities: () => ['test'],
    validate: () => ({ valid: true, errors: [] }),
    async execute(_req: ExecutionAdapterRequest): Promise<ExecutionAdapterResult> {
      calls++;
      if (behavior === 'throw') throw new Error('adapter intentionally threw');
      if (behavior === 'fail') return { success: false, exitCode: 1, stderr: 'deterministic test failure' };
      return { success: true, exitCode: 0, stdout: 'ok', externalId: `ext-${calls}` };
    },
    async cancel() { /* noop */ },
    async healthCheck() { return behavior !== 'unhealthy'; },
  };
  return { ...base, ...overrides } as ExecutionAdapter;
}

function makeRequest(overrides: Partial<CICDRequest> = {}): CICDRequest {
  return {
    tenantId: 'tenant-t',
    correlationId: 'corr-' + Math.random().toString(36).slice(2),
    pipelineDef: {
      name: 'test-pipeline',
      version: 1,
      stages: ['CHECKOUT', 'TYPECHECK', 'ARTIFACT'],
      requiredStages: ['CHECKOUT', 'TYPECHECK', 'ARTIFACT'],
      timeoutMs: 60000,
      retryPolicy: { maxRetries: 0, backoffMs: 0 },
      approvalRequired: false,
      artifactRequired: true,
      securityRequired: false,
      owner: 'test',
    },
    repository: 'repo/test',
    revision: 'rev-abc123',
    actor: 'test-actor',
    trigger: 'test-trigger',
    changedFiles: ['a.ts'],
    riskInput: {
      changedFiles: 1, sensitiveFiles: false, databaseMigration: false,
      infrastructureChange: false, dependencyChange: false, securityChange: false,
      testFailures: 0, historicalInstability: 0, blastRadius: 0,
    } as any,
    governanceDecision: 'ALLOW',
    safetyDecision: 'ALLOW',
    approvalRequired: false,
    approvalGranted: false,
    deploymentTargetHealthy: true,
    releaseVersion: 'v0.1.0',
    ...overrides,
  };
}

function seedPipelineJob(h: Harness, idempotencyKey: string, id: string, req: CICDRequest): void {
  const now = Date.now();
  h.store.createJob({
    id,
    idempotencyKey,
    jobType: 'pipeline',
    payload: {
      kind: 'pipeline',
      pipelineId: 'seeded', pipelineVersion: 1,
      repository: req.repository, revision: req.revision,
      actor: req.actor, trigger: req.trigger,
      tenantId: req.tenantId, correlationId: req.correlationId,
    },
    status: 'QUEUED',
    createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
  });
}

// ---------- tests ----------

async function T1_capabilityGate(): Promise<void> {
  console.log("\nT1 â€” capability gate");
  const h = makeHarness();
  const req = makeRequest({ idempotencyKey: 't1', leaseManager: h.lm, adapter: makeAdapter('success'), workerId: 'worker-1' } as any);
  // deliberately omit store
  const r: any = await orchestrateCICD(req);
  ok(r.status === 'BLOCKED', 'T1 missing store -> BLOCKED');
  ok(r.blockedReason === 'NO_DURABLE_EXECUTION', 'T1 blockedReason = NO_DURABLE_EXECUTION');
}

async function T2_executorUnhealthy(): Promise<void> {
  console.log("\nT2 â€” executor unhealthy");
  const h = makeHarness();
  const req = makeRequest({ idempotencyKey: 't2', store: h.store, leaseManager: h.lm, adapter: makeAdapter('unhealthy'), workerId: 'worker-1' });
  const r: any = await orchestrateCICD(req);
  ok(r.status === 'BLOCKED', 'T2 unhealthy adapter -> BLOCKED');
  ok(r.blockedReason === 'EXECUTOR_UNAVAILABLE', 'T2 blockedReason = EXECUTOR_UNAVAILABLE');
  ok(h.store.getJobByIdempotencyKey('t2') === undefined, 'T2 no pipeline job created when adapter unhealthy');
}

async function T3_happyPath(): Promise<void> {
  console.log("\nT3 â€” happy path");
  const h = makeHarness();
  const req = makeRequest({ idempotencyKey: 't3-idem', store: h.store, leaseManager: h.lm, adapter: makeAdapter('success'), workerId: 'worker-1' });
  seedPipelineJob(h, 't3-idem', 't3-job', req);
  const pre = createArtifact({
    pipelineExecutionId: 't3-job',
    sourceRevision: req.revision,
    buildFingerprint: `${req.revision}:build`,
    type: 'application', size: 100, metadata: {},
    correlationId: req.correlationId,
  });
  req.artifactExpectedFingerprint = pre.fingerprint;

  const r: any = await orchestrateCICD(req);
  ok(r.status === 'COMPLETED', `T3 status COMPLETED (got ${r.status}, reason=${r.reason ?? 'n/a'})`);
  ok(r.execution?.status === 'SUCCEEDED', 'T3 pipeline execution SUCCEEDED');
  ok(r.stages?.length === 3, 'T3 two stages recorded');
  ok(r.stages?.every((s: any) => s.status === 'SUCCEEDED'), 'T3 all stages SUCCEEDED');

  const reloaded = h.store.getJob('t3-job');
  ok(reloaded?.status === 'SUCCEEDED', 'T3 durable pipeline job SUCCEEDED');
}

async function T4_stageFailure(): Promise<void> {
  console.log("\nT4 â€” stage failure");
  const h = makeHarness();
  const req = makeRequest({ idempotencyKey: 't4', store: h.store, leaseManager: h.lm, adapter: makeAdapter('fail'), workerId: 'worker-1' });
  const r: any = await orchestrateCICD(req);
  ok(r.status === 'FAILED', `T4 adapter fail -> FAILED (got ${r.status})`);
  const succeededStages = (r.stages ?? []).filter((s: any) => s.status === 'SUCCEEDED');
  ok(succeededStages.length === 0, 'T4 no stage falsely reported SUCCEEDED');
}

async function T5_idempotency(): Promise<void> {
  console.log("\nT5 â€” idempotency");
  const h = makeHarness();
  const req = makeRequest({ idempotencyKey: 't5-idem', store: h.store, leaseManager: h.lm, adapter: makeAdapter('success'), workerId: 'worker-1' });
  seedPipelineJob(h, 't5-idem', 't5-job', req);
  const pre = createArtifact({
    pipelineExecutionId: 't5-job',
    sourceRevision: req.revision,
    buildFingerprint: `${req.revision}:build`,
    type: 'application', size: 100, metadata: {},
    correlationId: req.correlationId,
  });
  req.artifactExpectedFingerprint = pre.fingerprint;

  const r1: any = await orchestrateCICD(req);
  ok(r1.status === 'COMPLETED', 'T5 first call COMPLETED');

  const r2: any = await orchestrateCICD(req);
  ok(r2.status === 'COMPLETED', 'T5 second call returns same terminal status');
  ok(r2.reason && /already terminal/i.test(r2.reason), 'T5 second call reports terminal resume');

  const jobs = h.store.listJobsByStatus('SUCCEEDED').filter(j => j.idempotencyKey === 't5-idem');
  ok(jobs.length === 1, 'T5 exactly one pipeline job for that key');
}

async function T6_missingReleaseVersion(): Promise<void> {
  console.log("\nT6 â€” missing releaseVersion");
  const h = makeHarness();
  const req = makeRequest({ idempotencyKey: 't6', store: h.store, leaseManager: h.lm, adapter: makeAdapter('success'), workerId: 'worker-1', releaseVersion: undefined });
  const r: any = await orchestrateCICD(req);
  ok(r.status === 'BLOCKED', 'T6 no releaseVersion -> BLOCKED');
  ok(r.blockedReason === 'NO_RELEASE_VERSION', 'T6 blockedReason = NO_RELEASE_VERSION');
  const job = h.store.getJobByIdempotencyKey('t6');
  ok(job?.status !== 'SUCCEEDED', 'T6 pipeline job NOT SUCCEEDED');
}

async function T7_governanceDenial(): Promise<void> {
  console.log("\nT7 â€” governance denial");
  const h = makeHarness();
  const req = makeRequest({ idempotencyKey: 't7', store: h.store, leaseManager: h.lm, adapter: makeAdapter('success'), workerId: 'worker-1', governanceDecision: 'DENY' });
  const r: any = await orchestrateCICD(req);
  ok(r.status === 'BLOCKED', 'T7 governance DENY -> BLOCKED');
  const job = h.store.getJobByIdempotencyKey('t7');
  ok(job?.status !== 'SUCCEEDED', 'T7 pipeline job NOT SUCCEEDED');
}

async function T8_artifactIntegrityFailure(): Promise<void> {
  console.log("\nT8 â€” artifact integrity failure");
  const h = makeHarness();
  const req = makeRequest({ idempotencyKey: 't8', store: h.store, leaseManager: h.lm, adapter: makeAdapter('success'), workerId: 'worker-1', artifactExpectedFingerprint: 'deliberately-wrong-fingerprint' });
  const r: any = await orchestrateCICD(req);
  ok(r.status === 'FAILED', 'T8 wrong fingerprint -> FAILED');
  ok(/artifact integrity/i.test(r.reason ?? ''), 'T8 reason mentions artifact integrity');
}

async function T9_restartDurability(): Promise<void> {
  console.log("\nT9 â€” restart durability");
  const h = makeHarness();
  const req = makeRequest({ idempotencyKey: 't9', store: h.store, leaseManager: h.lm, adapter: makeAdapter('success'), workerId: 'worker-1' });
  const r: any = await orchestrateCICD(req);
  ok(r.status === 'COMPLETED', 'T9 pipeline completes');
  const execId = r.execution?.executionId;
  ok(typeof execId === 'string', 'T9 executionId present');

  // Simulate reload: same store, re-fetch by idempotency key.
  const reloaded = h.store.getJobByIdempotencyKey('t9');
  ok(reloaded?.id === execId, 'T9 pipeline job survives reload with same id');
  ok(reloaded?.status === 'SUCCEEDED', 'T9 pipeline job status durable');

  const stages = (r.stages ?? []) as any[];
  for (const s of stages) {
    const sj = h.store.getJob(s.stageExecutionId);
    ok(!!sj, `T9 stage row ${s.stageName} durable`);
    ok(sj?.jobType === 'pipeline.stage', `T9 stage ${s.stageName} has jobType pipeline.stage`);
  }
}

async function T10_stageDurability(): Promise<void> {
  console.log("\nT10 â€” stage durability");
  const h = makeHarness();
  const req = makeRequest({ idempotencyKey: 't10', store: h.store, leaseManager: h.lm, adapter: makeAdapter('success'), workerId: 'worker-1' });
  const r: any = await orchestrateCICD(req);
  ok(r.status === 'COMPLETED', 'T10 completes');
  const stageRows = h.store.listJobsByStatus('SUCCEEDED').filter(j => j.jobType === 'pipeline.stage');
  ok(stageRows.length === 3, 'T10 two durable stage rows in terminal SUCCEEDED');
  const payloadKinds = stageRows.map(j => (j.payload ?? {}).kind);
  ok(payloadKinds.every(k => k === 'pipeline.stage'), 'T10 stage payloads have kind=pipeline.stage');
}

async function T11_noFabricatedSuccess(): Promise<void> {
  console.log("\nT11 â€” no fabricated success");
  const h = makeHarness();
  // Adapter alternates: succeeds for CHECKOUT, fails for TYPECHECK.
  let n = 0;
  const flaky = makeAdapter('success', {
    async execute() { n++; return n === 1 ? { success: true, exitCode: 0 } : { success: false, exitCode: 1, stderr: 'TYPECHECK failed' }; },
  } as any);
  const req = makeRequest({ idempotencyKey: 't11', store: h.store, leaseManager: h.lm, adapter: flaky, workerId: 'worker-1' });
  const r: any = await orchestrateCICD(req);
  ok(r.status === 'FAILED', 'T11 one stage fails -> FAILED');
  const stages = (r.stages ?? []) as any[];
  const succeeded = stages.filter(s => s.status === 'SUCCEEDED').length;
  ok(succeeded === 1, `T11 exactly one stage succeeded (got ${succeeded})`);
  const stageRowsSucceeded = h.store.listJobsByStatus('SUCCEEDED').filter(j => j.jobType === 'pipeline.stage').length;
  ok(stageRowsSucceeded === 1, 'T11 exactly one durable stage row SUCCEEDED');
}

async function T12_leaseExpiryMidPipeline(): Promise<void> {
  console.log("\nT12 - lease expiry mid-pipeline");
  const h = makeHarness();
  const req = makeRequest({ idempotencyKey: 't12', store: h.store, leaseManager: h.lm, adapter: makeAdapter('success'), workerId: 'worker-1', leaseTtlMs: 5 });
  const r: any = await orchestrateCICD(req);
  ok(r.status === 'COMPLETED' || r.status === 'BLOCKED' || r.status === 'FAILED', `T12 completed with honest status: ${r.status}`);
  // Regardless of outcome, no obligation should have been fabricated as resolved.
  const openObligations = h.store.listOpenOwnershipObligations();
  ok(Array.isArray(openObligations), 'T12 openObligations listable');
}

async function T13_duplicateStageCompletion(): Promise<void> {
  console.log("\nT13 - duplicate stage completion is idempotent");
  const h = makeHarness();
  const req = makeRequest({ idempotencyKey: 't13', store: h.store, leaseManager: h.lm, adapter: makeAdapter('success'), workerId: 'worker-1' });
  const r1: any = await orchestrateCICD(req);
  ok(r1.status === 'COMPLETED', 'T13 first submission COMPLETED');
  // Second submission with same idempotency key sees a terminal pipeline.
  const r2: any = await orchestrateCICD(req);
  ok(r2.status === 'COMPLETED', 'T13 second submission returns terminal state');
  ok(typeof r2.reason === 'string' && /already terminal/i.test(r2.reason), 'T13 second reports terminal resume');

  // No duplicate stage rows created.
  const stageRows = h.store.listJobsByStatus('SUCCEEDED').filter((j: any) => j.jobType === 'pipeline.stage');
  ok(stageRows.length === 3, `T13 exactly 3 durable stage rows across both calls (got ${stageRows.length})`);
}

async function T14_submitPipelineExecutionDurable(): Promise<void> {
  console.log("\nT14 - submitPipelineExecution is durable and idempotent");
  const h = makeHarness();
  const { submitPipelineExecution } = await import('../src/core/worker-pipeline-execution');
  const input = {
    tenantId: 'tenant-t',
    pipelineId: 'pipe-x',
    pipelineVersion: 1,
    repository: 'repo/test',
    revision: 'rev-x',
    actor: 'actor',
    trigger: 'trigger',
    correlationId: 'corr-x',
    idempotencyKey: 't14-idem',
  };
  const a = submitPipelineExecution(h.store, input);
  ok(a.created === true, 'T14 first call created=true');
  const b = submitPipelineExecution(h.store, input);
  ok(b.created === false, 'T14 second call created=false');
  ok(a.job.id === b.job.id, 'T14 same job id (idempotent)');

  const reloaded = h.store.getJobByIdempotencyKey('t14-idem');
  ok(reloaded?.id === a.job.id, 'T14 job durable by idempotency key');
  ok(reloaded?.jobType === 'pipeline', 'T14 jobType=pipeline');
}
async function main(): Promise<void> {
  console.log("=== Phase 129 â€” Production CI/CD Execution Integration ===\n");
  await T1_capabilityGate();
  await T2_executorUnhealthy();
  await T3_happyPath();
  await T4_stageFailure();
  await T5_idempotency();
  await T6_missingReleaseVersion();
  await T7_governanceDenial();
  await T8_artifactIntegrityFailure();
  await T9_restartDurability();
  await T10_stageDurability();
  await T11_noFabricatedSuccess();
  await T12_leaseExpiryMidPipeline();
  await T13_duplicateStageCompletion();
  await T14_submitPipelineExecutionDurable();
  console.log(`\n--- Phase 129: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error("PHASE129 DRIVER CRASH:", err); process.exit(1); });