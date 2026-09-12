/**
 * NEXUS Phase 1 Ã¢â‚¬â€ NexusKernel.
 *
 * The platform foundation: initializes persistence, events, audit, agents,
 * services and orchestration in a strict order, tracks boot steps for the
 * UI, and fails loudly (never partially-silently) when a subsystem cannot
 * start. Contains no business logic Ã¢â‚¬â€ that lives in services and agents.
 */

import { AuditService } from "./audit";
import { AgentRegistry, InspectorAgent } from "./agents";
import { CONFIG, configBlocked, safeConfigView } from "./config";
import { openEngine, probeEngine, nid, type NexusEngine } from "./db";
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
import { ExecutionStore } from "./execution-store";
import { DispatchService } from "./dispatch-service";
import { ExecutionEngine, type ExecutionDeps } from "./execution-engine";
import { WorkerRegistry } from "./worker-registry";
import { LeaseManager } from "./lease-manager";
import { RetryEngine } from "./retry-engine";
import { JobDispatcher } from "./job-dispatcher";
import { RemoteWorkerStore } from "./remote-worker-store";
import { RemoteWorkerRegistry } from "./remote-worker-registry";
import { WorkerAuthentication } from "./worker-authentication";
import type { WorkerGateway } from "./worker-gateway";
import type { RemoteExecutionAdapter } from "./remote-execution-adapter";
import { SqliteWorkerAuthStore } from "./sqlite-worker-auth-store";
import { ExecutionAdapterRegistry } from "./execution-adapter-registry";
import { RemoteExecutionManager } from "./remote-execution-manager";
import { SkippedEnvironmentRemoteAdapter } from "./skipped-environment-adapter";
import { SkippedEnvironmentExecutionAdapter } from "./skipped-environment-execution-adapter";
import type { ExecutionAdapterRequest } from "./execution-adapter";
import { AgentPolicyEngine, ExecutionPolicyEngine, AgentExecutionService } from "./execution-policy";
import { ProjectDetector } from "./devops";
import {
  PipelineAgent,
  PipelineValidator,
  GitHubActionsGenerator,
  GitLabCIGenerator,
  GitHubProvider,
  GitLabProvider,
  CiPipelineEngine,
} from "./cicd";
import { BrowserSandbox, FileAccessPolicy, WorkspaceService, DEFAULT_WORKSPACE_LIMITS } from "./workspace";
import { RuntimeBridge, getHostBridge, TokenBoundExecutor, DockerAdapter, PlaywrightAdapter, SmokeTestService } from "./runtime";
import { DeploymentHistoryService } from "./deployment-history";
import { CanonicalDeploymentOrchestrator } from "./deployment-orchestrator";
import { SecurityApi } from "./security-api";
import { SecurityReleaseGate } from "./security-release-gate";
import { ProductionReleaseDecisionService } from "./production-release-decision";
import { ProductionReleaseEnforcementService } from "./production-release-enforcement";
import { ReleaseDeploymentBridge } from "./deployment-release-bridge";
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
  // Phase 2 Pass 1 Ã¢â‚¬â€ centralized authorization + identity lifecycle.
  authz: AuthorizationService;
  identity: IdentityService;
  // Phase 2 Pass 2 Ã¢â‚¬â€ secure agent execution & execution policy.
  agentPolicy: AgentPolicyEngine;
  execPolicy: ExecutionPolicyEngine;
  agentExec: AgentExecutionService;
  // Phase 2 Pass 3 Ã¢â‚¬â€ workspace isolation & sandbox.
  workspaces: WorkspaceService;
  sandbox: ExecutionSandbox;
  // Phase 3 Pass 3 Ã¢â‚¬â€ CI/CD pipeline + Git provider foundation.
  cicd: {
    agent: PipelineAgent;
    validator: PipelineValidator;
    github: GitHubProvider;
    gitlab: GitLabProvider;
    engine: CiPipelineEngine;
  };
  // Phase 3 Pass 5 Ã¢â‚¬â€ runtime bridge (process execution + Docker/Trivy/Playwright).
  runtime: RuntimeBridge;
  // Canonical deployment orchestration: real Docker container + real
  // health/smoke verification + rollback against previous KNOWN_GOOD.
  deployments: CanonicalDeploymentOrchestrator;
  // Phase 102: production release control plane wired to canonical deployment.
  // Consumes ProductionReleaseEnforcementService with a ReleaseDeploymentBridge
  // provider; enforcement BLOCKED/FAIL prevents Docker run.
  releaseEnforcement: ProductionReleaseEnforcementService;
}

