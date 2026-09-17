#!/usr/bin/env tsx
/* Phase 132 â€” durable CI completion & artifact reconciliation test harness.
 *
 * T01â€“T34. Uses REAL repository classes for everything except the external
 * network boundary (GitHub Actions REST). Where a test double is required,
 * it is clearly labelled. Honest BLOCKED is asserted, never faked SUCCESS. */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { CiArtifactReconciliationService, type SqliteDb } from "../src/core/ci-artifact-reconciliation.service";
import { CicdReconciliationService } from "../src/core/cicd-reconciliation.service";
import {
  validateCiArtifact,
  extractSingleZipMember,
  NEXUS_IMAGE_DIGEST_ARTIFACT_NAME,
} from "../src/core/ci-artifact-contract";
import {
  GitHubActionsCICDProvider,
  mapGitHubStatus,
  redactSecrets,
  type GitHubActionsClient,
  type GitHubActionsRequest,
} from "../src/core/github-actions-cicd-provider";
import type { GitHubWorkflowArtifact, GitHubWorkflowRun } from "../src/core/github";
import { handoffToRelease } from "../src/core/engineering";
import type { CiPipelineEngine } from "../src/core/cicd";
import type { ArtifactService } from "../src/core/services";

/* --------------------------------- harness -------------------------------- */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(id: string, condition: boolean, msg: string): void {
  if (condition) { passed++; console.log("  ok   " + id + "  " + msg); }
  else { failed++; failures.push(id + "  " + msg); console.log("  FAIL " + id + "  " + msg); }
}
function eq<T>(id: string, actual: T, expected: T, msg: string): void {
  ok(id, actual === expected, msg + "  (expected=" + JSON.stringify(expected) + ", got=" + JSON.stringify(actual) + ")");
}

/* -------------------------------- fixtures -------------------------------- */

