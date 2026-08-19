/**
 * NEXUS Phase 1 — NexusKernel.
 *
 * The platform foundation: initializes persistence, events, audit, agents,
 * services and orchestration in a strict order, tracks boot steps for the
 * UI, and fails loudly (never partially-silently) when a subsystem cannot
 * start. Contains no business logic — that lives in services and agents.
 */

import { AuditService } from "./audit";
import { AgentRegistry, InspectorAgent } from "./agents";
import { CONFIG, configBlocked, safeConfigView } from "./config";
import { openEngine, probeEngine, type NexusEngine } from "./db";
import { Err, NexusError } from "./errors";
import { EventService } from "./events";
import { NexusOrchestrator } from "./orchestration";
import { ArtifactService, ExecutionService, EvidenceService, ProjectService, type ServiceContext } from "./services";
import {
  AuthorizationService,
  IdentityService,
  LocalSecretProvider,
  SessionService,
  createUserRecord,
  toPublicUser,
  verifyPassword,
  type SecretProvider,
} from "./security";
import { GitHubService } from "./github";
import { AgentPolicyEngine, ExecutionPolicyEngine, AgentExecutionService } from "./execution-policy";
import { BrowserSandbox, FileAccessPolicy, WorkspaceService, DEFAULT_WORKSPACE_LIMITS } from "./workspace";
import type { ExecutionSandbox, BootStep, HealthReport, PublicUser, Session, SubsystemHealth, User } from "./types";

export interface KernelServices {
  engine: NexusEngine;
  events: EventService;
  audit: AuditService;
  registry: AgentRegistry;
  orchestrator: NexusOrchestrator;
  projects: ProjectService;
  executions: ExecutionService;
  evidence: EvidenceService;
  artifacts: ArtifactService;
  sessions: SessionService;
  secrets: SecretProvider;
  github: GitHubService;
  // Phase 2 Pass 1 — centralized authorization + identity lifecycle.
  authz: AuthorizationService;
  identity: IdentityService;
  // Phase 2 Pass 2 — secure agent execution & execution policy.
  agentPolicy: AgentPolicyEngine;
  execPolicy: ExecutionPolicyEngine;
  agentExec: AgentExecutionService;
  // Phase 2 Pass 3 — workspace isolation & sandbox.
  workspaces: WorkspaceService;
  sandbox: ExecutionSandbox;
}

const BOOT_ORDER = [
  ["config", "validate configuration"],
  ["persistence", "open persistence engine"],
  ["events", "start event system"],
  ["audit", "attach audit trail"],
  ["secrets", "initialize secret provider"],
  ["agents", "register agent framework"],
  ["orchestration", "assemble orchestration"],
] as const;

export class NexusKernel {
  readonly steps: BootStep[] = BOOT_ORDER.map(([id, label]) => ({ id, label, status: "pending", detail: null }));
  services!: KernelServices;
  status: "booting" | "ready" | "failed" = "booting";
  failure: NexusError | null = null;

  private step(id: string, status: BootStep["status"], detail: string | null = null): void {
    const s = this.steps.find((x) => x.id === id);
    if (s) {
      s.status = status;
      s.detail = detail;
    }
  }