const BOOT_ORDER = [
  ["config", "validate configuration"],
  ["persistence", "open persistence engine"],
  ["events", "start event system"],
  ["audit", "attach audit trail"],
  ["secrets", "initialize secret provider"],
  ["agents", "register agent framework"],
  ["orchestration", "assemble orchestration"],
  ["runtime", "detect execution runtime"],
] as const;

export class NexusKernel {
  readonly steps: BootStep[] = BOOT_ORDER.map(([id, label]) => ({ id, label, status: "pending", detail: null }));
  services!: KernelServices;
  status: "booting" | "ready" | "failed" = "booting";
  failure: NexusError | null = null;
  executionEngine?: ExecutionEngine;
  jobDispatcher?: JobDispatcher;
  remoteWorkerRegistry?: RemoteWorkerRegistry;
  remoteExecutionManager?: RemoteExecutionManager;
  executionAdapterRegistry?: ExecutionAdapterRegistry;
  // Server-side Worker Gateway. Populated in boot() only when running under
  // Vite SSR (import.meta.env.SSR). Ordinary browser boot leaves this undefined.
  workerGateway?: WorkerGateway;
  // The exact same durable stores the runtime uses. Exposed for callers/tests.
  executionStore?: ExecutionStore;
  remoteWorkerStore?: RemoteWorkerStore;
  workerAuthStore?: SqliteWorkerAuthStore;
  private gatewayStarted = false;

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
      this.step("config", "ok", `${CONFIG.env} Ã‚Â· v${CONFIG.version}`);

      // 2. persistence
      this.step("persistence", "running");
      const engine = await openEngine();
      const latency = await probeEngine(engine).catch(() => null);
      if (latency === null) {
        this.step("persistence", "fail", "probe failed");
        throw Err.startup("PERSISTENCE_FAILED", "persistence engine failed its round-trip probe");
      }
      this.step("persistence", "ok", `${engine.kind} Ã‚Â· ${latency}ms`);

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
      // Wire execution stack (production)
      if (engine.kind === "sqlite") {
        const rawDb = (engine as any).getDatabase();
        if (rawDb) {
                    const executionStore = new ExecutionStore(rawDb);
          const workerRegistry = new WorkerRegistry(executionStore);
          const leaseManager = new LeaseManager(executionStore);
          const retryEngine = new RetryEngine();

          const remoteWorkerStore = new RemoteWorkerStore(rawDb);
          const authStore = new SqliteWorkerAuthStore(rawDb);
          const workerAuthentication = new WorkerAuthentication(authStore);
          const remoteWorkerRegistry = new RemoteWorkerRegistry(remoteWorkerStore, workerAuthentication);

          const adapterRegistry = new ExecutionAdapterRegistry();
          adapterRegistry.register(new SkippedEnvironmentExecutionAdapter());

          // Server-only Worker Gateway. worker-gateway.ts imports Node's
          // "http" module and must not appear in the browser bundle. The
          // import.meta.env.SSR guard lets Vite tree-shake this entire branch
          // out of browser builds; dynamic imports keep the module lazy so the
          // browser never resolves it.
          let workerGateway: WorkerGateway | undefined;
          let remoteAdapter: RemoteExecutionAdapter;
          if (typeof process !== "undefined" && !!process.versions?.node) {
            const gatewaySpec = "./worker-gateway";
            const adapterSpec = "./worker-gateway-remote-adapter";
            const sessionStoreSpec = "./worker-session-store";
            const { WorkerGateway: GatewayCtor } = await import(/* @vite-ignore */ gatewaySpec);
            const { WorkerGatewayRemoteExecutionAdapter: AdapterCtor } = await import(/* @vite-ignore */ adapterSpec);
            const { WorkerSessionStore } = await import(/* @vite-ignore */ sessionStoreSpec);
            const sessionStore = new WorkerSessionStore(engine);
            const gw = new GatewayCtor(CONFIG.gateway.port, sessionStore, remoteWorkerStore, workerAuthentication, executionStore);
            workerGateway = gw;
            remoteAdapter = new AdapterCtor(gw);
          } else {
            // Non-SSR: kernel cannot run worker gateway. This branch is only
            // reached under runtimes where db.ts already refused to open
            // SQLite; fail closed rather than fake remote execution.
            throw Err.startup("GATEWAY_UNAVAILABLE", "WorkerGateway requires Vite SSR runtime");
          }
          const remoteExecutionManager = new RemoteExecutionManager(remoteAdapter, executionStore);
          const jobDispatcher = new JobDispatcher(workerRegistry, remoteExecutionManager, executionStore, leaseManager);
          const dispatchService = new DispatchService(jobDispatcher, remoteExecutionManager, executionStore);

          const executionDeps: ExecutionDeps = {
            dispatchPort: dispatchService,
          };
          const executionEngine = new ExecutionEngine(executionStore, workerRegistry, leaseManager, retryEngine, executionDeps);

          this.executionEngine = executionEngine;
          this.jobDispatcher = jobDispatcher;
          this.remoteWorkerRegistry = remoteWorkerRegistry;
          this.remoteExecutionManager = remoteExecutionManager;
          this.executionAdapterRegistry = adapterRegistry;
          this.workerGateway = workerGateway;
          this.executionStore = executionStore;
          this.remoteWorkerStore = remoteWorkerStore;
          this.workerAuthStore = authStore;

        }
      }
      this.step("orchestration", "ok", "deterministic path assembled");