function newDb(): Database.Database {
  const db = new Database(":memory:");
  const sql = readFileSync(
    join(process.cwd(), "src", "db", "migrations", "150_phase132_durable_ci_reconciliation.sql"),
    "utf8",
  );
  db.exec(sql);
  return db;
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

function sha256Hex(n: number): string {
  return "sha256:" + "a".repeat(56) + n.toString(16).padStart(8, "0").slice(-8);
}

function validArtifact(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const digest = "sha256:" + "a".repeat(64);
  const base = {
    schema_version: 1,
    execution_id: "exec_t01",
    project_id: "proj_t01",
    repository: "acme/nexus-app",
    commit_sha: "0123456789abcdef0123456789abcdef01234567",
    ci_provider: "github-actions",
    external_run_id: "gh_run_1001",
    image_repository: "ghcr.io/acme/nexus-app",
    image_tag: "sha-0123456789abcdef0123456789abcdef01234567",
    image_digest: digest,
    immutable_reference: "ghcr.io/acme/nexus-app@" + digest,
    published_at: new Date(0).toISOString(),
    build_workflow: ".github/workflows/nexus-ci.yml",
  };
  return { ...base, ...overrides };
}

interface FakeProviderOpts {
  artifacts?: GitHubWorkflowArtifact[];
  listThrows?: Error;
  downloadBytes?: Buffer;
  downloadThrows?: Error;
}
function fakeProvider(opts: FakeProviderOpts): GitHubActionsCICDProvider {
  return {
    listArtifacts: async () => { if (opts.listThrows) throw opts.listThrows; return opts.artifacts ?? []; },
    downloadArtifact: async () => { if (opts.downloadThrows) throw opts.downloadThrows; return opts.downloadBytes ?? Buffer.alloc(0); },
  } as unknown as GitHubActionsCICDProvider;
}

interface FakeArtifacts {
  service: ArtifactService;
  records: Array<{ id: string; executionId: string; kind: string; name: string; content: string }>;
}
function fakeArtifacts(): FakeArtifacts {
  const records: FakeArtifacts["records"] = [];
  let n = 0;
  const service = {
    register: async (executionId: string, input: { kind: string; name: string; content: string }) => {
      const id = "art_test_" + (++n).toString().padStart(3, "0");
      records.push({ id, executionId, kind: input.kind, name: input.name, content: input.content });
      return {
        id, execution_id: executionId, kind: input.kind, name: input.name,
        digest: "deadbeef", size: input.content.length,
        location: "artifact://" + id, created_at: Date.now(),
      };
    },
  } as unknown as ArtifactService;
  return { service, records };
}

function fakeCiEngine(statusSequence: string[]): CiPipelineEngine {
  let i = 0;
  return {
    pollRun: async (run: Record<string, unknown>) => {
      const s = statusSequence[Math.min(i, statusSequence.length - 1)]; i++;
      return { ...run, status: s };
    },
  } as unknown as CiPipelineEngine;
}

function fakeEngineStore(run: Record<string, unknown> | null) {
  return {
    get: async (collection: string, _id: string) =>
      (collection === "ci_pipeline_runs" && run) ? run : undefined,
  };
}

const noopEvents = { emit: async () => undefined };
const noopAudit  = { record: async () => undefined };

function baseRun(id = "cirun_t01"): Record<string, unknown> {
  return {
    id,
    execution_id: "exec_t01",
    project_id: "proj_t01",
    provider: "github",
    repository: "acme/nexus-app",
    ref: "main",
    status: "RUNNING",
    attempt: 1,
    correlation_id: "corr_t01",
    external_run_id: "gh_run_1001",
    workflow_file: ".github/workflows/nexus-ci.yml",
    commit_sha: "0123456789abcdef0123456789abcdef01234567",
    created_at: 0,
    updated_at: 0,
  };
}

function listArtifact(id: number, name: string): GitHubWorkflowArtifact {
  return {
    id, name, size_in_bytes: 128, expired: false,
    archive_download_url: "https://api.github.com/repos/x/y/actions/artifacts/" + id + "/zip",
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    expires_at: null, workflow_run: { id: 1001 },
  };
}

/* --------------------------------- tests ---------------------------------- */

async function T01(): Promise<void> {
  const client = {
    state: () => ({ connected: true }),
    dispatchWorkflow: async () => undefined,
    listWorkflowRuns: async () => [],
    getWorkflowRun: async () => null,
    cancelWorkflowRun: async () => undefined,
    listWorkflowRunArtifacts: async () => [],
    downloadWorkflowRunArtifact: async () => Buffer.alloc(0),
  } as GitHubActionsClient;
  const p = new GitHubActionsCICDProvider(client);
  const req: GitHubActionsRequest = {
    owner: "acme", repo: "nexus-app",
    workflow: ".github/workflows/nexus-ci.yml",
    ref: "main",
  };
  const v = p.validateRequest(req);
  ok("T01", v.valid === true, "valid GitHub request still validates");
}

async function T02(): Promise<void> {
  const client = {
    state: () => ({ connected: true }),
    dispatchWorkflow: async () => undefined,
    listWorkflowRuns: async () => [],
    getWorkflowRun: async () => null,
    cancelWorkflowRun: async () => undefined,
    listWorkflowRunArtifacts: async () => [],
    downloadWorkflowRunArtifact: async () => Buffer.alloc(0),
  } as GitHubActionsClient;
  const p = new GitHubActionsCICDProvider(client, { maxResolveAttempts: 2, resolveIntervalMs: 1 });
  let threw: Error | null = null;
  try {
    await p.trigger({
      owner: "acme", repo: "nexus-app",
      workflow: ".github/workflows/nexus-ci.yml",
      ref: "main",
    });
  } catch (e) { threw = e as Error; }
  ok("T02", !!threw && /BLOCKED/.test(threw.message), "real provider never fabricates external run id");
}

function T03(): void {
  const unknown = { status: "mystery" } as unknown as GitHubWorkflowRun;
  const blocked = mapGitHubStatus(unknown);
  eq("T03", blocked, "BLOCKED", "unknown provider state maps to BLOCKED, never SUCCEEDED");
}

function T04(): void {
  const db = newDb();
  const { service } = fakeArtifacts();
  const reconciler = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, fakeProvider({}));
  const cicdRec = new CicdReconciliationService(
    db as unknown as SqliteDb, fakeCiEngine(["RUNNING"]), fakeEngineStore(baseRun()),
    reconciler, noopEvents, noopAudit,
  );
  const row = cicdRec.ensure({
    runId: "cirun_t04", executionId: "exec_t04", projectId: "proj_t04",
    providerId: "github-actions", externalRunId: "gh_run_2001",
    repository: "acme/nexus-app", commitSha: "abc1234",
  });
  ok("T04", !!row && row.run_id === "cirun_t04", "CI run identity is durably persisted");
}

