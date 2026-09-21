// scripts/test-phase171-project-scoped-cicd-release-integrity.ts
//
// Phase 171 - project-scoped CI/CD, release & deployment integrity.
// Real SQLite + real services. No mocks for authorization semantics.

import Database from "better-sqlite3";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { AuditService } from "../src/core/audit";
import { EventService } from "../src/core/events";
import { ProjectMembershipStore } from "../src/core/project-membership-store";
import { ProjectMembershipService } from "../src/core/project-membership-service";
import { ExecutionStore } from "../src/core/execution-store";
import {
  ProjectService,
  ExecutionService,
  EvidenceService,
  ArtifactService,
  type ServiceContext,
  type Actor,
} from "../src/core/services";
import { PipelineAgent } from "../src/core/cicd";
import { PipelineValidator, GitHubActionsGenerator, GitLabCIGenerator } from "../src/core/cicd";
import { ProjectDetector } from "../src/core/devops";
import { ProductionReleaseEnforcementService } from "../src/core/production-release-enforcement";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { isNexusError } from "../src/core/errors";
import type { User } from "../src/core/types";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }
async function expectFail(fn: () => Promise<unknown>, msg: string): Promise<string | null> {
  try { await fn(); ok(false, msg + " (no throw)"); return null; }
  catch (e) {
    const c = isNexusError(e) ? e.code : "?";
    ok(true, msg + " [" + c + "]");
    return c;
  }
}

interface H {
  db: Database.Database;
  engine: SQLiteEngine;
  ctx: ServiceContext;
  execStore: ExecutionStore;
  projects: ProjectService;
  executions: ExecutionService;
  evidence: EvidenceService;
  artifacts: ArtifactService;
  memberships: ProjectMembershipService;
  store: ProjectMembershipStore;
  agent: PipelineAgent;
}

function makeHarness(): H {
  const raw = new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  raw.exec(
    "CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));"
  );
  const engine = SQLiteEngine.fromDatabase(raw);
  const events = new EventService(engine);
  const audit = new AuditService(engine);
  const store = new ProjectMembershipStore(raw);
  const ctx: ServiceContext = { engine, events, audit, memberships: store };
  const execStore = new ExecutionStore(raw);
  const agent = new PipelineAgent({
    detector: new ProjectDetector(),
    github: new GitHubActionsGenerator(),
    gitlab: new GitLabCIGenerator(),
    validator: new PipelineValidator(),
    events,
    audit,
    evidence: new EvidenceService(ctx),
    artifacts: new ArtifactService(ctx),
    engine,
    memberships: store,
  });
  return {
    db: raw,
    engine,
    ctx,
    execStore,
    projects: new ProjectService(ctx),
    executions: new ExecutionService(ctx),
    evidence: new EvidenceService(ctx),
    artifacts: new ArtifactService(ctx),
    memberships: new ProjectMembershipService(ctx),
    store,
    agent,
  };
}

function mkActor(id: string, role: string, status = "active"): Actor {
  return {
    id, email: id + "@test.nexus", name: id,
    role: role as any, status: status as any,
    created_at: Date.now(), updated_at: Date.now(),
  } as Actor;
}

async function seedUser(h: H, id: string, role = "VIEWER"): Promise<void> {
  const u: User = {
    id, email: id + "@test.nexus", name: id,
    role: role as any, status: "active" as any,
    password_hash: "x", salt: "x", iterations: 1,
    created_at: Date.now(), updated_at: Date.now(),
  } as User;
  await h.engine.put("users", id, u);
}