      // Phase 2 Pass 1 Ã¢â‚¬â€ centralized authorization + identity lifecycle.
      const authz = new AuthorizationService(audit);
      const identity = new IdentityService(engine, authz, audit);

      // Phase 2 Pass 2 Ã¢â‚¬â€ secure agent execution & execution policy.
      const agentPolicy = new AgentPolicyEngine();
      const execPolicy = new ExecutionPolicyEngine(registry, authz, agentPolicy);
      const agentExec = new AgentExecutionService({ engine, registry, authz, agentPolicy, execPolicy, audit, events });

      // Phase 2 Pass 3 Ã¢â‚¬â€ workspace isolation & sandbox (logical boundary;
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

      // Phase 3 Pass 3 Ã¢â‚¬â€ CI/CD pipeline + Git provider foundation. The GitHub
      // provider wraps the same GitHubService instance (connection on demand);
      // remote operations stay honestly BLOCKED until a token is connected.
      const github = new GitHubService();
      const cicdValidator = new PipelineValidator();
      const cicdAgent = new PipelineAgent({
        detector: new ProjectDetector(),
        github: new GitHubActionsGenerator(),
        gitlab: new GitLabCIGenerator(),
        validator: cicdValidator,
        events,
        audit,
        evidence,
        artifacts,
      });
      const cicdEngine = new CiPipelineEngine({ engine, events, audit, evidence, artifacts, authz });
      const cicd = {
        agent: cicdAgent,
        validator: cicdValidator,
        github: new GitHubProvider(github),
        gitlab: new GitLabProvider(),
        engine: cicdEngine,
      };

      // Phase 3 Pass 5 Ã¢â‚¬â€ runtime bridge. Detects process-execution capability
      // honestly: BLOCKED in the managed browser workspace, AVAILABLE only after
      // real probes when a host bridge is injected. Emits events + audit.
      this.step("runtime", "running");
      const runtime = new RuntimeBridge({ events, audit });
      await runtime.detect().catch(() => undefined);
      this.step("runtime", "ok", `${runtime.kind()} Ã‚Â· docker=${runtime.status()?.docker ?? "n/a"} trivy=${runtime.status()?.trivy ?? "n/a"}`);