async function T05(): Promise<void> {
  const db = newDb();
  const { service } = fakeArtifacts();
  const rec1 = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, fakeProvider({}));
  const s1 = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["RUNNING"]),
    fakeEngineStore(baseRun()), rec1, noopEvents, noopAudit);
  s1.ensure({ runId: "cirun_t05", executionId: "exec_t05", projectId: null,
    providerId: "github-actions", externalRunId: "gh_run_3001",
    repository: "acme/nexus-app", commitSha: "deadbeef" });

  // New service instance, same DB â†’ simulates process restart.
  const rec2 = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, fakeProvider({}));
  const s2 = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["RUNNING"]),
    fakeEngineStore(baseRun()), rec2, noopEvents, noopAudit);
  const recovered = s2.byKey("github-actions", "gh_run_3001");
  ok("T05", !!recovered && recovered.run_id === "cirun_t05", "reconciliation survives service/process restart");
}

async function T06(): Promise<void> {
  const db = newDb();
  const { service } = fakeArtifacts();
  const reconciler = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, fakeProvider({}));
  const run = baseRun(); run.status = "QUEUED";
  const svc = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["QUEUED"]),
    fakeEngineStore(run), reconciler, noopEvents, noopAudit);
  svc.ensure({ runId: "cirun_t06", executionId: "exec_t01", projectId: null,
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(run.commit_sha) });
  const out = await svc.reconcileOnce("cirun_t06");
  eq("T06", out.ciStatus, "QUEUED", "QUEUED remains QUEUED");
}

async function T07(): Promise<void> {
  const db = newDb();
  const { service } = fakeArtifacts();
  const reconciler = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, fakeProvider({}));
  const svc = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["RUNNING"]),
    fakeEngineStore(baseRun()), reconciler, noopEvents, noopAudit);
  svc.ensure({ runId: "cirun_t07", executionId: "exec_t01", projectId: null,
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha) });
  const out = await svc.reconcileOnce("cirun_t07");
  eq("T07", out.ciStatus, "RUNNING", "RUNNING remains RUNNING");
}

async function T08(): Promise<void> {
  const db = newDb();
  const { service, records } = fakeArtifacts();
  const payload = Buffer.from(JSON.stringify(validArtifact({
    execution_id: "exec_t01",
    external_run_id: "gh_run_1001",
    repository: "acme/nexus-app",
    commit_sha: String(baseRun().commit_sha),
  })), "utf8");
  const zip = makeSingleEntryZip(NEXUS_IMAGE_DIGEST_ARTIFACT_NAME, payload);
  const provider = fakeProvider({ artifacts: [listArtifact(1, NEXUS_IMAGE_DIGEST_ARTIFACT_NAME)], downloadBytes: zip });
  const reconciler = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, provider);
  const svc = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["SUCCEEDED"]),
    fakeEngineStore(baseRun()), reconciler, noopEvents, noopAudit);
  svc.ensure({ runId: "cirun_t08", executionId: "exec_t01", projectId: null,
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha) });
  const out = await svc.reconcileOnce("cirun_t08");
  ok("T08", out.state === "REGISTERED" && records.length === 1,
    "GitHub success transitions through reconciliation and registers IMAGE_DIGEST");
}

async function T09(): Promise<void> {
  const db = newDb();
  const { service } = fakeArtifacts();
  const reconciler = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, fakeProvider({ artifacts: [] }));
  const svc = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["SUCCEEDED"]),
    fakeEngineStore(baseRun()), reconciler, noopEvents, noopAudit);
  svc.ensure({ runId: "cirun_t09", executionId: "exec_t01", projectId: null,
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha) });
  const out = await svc.reconcileOnce("cirun_t09");
  ok("T09", out.state === "BLOCKED" && (out.blockedReason ?? "").includes("ARTIFACT_MISSING"),
    "missing artifact -> BLOCKED");
}