function memReader(files: Record<string, string>) {
  return {
    async read(path: string) {
      return files[path] ?? null;
    },
    async list() {
      return Object.keys(files);
    },
  } as any;
}
async function main(): Promise<void> {
  console.log("=== Phase 171 - Project-Scoped CI/CD & Release Integrity ===\n");

  section("A - PipelineAgent authorization");
  {
    const h = makeHarness();
    const owner = mkActor("u-a-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "A-project" });
    const exec = await h.executions.createQueued(owner, p.id, "run A");
    const reader = memReader({ "package.json": JSON.stringify({ name: "a", scripts: { test: "jest" } }) });

    // A1 owner runs
    const res = await h.agent.run(owner, exec.id, p.id, reader, "github", "corr-a1");
    ok(res.plan.project_type !== undefined, "A1 owner runs PipelineAgent");

    // A2 mismatched projectId rejected
    await expectFail(
      () => h.agent.run(owner, exec.id, "wrong-project", reader, "github", "corr-a2"),
      "A2 mismatched projectId rejected",
    );

    // A3 missing execution -> masked as EXECUTION_NOT_FOUND
    await expectFail(
      () => h.agent.run(owner, "no-such-exec", p.id, reader, "github", "corr-a3"),
      "A3 missing execution rejected",
    );

    // A4 unauth actor
    await seedUser(h, "u-a-out", "ADMIN");
    const out = mkActor("u-a-out", "ADMIN");
    await expectFail(
      () => h.agent.run(out, exec.id, p.id, reader, "github", "corr-a4"),
      "A4 non-member rejected",
    );

    // A5 suspended actor
    const susp = mkActor("u-a-susp", "ADMIN", "suspended");
    await expectFail(
      () => h.agent.run(susp, exec.id, p.id, reader, "github", "corr-a5"),
      "A5 suspended actor rejected",
    );

    // A6 viewer (no execution:create) rejected
    await seedUser(h, "u-a-viewer", "ADMIN");
    h.store.upsert(p.id, "u-a-viewer", "PROJECT_VIEWER");
    await expectFail(
      () => h.agent.run(mkActor("u-a-viewer", "ADMIN"), exec.id, p.id, reader, "github", "corr-a6"),
      "A6 project viewer cannot run agent",
    );

    // A7 operator (has execution:create) succeeds
    await seedUser(h, "u-a-op", "ADMIN");
    h.store.upsert(p.id, "u-a-op", "PROJECT_OPERATOR");
    const r7 = await h.agent.run(mkActor("u-a-op", "ADMIN"), exec.id, p.id, reader, "github", "corr-a7");
    ok(!!r7.config, "A7 project operator runs agent");

    // A8 admin (has execution:create) succeeds
    await seedUser(h, "u-a-admin", "ADMIN");
    h.store.upsert(p.id, "u-a-admin", "PROJECT_ADMIN");
    const r8 = await h.agent.run(mkActor("u-a-admin", "ADMIN"), exec.id, p.id, reader, "github", "corr-a8");
    ok(!!r8.config, "A8 project admin runs agent");

    // A9 cross-project actor rejected
    const ownerB = mkActor("u-a-ownerB", "ADMIN");
    await h.projects.create(ownerB, { name: "A-project-B" });
    await expectFail(
      () => h.agent.run(ownerB, exec.id, p.id, reader, "github", "corr-a9"),
      "A9 foreign project owner rejected",
    );
  }

  section("B - requestRelease authoritative project resolution");
  {
    const h = makeHarness();
    const owner = mkActor("u-b-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "B-project" });
    const exec = await h.executions.createQueued(owner, p.id, "run B");

    // Build a minimal decision stub that always ALLOWs
    const decisionStub: any = {
      async decide(params: any) {
        return {
          status: "ALLOW",
          releaseId: params.releaseId,
          artifactId: params.artifactId,
          artifactDigest: params.artifactDigest,
          securityStatus: "PASS", riskScore: 0, policyStatus: "PASS",
          approvalStatus: "APPROVED", blockers: [], warnings: [],
        };
      },
    };
    const enforcement = new ProductionReleaseEnforcementService(
      {} as any, {} as any, decisionStub, undefined, undefined, h.engine,
    );
    const approval: any = {
      releaseId: "rel-b1", artifactId: "art-b1", artifactDigest: "sha256:b1",
      environment: "production", approver: "owner",
      approvedAt: new Date().toISOString(), status: "APPROVED",
    };

    // B1 matching projectId + existing execution -> AUTHORIZED
    const r1 = await enforcement.requestRelease({
      releaseId: "rel-b1", executionId: exec.id, artifactId: "art-b1",
      artifactDigest: "sha256:b1", commitSha: "c-b1", environment: "production",
      approval, projectId: p.id, imageRepository: "nexus/b1", imageTag: "v1",
      imageId: "sha256:b1", containerName: "b1-c", containerPort: 8080,
    });
    ok(r1.status === "AUTHORIZED", "B1 matching project authorized");

    // B2 mismatched projectId -> BLOCKED
    const r2 = await enforcement.requestRelease({
      releaseId: "rel-b2", executionId: exec.id, artifactId: "art-b2",
      artifactDigest: "sha256:b2", commitSha: "c-b2", environment: "production",
      approval: { ...approval, releaseId: "rel-b2", artifactId: "art-b2", artifactDigest: "sha256:b2" },
      projectId: "wrong-project", imageRepository: "nexus/b2", imageTag: "v1",
      imageId: "sha256:b2", containerName: "b2-c", containerPort: 8080,
    });
    ok(r2.status === "BLOCKED", "B2 mismatched project blocked");

    // B3 missing execution -> BLOCKED
    const r3 = await enforcement.requestRelease({
      releaseId: "rel-b3", executionId: "no-such-exec", artifactId: "art-b3",
      artifactDigest: "sha256:b3", commitSha: "c-b3", environment: "production",
      approval: { ...approval, releaseId: "rel-b3", artifactId: "art-b3", artifactDigest: "sha256:b3" },
      projectId: p.id, imageRepository: "nexus/b3", imageTag: "v1",
      imageId: "sha256:b3", containerName: "b3-c", containerPort: 8080,
    });
    ok(r3.status === "BLOCKED", "B3 missing execution blocked");

    // B4 authorization.projectId is authoritative (equal to execution.project_id)
    if (r1.status === "AUTHORIZED" && r1.authorization) {
      ok(r1.authorization.projectId === p.id, "B4 authorization carries authoritative project");
    } else {
      ok(false, "B4 authorization issued for inspection");
    }
  }
  section("C - Durable attempt binding through executeRelease");
  {
    const h = makeHarness();
    const owner = mkActor("u-c-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "C-project" });
    const exec = await h.executions.createQueued(owner, p.id, "run C");

    // Seed a job + attempt whose payload.executionId === releaseId
    const jobId = "job-c1";
    const attemptId = "attempt-c1";
    h.execStore.createJob({
      id: jobId, idempotencyKey: "k-c1", jobType: "engineering",
      payload: { kind: "engineering", executionId: exec.id },
      status: "QUEUED", createdAt: Date.now(), updatedAt: Date.now(),
      cancellationRequested: false, cancellationAcknowledged: false,
    } as any);
    h.execStore.createAttempt({
      id: attemptId, jobId, attemptNumber: 1, status: "RUNNING",
      workerId: "w-c1", leaseId: "L-c1",
      startedAt: Date.now(), createdAt: Date.now(),
    } as any);

    // A stub provider that never actually deploys — just records invocation
    let providerCalls = 0;
    const providerStub: any = {
      async execute(req: any) {
        providerCalls++;
        return { status: "DEPLOYED", message: "stub", deploymentId: "dep-c1" };
      },
    };

    const decisionStub: any = {
      async decide(params: any) {
        return {
          status: "ALLOW",
          releaseId: params.releaseId, artifactId: params.artifactId,
          artifactDigest: params.artifactDigest,
          securityStatus: "PASS", riskScore: 0, policyStatus: "PASS",
          approvalStatus: "APPROVED", blockers: [], warnings: [],
        };
      },
    };
    const enforcement = new ProductionReleaseEnforcementService(
      {} as any, {} as any, decisionStub, providerStub, h.execStore, h.engine,
    );

    const approval: any = {
      releaseId: "rel-c1", artifactId: "art-c1", artifactDigest: "sha256:c1",
      environment: "production", approver: "owner",
      approvedAt: new Date().toISOString(), status: "APPROVED",
    };
    const reqRes = await enforcement.requestRelease({
      releaseId: exec.id, executionId: exec.id, artifactId: "art-c1",
      artifactDigest: "sha256:c1", commitSha: "c-c1", environment: "production",
      approval: { ...approval, releaseId: exec.id },
      projectId: p.id, imageRepository: "nexus/c1", imageTag: "v1",
      imageId: "sha256:c1", containerName: "c1-c", containerPort: 8080,
    });
    ok(reqRes.status === "AUTHORIZED", "C1 authorized with durable attempt present");

    if (reqRes.status === "AUTHORIZED" && reqRes.authorization) {
      const auth = reqRes.authorization;
      const dep = await enforcement.executeRelease(
        auth.authorizationId, auth.releaseId, auth.artifactId,
        auth.commitSha, auth.environment, attemptId,
      );
      ok(dep.status === "DEPLOYED", "C2 executeRelease with valid attempt reaches provider");
      ok(providerCalls === 1, "C3 provider invoked exactly once");
    } else {
      ok(false, "C2 precondition");
      ok(false, "C3 precondition");
    }

    // C4 missing attempt rejects
    const reqResC4 = await enforcement.requestRelease({
      releaseId: exec.id, executionId: exec.id, artifactId: "art-c4",
      artifactDigest: "sha256:c4", commitSha: "c-c4", environment: "production",
      approval: { ...approval, releaseId: exec.id, artifactId: "art-c4", artifactDigest: "sha256:c4" },
      projectId: p.id, imageRepository: "nexus/c4", imageTag: "v1",
      imageId: "sha256:c4", containerName: "c4-c", containerPort: 8080,
    });
    if (reqResC4.status === "AUTHORIZED" && reqResC4.authorization) {
      const auth = reqResC4.authorization;
      const dep = await enforcement.executeRelease(
        auth.authorizationId, auth.releaseId, auth.artifactId,
        auth.commitSha, auth.environment, "no-such-attempt",
      );
      ok(dep.status === "BLOCKED", "C4 nonexistent attempt blocked");
    } else {
      ok(false, "C4 precondition");
    }

    // C5 attempt from another job rejects
    const jobId2 = "job-c5";
    h.execStore.createJob({
      id: jobId2, idempotencyKey: "k-c5", jobType: "engineering",
      payload: { kind: "engineering", executionId: "some-other-exec" },
      status: "QUEUED", createdAt: Date.now(), updatedAt: Date.now(),
      cancellationRequested: false, cancellationAcknowledged: false,
    } as any);
    h.execStore.createAttempt({
      id: "attempt-c5", jobId: jobId2, attemptNumber: 1, status: "RUNNING",
      workerId: "w-c5", leaseId: "L-c5",
      startedAt: Date.now(), createdAt: Date.now(),
    } as any);

    const reqResC5 = await enforcement.requestRelease({
      releaseId: exec.id, executionId: exec.id, artifactId: "art-c5",
      artifactDigest: "sha256:c5", commitSha: "c-c5", environment: "production",
      approval: { ...approval, releaseId: exec.id, artifactId: "art-c5", artifactDigest: "sha256:c5" },
      projectId: p.id, imageRepository: "nexus/c5", imageTag: "v1",
      imageId: "sha256:c5", containerName: "c5-c", containerPort: 8080,
    });
    if (reqResC5.status === "AUTHORIZED" && reqResC5.authorization) {
      const auth = reqResC5.authorization;
      const dep = await enforcement.executeRelease(
        auth.authorizationId, auth.releaseId, auth.artifactId,
        auth.commitSha, auth.environment, "attempt-c5",
      );
      ok(dep.status === "BLOCKED", "C5 attempt from another execution blocked");
    } else {
      ok(false, "C5 precondition");
    }
  }

  section("D - Intent idempotency and recovery semantics");
  {
    const h = makeHarness();
    const owner = mkActor("u-d-owner", "ADMIN");
    const p = await h.projects.create(owner, { name: "D-project" });
    const exec = await h.executions.createQueued(owner, p.id, "run D");

    const intents = new ReleaseDeploymentIntentService(h.execStore);

    const input: any = {
      releaseId: "rel-d1", executionId: exec.id, attemptId: "attempt-d1",
      artifactId: "art-d1", artifactDigest: "sha256:d1", commitSha: "c-d1",
      environment: "production", projectId: p.id,
      imageRepository: "nexus/d1", imageTag: "v1", imageId: "sha256:d1",
      imageDigest: "sha256:d1", containerName: "d1-c", containerPort: 8080,
    };

    // D1 first call creates
    const r1 = await intents.getOrCreate(input);
    ok(r1.created === true, "D1 first getOrCreate creates intent");

    // D2 identical call is idempotent
    const r2 = await intents.getOrCreate(input);
    ok(r2.created === false, "D2 identical getOrCreate is idempotent");
    ok(r2.intent.intentKey === r1.intent.intentKey, "D3 same intentKey");

    // D4 different executionId -> different key -> creates new
    const r4 = await intents.getOrCreate({ ...input, executionId: "other-exec" });
    ok(r4.created === true, "D4 different executionId is a new intent");
    ok(r4.intent.intentKey !== r1.intent.intentKey, "D5 different intentKey");

    // D6 terminal state persisted
    const r6 = await intents.getOrCreate({ ...input, releaseId: "rel-d6" });
    h.execStore.updateReleaseIntentStatus(r6.intent.intentKey, "KNOWN_GOOD", { deploymentId: "dep-d6" });
    const after = intents.get(r6.intent.intentKey);
    ok(after?.status === "KNOWN_GOOD", "D6 terminal state persisted");
    ok(after?.deploymentId === "dep-d6", "D7 deploymentId persisted");

    // D8 replay of terminal intent stays terminal
    const r8 = await intents.getOrCreate({ ...input, releaseId: "rel-d6" });
    ok(r8.created === false, "D8 terminal intent reused, not recreated");
    ok(r8.intent.status === "KNOWN_GOOD", "D9 terminal status unchanged");
  }

  section("E - Enumeration resistance");
  {
    const h = makeHarness();
    const ownerA = mkActor("u-e-ownerA", "ADMIN");
    const ownerB = mkActor("u-e-ownerB", "ADMIN");
    const pA = await h.projects.create(ownerA, { name: "E-A" });
    const pB = await h.projects.create(ownerB, { name: "E-B" });
    const execA = await h.executions.createQueued(ownerA, pA.id, "run A");
    const reader = memReader({ "package.json": JSON.stringify({ name: "x" }) });

    // E1 missing execution and foreign execution produce the same error code
    const missCode = await expectFail(
      () => h.agent.run(ownerB, "no-such-exec-e", pB.id, reader, "github", "corr-e1"),
      "E1 missing execution rejected",
    );
    const foreignCode = await expectFail(
      () => h.agent.run(ownerB, execA.id, pB.id, reader, "github", "corr-e2"),
      "E2 foreign execution rejected",
    );
    ok(missCode === foreignCode, "E3 same error code (no existence oracle)");

    // E4 evidence list(actor) without executionId cannot see foreign evidence
    await h.evidence.record(ownerA, execA.id, { type: "log", source: "REAL_EXECUTION", content: "a-only" });
    const listA = await h.evidence.list(ownerA);
    const listB = await h.evidence.list(ownerB);
    ok(listA.length === 1, "E4 owner A sees own evidence");
    ok(listB.length === 0, "E5 owner B sees no foreign evidence");
  }
  console.log("\n=== Phase 171 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL: " + (e && e.stack ? e.stack : e)); process.exit(1); });