  /** Boot in enforced order. Any failure aborts startup with a structured error. */
  async boot(): Promise<KernelServices> {
    try {
      // 1. config
      this.step("config", "running");
      if (configBlocked()) {
        throw Err.startup("CONFIG_INVALID", `configuration validation failed: ${CONFIG.issues.join("; ")}`);
      }
      this.step("config", "ok", `${CONFIG.env} · v${CONFIG.version}`);

      // 2. persistence
      this.step("persistence", "running");
      const engine = await openEngine();
      const latency = await probeEngine(engine).catch(() => null);
      if (latency === null) {
        this.step("persistence", "fail", "probe failed");
        throw Err.startup("PERSISTENCE_FAILED", "persistence engine failed its round-trip probe");
      }
      this.step("persistence", "ok", `${engine.kind} · ${latency}ms`);

      // 3. events
      this.step("events", "running");
      const events = new EventService(engine);
      await events.init();
      this.step("events", "ok", "append-only sequence resumed");

      // 4. audit
      this.step("audit", "running");
      const audit = new AuditService(engine);
      await audit.probe();
      this.step("audit", "ok", "immutable ledger attached");

      // 5. secrets
      this.step("secrets", "running");
      const secrets = new LocalSecretProvider(engine);
      this.step("secrets", "ok", "local provider (references only)");

      // 6. agents
      this.step("agents", "running");
      const registry = new AgentRegistry();
      registry.register(new InspectorAgent());
      this.step("agents", "ok", `${registry.count()} agent(s)`);

      // 7. orchestration
      this.step("orchestration", "running");
      const svcCtx: ServiceContext = { engine, events, audit };
      const projects = new ProjectService(svcCtx);
      const executions = new ExecutionService(svcCtx);
      const evidence = new EvidenceService(svcCtx);
      const artifacts = new ArtifactService(svcCtx);
      const orchestrator = new NexusOrchestrator({ engine, events, audit, registry, projects, executions, evidence, artifacts });
      this.step("orchestration", "ok", "deterministic path assembled");

      // Phase 2 Pass 1 — centralized authorization + identity lifecycle.
      const authz = new AuthorizationService(audit);
      const identity = new IdentityService(engine, authz, audit);

      // Phase 2 Pass 2 — secure agent execution & execution policy.
      const agentPolicy = new AgentPolicyEngine();
      const execPolicy = new ExecutionPolicyEngine(registry, authz, agentPolicy);
      const agentExec = new AgentExecutionService({ engine, registry, authz, agentPolicy, execPolicy, audit, events });

      // Phase 2 Pass 3 — workspace isolation & sandbox (logical boundary;
      // BrowserSandbox.isolationReport() states the true isolation level).
      const filePolicy = new FileAccessPolicy();
      const workspaces = new WorkspaceService({
        engine,
        authz,
        audit,
        events,
        policy: filePolicy,
        limits: DEFAULT_WORKSPACE_LIMITS,
      });
      const sandbox: ExecutionSandbox = new BrowserSandbox(workspaces);
      agentExec.attachSandbox(workspaces);

      this.services = {
        engine,
        events,
        audit,
        registry,
        orchestrator,
        projects,
        executions,
        evidence,
        artifacts,
        sessions: new SessionService(engine),
        secrets,
        authz,
        identity,
        agentPolicy,
        execPolicy,
        agentExec,
        workspaces,
        sandbox,
        // Optional integration: no boot dependency, connects on demand.
        github: new GitHubService(),
      };
      this.status = "ready";
      await audit.record({
        actor: "system",
        action: "kernel.boot",
        resource_type: "platform",
        resource_id: "nexus",
        result: "info",
        metadata: { version: CONFIG.version, env: CONFIG.env, engine: engine.kind },
      });
      return this.services;
    } catch (e) {
      this.status = "failed";
      this.failure = e instanceof NexusError ? e : Err.startup("STARTUP_FAILED", (e as Error).message ?? "startup failed");
      const running = this.steps.find((s) => s.status === "running");
      if (running) this.step(running.id, "fail", this.failure.message);
      throw this.failure;
    }
  }

  /** Real health: probes each subsystem; never reports healthy when a probe fails. */
  async health(): Promise<HealthReport> {
    const subsystems: SubsystemHealth[] = [];

    const dbT0 = performance.now();
    let dbOk = false;
    try {
      await probeEngine(this.services.engine);
      dbOk = true;
    } catch {
      dbOk = false;
    }
    subsystems.push({
      name: "database",
      status: dbOk ? "healthy" : "blocked",
      detail: dbOk ? `${this.services.engine.kind} round-trip ok` : "probe failed",
      latency_ms: dbOk ? Math.round((performance.now() - dbT0) * 10) / 10 : null,
    });

    const eventsOk = await this.services.events.probe();
    subsystems.push({ name: "events", status: eventsOk ? "healthy" : "blocked", detail: eventsOk ? "append-only store readable" : "unreadable", latency_ms: null });

    const auditOk = await this.services.audit.probe();
    subsystems.push({ name: "audit", status: auditOk ? "healthy" : "blocked", detail: auditOk ? "ledger readable" : "unreadable", latency_ms: null });

    subsystems.push({
      name: "agents",
      status: this.services.registry.count() > 0 ? "healthy" : "degraded",
      detail: `${this.services.registry.count()} agent(s) registered`,
      latency_ms: null,
    });

    subsystems.push({
      name: "config",
      status: configBlocked() ? "blocked" : CONFIG.issues.length > 0 ? "degraded" : "healthy",
      detail: CONFIG.issues.length > 0 ? CONFIG.issues[0] : `${CONFIG.env} validated`,
      latency_ms: null,
    });

    // GitHub is an optional integration — unconnected is a valid, honest state.
    const gh = this.services.github.state();
    const rate = gh.rate;
    subsystems.push({
      name: "github",
      status: gh.connected ? "healthy" : "degraded",
      detail: gh.connected
        ? `connected as @${gh.identity?.login}${rate ? ` · rate ${rate.remaining}/${rate.limit}` : ""}`
        : "not connected — optional integration (token held in memory only)",
      latency_ms: null,
    });

    const overall = subsystems.some((s) => s.status === "blocked") ? "blocked" : subsystems.some((s) => s.status === "degraded") ? "degraded" : "healthy";
    return { status: overall, subsystems, version: CONFIG.version, engine: this.services.engine.kind, timestamp: Date.now() };
  }