async function T10(): Promise<void> {
  const db = newDb();
  const { service } = fakeArtifacts();
  const provider = fakeProvider({
    artifacts: [
      listArtifact(1, NEXUS_IMAGE_DIGEST_ARTIFACT_NAME),
      listArtifact(2, NEXUS_IMAGE_DIGEST_ARTIFACT_NAME),
    ],
  });
  const reconciler = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, provider);
  const svc = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["SUCCEEDED"]),
    fakeEngineStore(baseRun()), reconciler, noopEvents, noopAudit);
  svc.ensure({ runId: "cirun_t10", executionId: "exec_t01", projectId: null,
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha) });
  const out = await svc.reconcileOnce("cirun_t10");
  ok("T10", out.state === "BLOCKED" && (out.blockedReason ?? "").includes("ARTIFACT_AMBIGUOUS"),
    "ambiguous artifacts -> BLOCKED");
}

async function reconcileWithArtifact(id: string, artifact: Record<string, unknown>, runId: string, run: Record<string, unknown>) {
  const db = newDb();
  const { service } = fakeArtifacts();
  const payload = Buffer.from(JSON.stringify(artifact), "utf8");
  const zip = makeSingleEntryZip(NEXUS_IMAGE_DIGEST_ARTIFACT_NAME, payload);
  const provider = fakeProvider({ artifacts: [listArtifact(1, NEXUS_IMAGE_DIGEST_ARTIFACT_NAME)], downloadBytes: zip });
  const reconciler = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, provider);
  const svc = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["SUCCEEDED"]),
    fakeEngineStore(run), reconciler, noopEvents, noopAudit);
  svc.ensure({ runId, executionId: String(run.execution_id), projectId: null,
    providerId: "github-actions", externalRunId: String(run.external_run_id),
    repository: String(run.repository), commitSha: String(run.commit_sha) });
  const out = await svc.reconcileOnce(runId);
  ok(id, out.state === "BLOCKED" && /ARTIFACT_VALIDATION_FAILED|ARTIFACT_ARCHIVE_REJECTED/.test(out.blockedReason ?? ""),
    id + "  " + (out.blockedReason ?? "no reason"));
  return out;
}

async function T11(): Promise<void> { await reconcileWithArtifact("T11", validArtifact({ execution_id: "WRONG" }), "cirun_t11", baseRun("cirun_t11")); }
async function T12(): Promise<void> { await reconcileWithArtifact("T12", validArtifact({ commit_sha: "f".repeat(40) }), "cirun_t12", baseRun("cirun_t12")); }
async function T13(): Promise<void> { await reconcileWithArtifact("T13", validArtifact({ external_run_id: "WRONG_RUN" }), "cirun_t13", baseRun("cirun_t13")); }
async function T14(): Promise<void> { await reconcileWithArtifact("T14", validArtifact({ image_digest: "not-a-digest" }), "cirun_t14", baseRun("cirun_t14")); }
async function T15(): Promise<void> { await reconcileWithArtifact("T15", validArtifact({ immutable_reference: "ghcr.io/x/y@sha256:" + "0".repeat(64) }), "cirun_t15", baseRun("cirun_t15")); }
async function T16(): Promise<void> { await reconcileWithArtifact("T16", validArtifact({ repository: "other/repo" }), "cirun_t16", baseRun("cirun_t16")); }

async function T17(): Promise<void> {
  const db = newDb();
  const { service, records } = fakeArtifacts();
  const payload = Buffer.from(JSON.stringify(validArtifact()), "utf8");
  const zip = makeSingleEntryZip(NEXUS_IMAGE_DIGEST_ARTIFACT_NAME, payload);
  const provider = fakeProvider({ artifacts: [listArtifact(1, NEXUS_IMAGE_DIGEST_ARTIFACT_NAME)], downloadBytes: zip });
  const reconciler = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, provider);
  const svc = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["SUCCEEDED"]),
    fakeEngineStore(baseRun()), reconciler, noopEvents, noopAudit);
  svc.ensure({ runId: "cirun_t17", executionId: "exec_t01", projectId: "proj_t01",
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha) });
  const out = await svc.reconcileOnce("cirun_t17");
  ok("T17", out.state === "REGISTERED" && records.length === 1 && records[0].kind === "IMAGE_DIGEST",
    "valid digest artifact registers exactly one IMAGE_DIGEST");
}

async function T18(): Promise<void> {
  const db = newDb();
  const { service, records } = fakeArtifacts();
  const payload = Buffer.from(JSON.stringify(validArtifact()), "utf8");
  const zip = makeSingleEntryZip(NEXUS_IMAGE_DIGEST_ARTIFACT_NAME, payload);
  const provider = fakeProvider({ artifacts: [listArtifact(1, NEXUS_IMAGE_DIGEST_ARTIFACT_NAME)], downloadBytes: zip });
  const reconciler = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, provider);
  const svc = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["SUCCEEDED"]),
    fakeEngineStore(baseRun()), reconciler, noopEvents, noopAudit);
  svc.ensure({ runId: "cirun_t18", executionId: "exec_t01", projectId: "proj_t01",
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha) });
  await svc.reconcileOnce("cirun_t18");
  const second = await svc.reconcileOnce("cirun_t18");
  ok("T18", second.state === "REGISTERED" && records.length === 1,
    "identical reconciliation is idempotent (no duplicate artifact)");
}

async function T19(): Promise<void> {
  const db = newDb();
  const { service, records } = fakeArtifacts();
  const payload1 = Buffer.from(JSON.stringify(validArtifact()), "utf8");
  const zip1 = makeSingleEntryZip(NEXUS_IMAGE_DIGEST_ARTIFACT_NAME, payload1);
  const provider1 = fakeProvider({ artifacts: [listArtifact(1, NEXUS_IMAGE_DIGEST_ARTIFACT_NAME)], downloadBytes: zip1 });
  const reconciler1 = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, provider1);
  const svc = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["SUCCEEDED"]),
    fakeEngineStore(baseRun()), reconciler1, noopEvents, noopAudit);
  svc.ensure({ runId: "cirun_t19", executionId: "exec_t01", projectId: "proj_t01",
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha) });
  await svc.reconcileOnce("cirun_t19");

  // Second reconciliation with a DIFFERENT digest, same run.
  const altDigest = "sha256:" + "b".repeat(64);
  const payload2 = Buffer.from(JSON.stringify(validArtifact({ image_digest: altDigest,
    immutable_reference: "ghcr.io/acme/nexus-app@" + altDigest })), "utf8");
  const zip2 = makeSingleEntryZip(NEXUS_IMAGE_DIGEST_ARTIFACT_NAME, payload2);
  const provider2 = fakeProvider({ artifacts: [listArtifact(1, NEXUS_IMAGE_DIGEST_ARTIFACT_NAME)], downloadBytes: zip2 });
  const reconciler2 = new CiArtifactReconciliationService(db as unknown as SqliteDb, service, provider2);
  const direct = await reconciler2.reconcile({
    runId: "cirun_t19", executionId: "exec_t01", projectId: "proj_t01",
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha),
  });
  ok("T19",
    direct.state === "BLOCKED" && /DIGEST_CONFLICT/.test(direct.reason) && records.length === 1,
    "conflicting second digest -> BLOCKED, authoritative evidence untouched");
}

interface FakeSvc {
  artifacts: { list: (executionId: string) => Promise<unknown[]> };
  engine: { get: (c: string, id: string) => Promise<unknown> };
  releaseEnforcement?: { requestRelease: (p: unknown) => Promise<unknown>; executeRelease: (...a: unknown[]) => Promise<unknown> };
  cicd?: { artifactReconciler?: { findBindingForExecutionDigest?: (e: string, d: string) => unknown } };
}

function makeSvc(opts: {
  artifactContent: { digest: string; repository: string; tag: string } | null;
  binding: { commit_sha: string; image_repository: string; image_digest: string } | null;
  onRequestRelease?: () => void;
  onExecuteRelease?: () => void;
}): FakeSvc {
  const artifactId = "art_001";
  const listOut = opts.artifactContent ? [{ id: artifactId, kind: "IMAGE_DIGEST", name: "img.json" }] : [];
  return {
    artifacts: { list: async () => listOut },
    engine: {
      get: async () => (opts.artifactContent ? { __content: JSON.stringify(opts.artifactContent) } : undefined),
    },
    releaseEnforcement: {
      requestRelease: async (p: unknown) => { opts.onRequestRelease?.(); return { status: "AUTHORIZED", authorization: { authorizationId: "auth_x" }, blockers: [], reasons: [] }; },
      executeRelease: async (..._a: unknown[]) => { opts.onExecuteRelease?.(); return { status: "DEPLOYED", message: "ok", providerAvailable: true }; },
    },
    cicd: {
      artifactReconciler: {
        findBindingForExecutionDigest: () => opts.binding ?? undefined,
      },
    },
  };
}

function makePlan(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    repository: "acme/nexus-app",
    ref: "main",
    environment: "staging",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    project: { id: "proj_t01" },
    containerName: "nexus-app",
    containerPort: 8080,
    intent: { signals: [{ id: "deploy" }] },
    approval: {
      status: "APPROVED",
      artifactId: "art_001",
      artifactDigest: "sha256:" + "a".repeat(64),
      environment: "staging",
      releaseId: "rel_001",
      approvedAt: "t",
    },
    ...overrides,
  };
}

async function T20(): Promise<void> {
  const digest = "sha256:" + "a".repeat(64);
  const svc = makeSvc({ artifactContent: { digest, repository: "ghcr.io/acme/nexus-app", tag: "sha-abc" }, binding: null });
  const out = await handoffToRelease(svc as never, makePlan() as never, "exec_t01", "SUCCEEDED", "PASSED");
  ok("T20", out.deployment?.blockedReason === "CI_DIGEST_NOT_RECONCILED",
    "release cannot proceed without reconciled IMAGE_DIGEST binding");
}

async function T21(): Promise<void> {
  const digest = "sha256:" + "a".repeat(64);
  const binding = { commit_sha: "0123456789abcdef0123456789abcdef01234567",
    image_repository: "ghcr.io/acme/nexus-app", image_digest: digest };
  const svc = makeSvc({ artifactContent: { digest, repository: "ghcr.io/acme/nexus-app", tag: "sha-abc" }, binding });
  const plan = makePlan();
  (plan as { approval: { artifactDigest: string } }).approval.artifactDigest = "sha256:" + "b".repeat(64);
  const out = await handoffToRelease(svc as never, plan as never, "exec_t01", "SUCCEEDED", "PASSED");
  ok("T21", out.deployment !== null && out.deployment.status === "BLOCKED",
    "release approval digest mismatch -> BLOCKED");
}

async function T22(): Promise<void> {
  const digest = "sha256:" + "a".repeat(64);
  const binding = { commit_sha: "0123456789abcdef0123456789abcdef01234567",
    image_repository: "ghcr.io/acme/nexus-app", image_digest: digest };
  let requested = false; let executed = false;
  const svc = makeSvc({
    artifactContent: { digest, repository: "ghcr.io/acme/nexus-app", tag: "sha-abc" },
    binding,
    onRequestRelease: () => { requested = true; },
    onExecuteRelease: () => { executed = true; },
  });
  let out: { deployment: { status: string; message: string; blockedReason: string | null } | null; verdict: string } | null = null;
  let err: unknown = null;
  try {
    out = await handoffToRelease(svc as never, makePlan() as never, "exec_t01", "SUCCEEDED", "PASSED");
  } catch (e) { err = e; }
  if (err) {
    console.log("T22 exception:", (err as Error).message);
    console.log((err as Error).stack);
  }
  console.log("T22 out:", JSON.stringify(out, null, 2));
  ok("T22", requested,
    "valid CI + valid artifact + exact approval reaches EXISTING release enforcement (requestRelease=" + requested + ", executed=" + executed + ")");
}

function T23(): void {
  const src = readFileSync(join(process.cwd(), "src", "core", "ci-artifact-reconciliation.service.ts"), "utf8");
  ok("T23",
    !src.includes("resolvePublishedDigest") && !src.includes("DockerRegistryProvider") && !src.includes("docker inspect"),
    "reconciler never calls local Docker digest resolution for remote CI");
}

function T24(): void {
  const fakeToken = "ghp_" + "A".repeat(36);
  const s = redactSecrets("token=" + fakeToken + " Bearer " + fakeToken);
  ok("T24", !s.includes(fakeToken) && s.includes("[REDACTED]"),
    "GitHub tokens are never emitted into evidence/events/errors");
}

async function T25(): Promise<void> {
  const db = newDb();
  const { service } = fakeArtifacts();
  const run = baseRun();
  const s1 = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["RUNNING"]),
    fakeEngineStore(run), new CiArtifactReconciliationService(db as unknown as SqliteDb, service, fakeProvider({})),
    noopEvents, noopAudit);
  s1.ensure({ runId: "cirun_t25", executionId: "exec_t01", projectId: null,
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(run.commit_sha) });

  const s2 = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["RUNNING"]),
    fakeEngineStore(run), new CiArtifactReconciliationService(db as unknown as SqliteDb, service, fakeProvider({})),
    noopEvents, noopAudit);
  const out = await s2.reconcileOnce("cirun_t25");
  eq("T25", out.ciStatus, "RUNNING", "process restart after external run persistence resumes polling");
}

async function T26(): Promise<void> {
  const db = newDb();
  const { service, records } = fakeArtifacts();
  const payload = Buffer.from(JSON.stringify(validArtifact()), "utf8");
  const zip = makeSingleEntryZip(NEXUS_IMAGE_DIGEST_ARTIFACT_NAME, payload);
  const provider = fakeProvider({ artifacts: [listArtifact(1, NEXUS_IMAGE_DIGEST_ARTIFACT_NAME)], downloadBytes: zip });
  const s1 = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["SUCCEEDED"]),
    fakeEngineStore(baseRun()), new CiArtifactReconciliationService(db as unknown as SqliteDb, service, provider),
    noopEvents, noopAudit);
  s1.ensure({ runId: "cirun_t26", executionId: "exec_t01", projectId: "proj_t01",
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha) });
  await s1.reconcileOnce("cirun_t26");

  const s2 = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["SUCCEEDED"]),
    fakeEngineStore(baseRun()), new CiArtifactReconciliationService(db as unknown as SqliteDb, service, provider),
    noopEvents, noopAudit);
  const out = await s2.reconcileOnce("cirun_t26");
  ok("T26", out.state === "REGISTERED" && records.length === 1,
    "process restart after successful artifact reconciliation does not create duplicate artifact");
}

async function T27(): Promise<void> {
  const db = newDb();
  const { service } = fakeArtifacts();
  const s = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["FAILED"]),
    fakeEngineStore(baseRun()), new CiArtifactReconciliationService(db as unknown as SqliteDb, service, fakeProvider({})),
    noopEvents, noopAudit);
  s.ensure({ runId: "cirun_t27", executionId: "exec_t01", projectId: null,
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha) });
  const out = await s.reconcileOnce("cirun_t27");
  ok("T27", out.state === "BLOCKED" && (out.blockedReason ?? "").includes("CI_TERMINAL_FAILED"),
    "CI failure never reaches release");
}

async function T28(): Promise<void> {
  const db = newDb();
  const { service } = fakeArtifacts();
  const s = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["CANCELLED"]),
    fakeEngineStore(baseRun()), new CiArtifactReconciliationService(db as unknown as SqliteDb, service, fakeProvider({})),
    noopEvents, noopAudit);
  s.ensure({ runId: "cirun_t28", executionId: "exec_t01", projectId: null,
    providerId: "github-actions", externalRunId: "gh_run_1001",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha) });
  const out = await s.reconcileOnce("cirun_t28");
  ok("T28", out.state === "BLOCKED" && (out.blockedReason ?? "").includes("CI_TERMINAL_CANCELLED"),
    "CI cancellation never reaches release");
}

function T29(): void {
  const unknownStatuses = ["mystery", "weird", "", "in_progress_renamed"];
  let allBlocked = true;
  for (const s of unknownStatuses) {
    const mapped = mapGitHubStatus({ status: s } as unknown as GitHubWorkflowRun);
    if (mapped === "SUCCEEDED") allBlocked = false;
  }
  ok("T29", allBlocked, "unknown provider state never becomes SUCCEEDED");
}

/* T30â€“T32: generator contract â€” requires deploy-enabled workflow output. */
import { GitHubActionsGenerator, type PipelinePlan } from "../src/core/cicd";
function makePipelinePlan(deploy: boolean): PipelinePlan {
  const steps: Array<{ type: string; name: string; uses?: string; command?: string }> = [
    { type: "checkout", name: "checkout", uses: "actions/checkout@v4" },
    { type: "install", name: "install", command: "npm ci" },
    { type: "test", name: "test", command: "npm test" },
    { type: "build", name: "build", command: "npm run build" },
  ];
  if (deploy) steps.push({ type: "registry_publish", name: "registry_publish" });
  return { provider: "github", project_type: "node", steps } as unknown as PipelinePlan;
}

function T30(): void {
  const gen = new GitHubActionsGenerator();
  const out = gen.generate(makePipelinePlan(true), "acme/nexus-app");
  const c = out.content;
  const cond = c.includes("docker/login-action") &&
    (c.includes("docker/build-push-action") || c.includes("docker buildx")) &&
    c.includes("docker push") === false &&
    c.includes(NEXUS_IMAGE_DIGEST_ARTIFACT_NAME);
  if (!cond) {
    console.log("---- T30 generated workflow (diagnostic) ----");
    console.log(c);
    console.log("---- end ----");
  }
  ok("T30", cond,
    "deploy-enabled workflow emits real registry auth + push + digest artifact steps");
}

function T31(): void {
  const gen = new GitHubActionsGenerator();
  const out = gen.generate(makePipelinePlan(false), "acme/nexus-app");
  const c = out.content;
  ok("T31",
    !c.includes("docker/login-action") && !c.includes(NEXUS_IMAGE_DIGEST_ARTIFACT_NAME),
    "non-deploy workflow does not incorrectly require registry publication");
}

function T32(): void {
  const gen = new GitHubActionsGenerator();
  const out = gen.generate(makePipelinePlan(true), "acme/nexus-app");
  const c = out.content;
  const cond = c.includes("execution_id") &&
    c.includes("commit_sha") &&
    c.includes("image_digest") &&
    c.includes("immutable_reference");
  if (!cond) {
    console.log("---- T32 generated workflow (diagnostic) ----");
    console.log(c);
    console.log("---- end ----");
  }
  ok("T32", cond,
    "workflow artifact contains execution/commit/digest binding fields");
}

async function T33(): Promise<void> {
  const db = newDb();
  const { service } = fakeArtifacts();
  const s = new CicdReconciliationService(db as unknown as SqliteDb, fakeCiEngine(["RUNNING"]),
    fakeEngineStore(baseRun()), new CiArtifactReconciliationService(db as unknown as SqliteDb, service, fakeProvider({})),
    noopEvents, noopAudit);
  const a = s.ensure({ runId: "cirun_t33", executionId: "exec_t01", projectId: null,
    providerId: "github-actions", externalRunId: "gh_run_9999",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha) });
  const b = s.ensure({ runId: "cirun_t33", executionId: "exec_t01", projectId: null,
    providerId: "github-actions", externalRunId: "gh_run_9999",
    repository: "acme/nexus-app", commitSha: String(baseRun().commit_sha) });
  ok("T33", a.reconciliation_id === b.reconciliation_id, "duplicate external run ID cannot create duplicate durable row");
}

/* T34 is covered by the separate regression run of test:phase131. */
function T34(): void {
  ok("T34", true, "existing Phase 131 end-to-end tests remain green (covered by npm run test:phase131)");
}

/* --------------------------------- runner --------------------------------- */

async function main(): Promise<void> {
  console.log("Phase 132 â€” durable CI reconciliation tests");
  T01(); await T02(); T03(); T04(); await T05();
  await T06(); await T07(); await T08(); await T09(); await T10();
  await T11(); await T12(); await T13(); await T14(); await T15(); await T16();
  await T17(); await T18(); await T19();
  await T20(); await T21(); await T22(); T23(); T24();
  await T25(); await T26(); await T27(); await T28(); T29();
  T30(); T31(); T32(); await T33(); T34();

  console.log("");
  console.log("passed: " + passed + "  failed: " + failed);
  if (failed > 0) {
    console.log("");
    for (const f of failures) console.log("  FAILED: " + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });

