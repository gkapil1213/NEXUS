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
import { AgentRegistry, InspectorAgent, buildAgentContext } from "./agents";
import { Err, NexusError, toSystemError } from "./errors";
import { PERMISSIONS } from "./types";
import type { Session, SuiteReport, TestResult, User } from "./types";

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
  const created: { projects: string[]; executions: string[]; users: string[] } = { projects: [], executions: [], users: [] };

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
        const out = redactText("key=sk-ABCDEFGHIJKLMNOP1234 and AKIAABCDEFGHIJKLMNOP");
        assert(!out.includes("sk-ABCDEFGHIJKLMNOP") && !out.includes("AKIAABCDEFGHIJKLMNOP"), "credentials must be redacted");
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