  configView(): Record<string, unknown> {
    return safeConfigView();
  }
}

/* ------------------------- auth convenience (Phase 1) ---------------------- */

export interface AuthApi {
  bootstrapFirstUser(email: string, name: string, password: string): Promise<{ user: PublicUser; session: Session }>;
  login(email: string, password: string): Promise<{ user: PublicUser; session: Session }>;
  logout(token: string): Promise<void>;
  validate(token: string | null): Promise<{ user: PublicUser; session: Session }>;
  hasUsers(): Promise<boolean>;
}

export function createAuthApi(services: KernelServices): AuthApi {
  const findUserByEmail = async (email: string): Promise<User | undefined> => {
    const users = await services.engine.all<User>("users");
    return users.find((u) => u.email === email.toLowerCase());
  };

  return {
    async hasUsers() {
      return (await services.engine.all<User>("users")).length > 0;
    },

    async bootstrapFirstUser(email, name, password) {
      if (await this.hasUsers()) {
        throw Err.conflict("ALREADY_INITIALIZED", "platform identity already initialized");
      }
      const user = await createUserRecord({ email, name, password, role: "OWNER" });
      await services.engine.put("users", user.id, user);
      await services.audit.record({
        actor: user.email,
        action: "platform.bootstrap",
        resource_type: "user",
        resource_id: user.id,
        result: "allow",
        metadata: { role: "OWNER" }, // no credential material
      });
      const session = await services.sessions.issue(user.id);
      await services.audit.record({ actor: user.email, action: "auth.login", resource_type: "session", resource_id: session.token.slice(0, 8) + "…", result: "allow" });
      return { user: toPublicUser(user), session };
    },

    async login(email, password) {
      const user = await findUserByEmail(email);
      if (!user || !(await verifyPassword(user, password))) {
        await services.audit.record({
          actor: email.toLowerCase(),
          action: "auth.login_failed",
          resource_type: "session",
          resource_id: "-",
          result: "deny",
        });
        throw Err.auth("INVALID_CREDENTIALS", "invalid email or password");
      }
      if (user.status !== "active") {
        // Status-aware rejection: suspended and disabled are distinct states.
        await services.audit.record({
          actor: user.email,
          action: "auth.login_failed",
          resource_type: "session",
          resource_id: "-",
          result: "deny",
          metadata: { reason: `account is ${user.status}` },
        });
        throw Err.auth(
          user.status === "disabled" ? "ACCOUNT_DISABLED" : "ACCOUNT_SUSPENDED",
          `account is ${user.status} — authentication refused`,
        );
      }
      const session = await services.sessions.issue(user.id);
      await services.audit.record({ actor: user.email, action: "auth.login", resource_type: "session", resource_id: session.token.slice(0, 8) + "…", result: "allow" });
      return { user: toPublicUser(user), session };
    },

    async logout(token) {
      const session = await services.engine.get<Session>("sessions", token);
      await services.sessions.revoke(token);
      if (session) {
        const user = await services.engine.get<User>("users", session.user_id);
        await services.audit.record({ actor: user?.email ?? "unknown", action: "auth.logout", resource_type: "session", resource_id: token.slice(0, 8) + "…", result: "info" });
      }
    },

    async validate(token) {
      const session = await services.sessions.validate(token);
      const user = await services.engine.get<User>("users", session.user_id);
      if (!user) throw Err.auth("INVALID_SESSION", "session user no longer exists");
      if (user.status !== "active") {
        throw Err.auth(
          user.status === "disabled" ? "ACCOUNT_DISABLED" : "ACCOUNT_SUSPENDED",
          `account is ${user.status} — authentication refused`,
        );
      }
      return { user: toPublicUser(user), session };
    },
  };
}
