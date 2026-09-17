#!/usr/bin/env tsx
/* Phase 135 — CI reconciliation integrity: durable ownership fencing.
 *
 * Proves a stale worker (A), whose durable reconciliation ownership has been
 * taken over by another worker (B), cannot mutate authoritative state even
 * when A has an external provider request already in flight.
 *
 * Uses the REAL Phase 132/134/135 services against an in-memory SQLite DB
 * seeded with migration 150 (reconciliation ledger) and migration 151
 * (worker ownership). No network. No sleeps. Deterministic clock.
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { CiReconciliationOwnershipService } from "../src/core/ci-reconciliation-ownership.service";
import {
  CicdReconciliationService,
  type CiPipelineRunLike,
  type EngineLookup,
} from "../src/core/cicd-reconciliation.service";
import {
  CiArtifactReconciliationService,
  type ReconcileInput,
} from "../src/core/ci-artifact-reconciliation.service";
import type { GitHubActionsCICDProvider } from "../src/core/github-actions-cicd-provider";
import type { GitHubWorkflowArtifact } from "../src/core/github";
import type { ArtifactService } from "../src/core/services";
import type { CiPipelineEngine } from "../src/core/cicd";

/* ---------------------------- harness ------------------------------------- */
let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(id: string, cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + id + "  " + msg); }
  else { failed++; failures.push(id + " " + msg); console.log("  FAIL " + id + "  " + msg); }
}
function eq<T>(id: string, actual: T, expected: T, msg: string): void {
  ok(id, actual === expected, msg + "  (expected=" + JSON.stringify(expected) + ", got=" + JSON.stringify(actual) + ")");
}

/* ---------------------------- real sqlite + schema ------------------------ */
function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const m150 = readFileSync(join(process.cwd(), "src", "db", "migrations", "150_phase132_durable_ci_reconciliation.sql"), "utf8");
  const m151 = readFileSync(join(process.cwd(), "src", "db", "migrations", "151_phase134_reconciliation_worker_ownership.sql"), "utf8");
  db.exec(m150);
  db.exec(m151);
  return db;
}

/* ---------------------------- clock --------------------------------------- */
interface Clock { now: () => number; advance: (ms: number) => void; }
function makeClock(start = 1_000_000): Clock {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/* ---------------------------- sinks --------------------------------------- */
interface EventRec { type: string; payload?: Record<string, unknown>; }
interface EmitInput { type: string; source?: string; execution_id?: string | null; payload?: Record<string, unknown>; }
interface RecordInput { actor?: string; action: string; resource_type?: string; resource_id?: string; result?: string; metadata?: Record<string, unknown>; }
function recorder() {
  const events: EventRec[] = [];
  const audits: EventRec[] = [];
  return {
    events, audits,
    sink: { emit: async (i: EmitInput): Promise<unknown> => { events.push({ type: i.type, payload: i.payload }); return undefined; } },
    audit: { record: async (i: RecordInput): Promise<unknown> => { audits.push({ type: i.action, payload: i.metadata }); return undefined; } },
  };
}

/* ---------------------------- provider fakes ------------------------------ */
function defer<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve: (v: T) => resolve(v) };
}

function makeDelayedPoll(): { engine: CiPipelineEngine; onEntered: Promise<void>; resolveStatus: (r: CiPipelineRunLike) => void } {
  let enteredResolve: () => void = () => {};
  const entered = new Promise<void>((r) => { enteredResolve = r; });
  const statusDefer = defer<CiPipelineRunLike>();
  const engine = {
    pollRun: async (_run: unknown, _ctx: unknown): Promise<CiPipelineRunLike> => {
      enteredResolve();
      return await statusDefer.promise;
    },
  } as unknown as CiPipelineEngine;
  return { engine, onEntered: entered, resolveStatus: (r: CiPipelineRunLike) => statusDefer.resolve(r) };
}

function immediateCiEngine(status: string): CiPipelineEngine {
  return {
    pollRun: async (run: CiPipelineRunLike): Promise<CiPipelineRunLike> => ({ ...run, status }),
  } as unknown as CiPipelineEngine;
}