      // Canonical deployment orchestration — uses the same RuntimeBridge
      // (docker + smoke) and the same NexusEngine (via DeploymentHistoryService).
      const deploymentHistory = new DeploymentHistoryService(engine);
      const deployments = new CanonicalDeploymentOrchestrator(
        deploymentHistory,
        runtime.docker,
        runtime.smoke,
        { events, audit },
        // Runtime binder: materializes a workspace token and wraps a
        // fresh DockerAdapter + SmokeTestService around it. The shared
        // RuntimeBridge.executor is never mutated.
        async () => {
          const bridge = getHostBridge();
          if (!bridge || typeof bridge.materializeWorkspace !== "function" || typeof bridge.cleanupWorkspace !== "function") {
            throw new Error("host bridge does not implement workspace materialization");
          }
          let token = nid("dep").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128);
          if (token.length < 4) token = (token + "deploy").slice(0, 128);
          await bridge.materializeWorkspace({
            token,
            files: [{ path: ".nexus-deployment-probe", content: "NEXUS deployment workspace" }],
          });
          const boundExec = new TokenBoundExecutor(runtime.executor, token);
          const boundDocker = new DockerAdapter(boundExec);
          const boundPlaywright = new PlaywrightAdapter(boundExec);
          const boundSmoke = new SmokeTestService(boundExec, boundPlaywright, { events, audit });
          return {
            docker: boundDocker,
            smoke: boundSmoke,
            cleanup: async () => {
              try { await bridge.cleanupWorkspace!(token); } catch { /* honest no-op */ }
            },
          };
        },
      );

      // Phase 102: production release control plane wired to canonical
      // deployment. releaseEnforcement.requestRelease() runs the existing
      // ProductionReleaseDecisionService (security gate + approval + digest
      // match). executeRelease() dispatches through ReleaseDeploymentBridge,
      // which verifies artifact binding, rejects :latest, and only then calls
      // CanonicalDeploymentOrchestrator.deploy().
      const securityApi = new SecurityApi(engine);
      const securityGate = new SecurityReleaseGate(securityApi);
      const releaseDecision = new ProductionReleaseDecisionService(securityApi, securityGate);
      const releaseBridge = new ReleaseDeploymentBridge({
        deployments,
        artifacts,
        svc: { events, audit },
      });
      const releaseEnforcement = new ProductionReleaseEnforcementService(
        securityApi,
        securityGate,
        releaseDecision,
        releaseBridge,
      );
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
        github,
        cicd,
        runtime,
        deployments,
        releaseEnforcement,
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

  /**
   * Start the Worker Gateway HTTP listener.
   *
   * Deliberately NOT called by boot(). Ordinary browser/test boot must never
   * open a TCP port. Server-mode callers set CONFIG.gateway.enabled = true
   * and then call this method explicitly. Repeated calls are safe no-ops.
   */
  async startGateway(): Promise<void> {
    if (!CONFIG.gateway.enabled) return;
    if (!this.workerGateway) {
      throw Err.startup("GATEWAY_NOT_WIRED", "kernel did not construct a WorkerGateway (requires Vite SSR runtime and sqlite persistence)");
    }
    if (this.gatewayStarted) return;
    await this.workerGateway.start();
    this.gatewayStarted = true;
  }

  /** Stop the Worker Gateway if it was started. Idempotent. */
  async stopGateway(): Promise<void> {
    if (!this.gatewayStarted || !this.workerGateway) return;
    await this.workerGateway.stop();
    this.gatewayStarted = false;
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

    // GitHub is an optional integration Ã¢â‚¬â€ unconnected is a valid, honest state.
    const gh = this.services.github.state();
    const rate = gh.rate;
    subsystems.push({
      name: "github",
      status: gh.connected ? "healthy" : "degraded",
      detail: gh.connected
        ? `connected as @${gh.identity?.login}${rate ? ` Ã‚Â· rate ${rate.remaining}/${rate.limit}` : ""}`
        : "not connected Ã¢â‚¬â€ optional integration (token held in memory only)",
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
      await services.audit.record({ actor: user.email, action: "auth.login", resource_type: "session", resource_id: session.token.slice(0, 8) + "Ã¢â‚¬Â¦", result: "allow" });
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
          `account is ${user.status} Ã¢â‚¬â€ authentication refused`,
        );
      }
      const session = await services.sessions.issue(user.id);
      await services.audit.record({ actor: user.email, action: "auth.login", resource_type: "session", resource_id: session.token.slice(0, 8) + "Ã¢â‚¬Â¦", result: "allow" });
      return { user: toPublicUser(user), session };
    },

    async logout(token) {
      const session = await services.engine.get<Session>("sessions", token);
      await services.sessions.revoke(token);
      if (session) {
        const user = await services.engine.get<User>("users", session.user_id);
        await services.audit.record({ actor: user?.email ?? "unknown", action: "auth.logout", resource_type: "session", resource_id: token.slice(0, 8) + "Ã¢â‚¬Â¦", result: "info" });
      }
    },

    async validate(token) {
      const session = await services.sessions.validate(token);
      const user = await services.engine.get<User>("users", session.user_id);
      if (!user) throw Err.auth("INVALID_SESSION", "session user no longer exists");
      if (user.status !== "active") {
        throw Err.auth(
          user.status === "disabled" ? "ACCOUNT_DISABLED" : "ACCOUNT_SUSPENDED",
          `account is ${user.status} Ã¢â‚¬â€ authentication refused`,
        );
      }
      return { user: toPublicUser(user), session };
    },
  };
}