function baseRun(id = "cirun_t01"): CiPipelineRunLike {
  return {
    id, execution_id: "exec_t01", project_id: "proj_t01",
    provider: "github-actions", repository: "acme/nexus-app", ref: "main",
    status: "RUNNING", attempt: 1, correlation_id: "corr_t01",
    external_run_id: "gh_run_1001",
    workflow_file: ".github/workflows/nexus-ci.yml",
    commit_sha: "0123456789abcdef0123456789abcdef01234567",
    created_at: 0, updated_at: 0,
  };
}

function fakeEngineStore(run: CiPipelineRunLike | null): EngineLookup {
  return {
    get: async <T,>(collection: string, _id: string): Promise<T | undefined> => {
      if (collection === "ci_pipeline_runs" && run) return run as unknown as T;
      return undefined;
    },
  };
}
/* ---------------------------- artifacts fake ------------------------------ */
interface FakeArtifacts { service: ArtifactService; records: Array<{ id: string; executionId: string; kind: string; name: string }>; }
function fakeArtifacts(): FakeArtifacts {
  const records: FakeArtifacts["records"] = [];
  let n = 0;
  const service = {
    register: async (executionId: string, input: { kind: string; name: string; content: string; canWrite?: () => boolean }) => {
      const id = "art_test_" + (++n).toString().padStart(3, "0");
      records.push({ id, executionId, kind: input.kind, name: input.name });
      return { id, execution_id: executionId, kind: input.kind, name: input.name, digest: "deadbeef", size: input.content.length, location: "artifact://" + id, created_at: Date.now() };
    },
  } as unknown as ArtifactService;
  return { service, records };
}

/* ---------------------------- artifact zip helpers ------------------------ */
function listArtifact(id: number, name: string): GitHubWorkflowArtifact {
  return {
    id, name, size_in_bytes: 128, expired: false,
    archive_download_url: "https://api.github.com/repos/x/y/actions/artifacts/" + id + "/zip",
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    expires_at: null, workflow_run: { id: 1001 },
  };
}

function makeSingleEntryZip(name: string, content: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(content) >>> 0;
  const size = content.length;
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0, 6); lfh.writeUInt16LE(0, 8);
  lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0, 12);
  lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(size, 18); lfh.writeUInt32LE(size, 22);
  lfh.writeUInt16LE(nameBuf.length, 26); lfh.writeUInt16LE(0, 28);
  const local = Buffer.concat([lfh, nameBuf, content]);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
  cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(size, 20); cd.writeUInt32LE(size, 24);
  cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(0, 42);
  const cdData = Buffer.concat([cd, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdData.length, 12); eocd.writeUInt32LE(local.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, cdData, eocd]);
}

function validArtifactJson(): string {
  const digest = "sha256:" + "a".repeat(64);
  return JSON.stringify({
    schema_version: 1, execution_id: "exec_t01", project_id: "proj_t01",
    repository: "acme/nexus-app",
    commit_sha: "0123456789abcdef0123456789abcdef01234567",
    ci_provider: "github-actions", external_run_id: "gh_run_1001",
    image_repository: "ghcr.io/acme/nexus-app",
    image_tag: "sha-0123456789abcdef0123456789abcdef01234567",
    image_digest: digest,
    immutable_reference: "ghcr.io/acme/nexus-app@" + digest,
    published_at: new Date(0).toISOString(),
    build_workflow: ".github/workflows/nexus-ci.yml",
  });
}

/* ---------------------------- db helpers ---------------------------------- */
function seedReconciliationRow(db: Database.Database, runId: string, executionId: string): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO ci_artifact_reconciliations (" +
    "reconciliation_id, run_id, execution_id, project_id, provider_id, external_run_id, " +
    "repository, commit_sha, workflow_file, state, attempts, created_at, updated_at" +
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)"
  ).run(
    "cir_" + runId, runId, executionId, "proj_t01", "github-actions", "gh_run_1001",
    "acme/nexus-app", "0123456789abcdef0123456789abcdef01234567",
    ".github/workflows/nexus-ci.yml", now, now,
  );
}

function getRow(db: Database.Database, runId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM ci_artifact_reconciliations WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
}

function countBindings(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ci_image_digest_bindings").get() as { n: number }).n;
}

/* ---------------------------- primary race -------------------------------- */
async function primaryRaceTest(): Promise<void> {
  console.log("");
  console.log("Phase 135 — primary stale-worker race (delayed pollRun)");

  const db = newDb();
  const clock = makeClock();
  const rec = recorder();

  const ownershipA = new CiReconciliationOwnershipService(db, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  const ownershipB = new CiReconciliationOwnershipService(db, "worker-B", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  ok("T01a", ownershipA !== ownershipB, "two distinct workers against the same durable table");
  eq("T01b", (db.prepare("SELECT COUNT(*) AS n FROM ci_reconciliation_worker_ownership").get() as { n: number }).n, 0, "no ownership row before any acquisition");

  const aOwned = await ownershipA.ensureOwned();
  ok("T02a", aOwned.owned === true, "A acquired durable ownership");
  const fenceA = ownershipA.currentFence();
  ok("T02b", fenceA !== null, "A obtained fence A");
  eq("T02c", fenceA?.workerId, "worker-A", "fence A worker id");

  seedReconciliationRow(db, "cirun_t01", "exec_t01");
  const artsA = fakeArtifacts();
  const providerA = {
    listArtifacts: async () => [] as GitHubWorkflowArtifact[],
    downloadArtifact: async () => Buffer.alloc(0),
  } as unknown as GitHubActionsCICDProvider;
  const artifactReconcilerA = new CiArtifactReconciliationService(db, artsA.service, providerA, ownershipA);
  const delayed = makeDelayedPoll();
  const reconcilerA = new CicdReconciliationService(
    db, delayed.engine, fakeEngineStore(baseRun()), artifactReconcilerA, rec.sink, rec.audit, ownershipA,
  );

  const aPromise = reconcilerA.reconcileOnce("cirun_t01");
  await delayed.onEntered;
  ok("T03a", true, "A entered pollRun and is awaiting the provider");
  eq("T03b", getRow(db, "cirun_t01")?.state, "PENDING", "row unchanged while A's provider is in flight");

  clock.advance(31_000);
  const inspectExpired = ownershipA.inspect();
  ok("T04a", inspectExpired.expiresAt !== null && inspectExpired.expiresAt <= clock.now(), "A's durable lease is past expiry (clock-advanced)");

  const bOwned = await ownershipB.ensureOwned();
  ok("T05a", bOwned.owned === true, "B took over ownership");
  const fenceB = ownershipB.currentFence();
  ok("T05b", fenceB !== null, "B obtained fence B");
  ok("T05c", fenceA !== null && fenceB !== null && fenceA.leaseId !== fenceB.leaseId, "fences A and B differ");

  const inspectAfter = ownershipA.inspect();
  eq("T06a", inspectAfter.holder, "worker-B", "durable ownership row now names worker-B");
  eq("T06b", inspectAfter.state, "ACTIVE", "durable ownership row is ACTIVE");
  ok("T06c", ownershipB.isOwnedNowSync(), "B validates as current owner");

  delayed.resolveStatus({ ...baseRun(), status: "SUCCEEDED" });
  const aResult = await aPromise;
  eq("T07a", aResult.ciStatus, "SUCCEEDED", "A observed SUCCEEDED from the provider");
  eq("T07b", aResult.fenced, true, "A's authoritative write was fenced");

  const rowAfter = getRow(db, "cirun_t01");
  eq("T08a", rowAfter?.state, "PENDING", "row state is still PENDING (A did not mutate)");
  eq("T08b", rowAfter?.attempts, 0, "row attempts is still 0 (A did not bump)");
  eq("T08c", aResult.blockedReason, null, "ownership loss is not reported as a CI block reason");

  eq("T11-primary", rowAfter?.state !== "REGISTERED", true, "no release-enabling authoritative state produced by A");
  eq("T12", rowAfter?.state !== "REGISTERED", true, "durable row is not marked REGISTERED by A");

  const artsB = fakeArtifacts();
  const validZip = makeSingleEntryZip("nexus-image-digest.json", Buffer.from(validArtifactJson(), "utf8"));
  const providerB = {
    listArtifacts: async () => [listArtifact(999, "nexus-image-digest.json")],
    downloadArtifact: async () => validZip,
  } as unknown as GitHubActionsCICDProvider;
  const artifactReconcilerB = new CiArtifactReconciliationService(db, artsB.service, providerB, ownershipB);
  const reconcilerB = new CicdReconciliationService(
    db, immediateCiEngine("SUCCEEDED"), fakeEngineStore(baseRun()), artifactReconcilerB, rec.sink, rec.audit, ownershipB,
  );
  const bResult = await reconcilerB.reconcileOnce("cirun_t01");
  eq("T13a", bResult.state, "REGISTERED", "B reconciled successfully");
  eq("T13b", bResult.fenced, undefined, "B's result is not fenced");

  const rowFinal = getRow(db, "cirun_t01");
  eq("T14a", rowFinal?.state, "REGISTERED", "durable row is REGISTERED by B");
  eq("T14b", countBindings(db), 1, "exactly one binding row after B");
  eq("T14c", artsB.records.length, 1, "exactly one IMAGE_DIGEST artifact after B");
  eq("T14d", rowFinal?.image_digest, "sha256:" + "a".repeat(64), "row carries the exact digest");

  const bResult2 = await reconcilerB.reconcileOnce("cirun_t01");
  eq("T15a", bResult2.state, "REGISTERED", "B's second pass sees REGISTERED (short-circuit)");
  eq("T15b", countBindings(db), 1, "still exactly one binding row");
  eq("T15c", artsB.records.length, 1, "still exactly one artifact row");
}
/* ---------------------------- artifact-layer fence ------------------------ */
async function artifactFenceTest(): Promise<void> {
  console.log("");
  console.log("Phase 135 — artifact-layer fence (delayed downloadArtifact)");

  const db = newDb();
  const clock = makeClock();
  const rec = recorder();

  const ownershipA = new CiReconciliationOwnershipService(db, "worker-A", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });
  const ownershipB = new CiReconciliationOwnershipService(db, "worker-B", rec.sink, rec.audit, { now: clock.now, ttlMs: 30_000 });

  await ownershipA.ensureOwned();

  const dl = defer<Buffer>();
  let dlEnteredResolve: () => void = () => {};
  const dlEntered = new Promise<void>((r) => { dlEnteredResolve = r; });
  const providerA = {
    listArtifacts: async () => [listArtifact(555, "nexus-image-digest.json")],
    downloadArtifact: async () => { dlEnteredResolve(); return await dl.promise; },
  } as unknown as GitHubActionsCICDProvider;

  const artsA = fakeArtifacts();
  const reconcilerA = new CiArtifactReconciliationService(db, artsA.service, providerA, ownershipA);

  const input: ReconcileInput = {
    runId: "cirun_t01", executionId: "exec_t01", projectId: "proj_t01",
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  };

  const p = reconcilerA.reconcile(input);
  await dlEntered;
  ok("T09a-pre", true, "A is inside downloadArtifact with ownership still held");

  clock.advance(31_000);
  const bOwned = await ownershipB.ensureOwned();
  ok("T09a", bOwned.owned === true && ownershipB.isOwnedNowSync(), "B is now the current owner during A's download");

  dl.resolve(makeSingleEntryZip("nexus-image-digest.json", Buffer.from(validArtifactJson(), "utf8")));
  const outcome = await p;

  eq("T09b", outcome.state, "SKIPPED_NO_OWNERSHIP", "A's artifact path returned SKIPPED_NO_OWNERSHIP");
  eq("T09c", artsA.records.length, 0, "no IMAGE_DIGEST artifact registered by stale A");
  eq("T10", countBindings(db), 0, "no binding row created by stale A");
}

/* ---------------------------- runner -------------------------------------- */
async function main(): Promise<void> {
  console.log("Phase 135 — durable CI reconciliation integrity tests");
  try {
    await primaryRaceTest();
    await artifactFenceTest();
  } catch (e) {
    console.error("unexpected exception: " + (e as Error).message);
    console.error((e as Error).stack);
    process.exit(2);
  }
  console.log("");
  console.log("passed: " + passed + "  failed: " + failed);
  if (failed > 0) {
    console.log("");
    for (const f of failures) console.log("  FAILED: " + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });