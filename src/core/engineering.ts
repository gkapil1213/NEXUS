/**
 * NEXUS — AI Engineering Workspace orchestration layer.
 *
 * This module is an ORCHESTRATION LAYER only. It composes the existing
 * Phase 1/2/3 services and never reimplements them:
 *
 *   intent parsing      → deterministic, rule-based (no fake "AI")
 *   plan model/preview  → real ProjectDetector + build-plan validation + capability probes
 *   authorization       → existing AuthorizationService (via orchestrator + workspace)
 *   agent orchestration → existing NexusOrchestrator
 *   workspace/sandbox   → existing WorkspaceService (isolated, TTL, path policy)
 *   build/devops        → existing PipelineEngine + SecurityScanner + SBOMService
 *   events / audit      → existing EventService / AuditService
 *   artifacts/evidence  → existing ArtifactService / EvidenceService
 *
 * RUNTIME TRUTH: build/test execution needs a command runtime that the browser
 * sandbox does not provide. Those stages are reported BLOCKED with the real
 * reason — they are NEVER reported PASSED. Detection, static security review
 * and source SBOM genuinely execute in-browser against real workspace files.
 */

import type { KernelServices } from "./kernel";
import { ProjectDetector, SecurityScanner, SBOMService, buildPlanFrom, validateBuildPlan, PipelineEngine } from "./devops";
import type { WsReader, PipelineContext, PipelineServices, StageRunner, StageOutput } from "./devops";
import { detectCapabilities, executableHere } from "./capabilities";
import type { CapabilityReport } from "./capabilities";
import { nid } from "./db";
import { toSystemError } from "./errors";
import type {
  Project,
  Execution,
  DetectionResult,
  BuildPlan,
  PipelineRun,
  PipelineStage,
  PipelineStageName,
  SbomComponent,
} from "./types";
import type { Actor } from "./services";
import type { BuildPlanValidation } from "./devops";

/* ============================== Intent model =============================== */

export interface EngineeringSignal {
  id: string;
  label: string;
  matched: string[]; // the actual words from the request that triggered it
}

export interface EngineeringIntent {
  raw: string;
  subject: string;
  signals: EngineeringSignal[];
  scope: "small" | "medium" | "large";
  words: number;
}

const SIGNAL_DEFS: { id: string; label: string; keys: string[] }[] = [
  { id: "auth", label: "Authentication / RBAC", keys: ["auth", "login", "sign in", "signin", "signup", "register", "session", "jwt", "oauth", "password", "rbac", "permission", "role", "identity"] },
  { id: "data", label: "Persistence / Database", keys: ["database", "db", "sql", "postgres", "mysql", "mongo", "store", "persist", "schema", "table", "record"] },
  { id: "api", label: "API / Backend", keys: ["api", "endpoint", "rest", "graphql", "server", "backend", "service", "route", "webhook"] },
  { id: "ui", label: "UI / Frontend", keys: ["ui", "frontend", "dashboard", "web", "interface", "component", "page", "screen", "form", "chart"] },
  { id: "realtime", label: "Realtime / Events", keys: ["realtime", "real-time", "websocket", "live", "push", "stream", "notification"] },
  { id: "payments", label: "Payments / Billing", keys: ["payment", "billing", "stripe", "checkout", "invoice", "subscription"] },
  { id: "testing", label: "Testing", keys: ["test", "testing", "spec", "coverage", "e2e", "unit"] },
  { id: "deploy", label: "Deploy / Containers / CI", keys: ["deploy", "docker", "container", "ci", "cd", "pipeline", "kubernetes", "k8s", "staging", "release"] },
  { id: "security", label: "Security / Scanning", keys: ["security", "secure", "encrypt", "vulnerab", "scan", "sbom", "audit", "secret"] },
];

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "with", "that", "this", "to", "of", "in", "on", "is", "are",
  "build", "make", "create", "me", "i", "want", "need", "please", "app", "application", "system", "platform",
]);

/** Deterministic intent parser. Rule-based extraction — no fabricated AI. */
export function parseIntent(raw: string): EngineeringIntent {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const words = lower.split(/[^a-z0-9+#./-]+/).filter(Boolean);

  const signals: EngineeringSignal[] = [];
  for (const def of SIGNAL_DEFS) {
    const matched = def.keys.filter((k) => lower.includes(k));
    if (matched.length) signals.push({ id: def.id, label: def.label, matched });
  }

  // Subject: first meaningful tokens, stop-words removed, capped for readability.
  const subjectWords = words.filter((w) => !STOPWORDS.has(w)).slice(0, 6);
  const subject = subjectWords.length ? subjectWords.join(" ") : "untitled build";

  const scope: EngineeringIntent["scope"] = signals.length >= 5 ? "large" : signals.length >= 3 ? "medium" : "small";

  return { raw: text, subject, signals, scope, words: words.length };
}

/* =============================== Plan model ================================ */

export type StageAvailability = "ready" | "blocked";

export interface EngineeringPlanStage {
  id: PipelineStageName;
  label: string;
  description: string;
  service: string; // the existing NEXUS service that executes it
  availability: StageAvailability;
  blockedReason: string | null;
}

export interface EngineeringPlan {
  id: string;
  intent: EngineeringIntent;
  project: { id: string; name: string };
  workspaceId: string;
  detection: DetectionResult;
  buildPlan: BuildPlan;
  buildValidation: BuildPlanValidation;
  capabilities: CapabilityReport;
  stages: EngineeringPlanStage[];
  readyCount: number;
  blockedCount: number;
  createdAt: number;
}

/** A WsReader bound to a live, ACTIVE workspace via the existing WorkspaceService. */
function workspaceReader(svc: KernelServices, actor: Actor, wsId: string): WsReader {
  return {
    async read(path) {
      try {
        const rec = await svc.workspaces.readFile(actor, wsId, path);
        return rec.content;
      } catch {
        return null;
      }
    },
    async list() {
      try {
        const files = await svc.workspaces.listFiles(actor, wsId);
        return files.map((f) => f.path);
      } catch {
        return [];
      }
    },
  };
}

/** Real starting scaffold written into the isolated workspace. Content is
 *  derived from the parsed intent — this is actual code the pipeline then
 *  detects, scans and bills of-materials. Nothing here is a fake result. */
function scaffoldProject(intent: EngineeringIntent): [string, string][] {
  const name = intent.subject.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "") || "nexus-build";
  const has = (id: string) => intent.signals.some((s) => s.id === id);

  const deps: Record<string, string> = {};
  if (has("api")) deps["express"] = "^4.19.2";
  if (has("ui")) deps["react"] = "^18.2.0";
  if (has("auth")) deps["jsonwebtoken"] = "^9.0.2";
  if (has("data")) deps["pg"] = "^8.11.5";
  if (has("realtime")) deps["ws"] = "^8.17.0";

  const files: [string, string][] = [];

  files.push([
    "package.json",
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        scripts: { build: "tsc -p tsconfig.json", test: "node --test src", start: "node dist/index.js" },
        dependencies: deps,
        devDependencies: { typescript: "^5.4.5" },
      },
      null,
      2,
    ),
  ]);

  files.push([
    "tsconfig.json",
    JSON.stringify(
      { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", strict: true }, include: ["src"] },
      null,
      2,
    ),
  ]);

  const entry: string[] = [`// ${intent.subject}`, `// signals: ${intent.signals.map((s) => s.id).join(", ") || "none"}`];
  if (has("api")) entry.push(`export function createServer() { return { listen: (port: number) => \`listening on \${port}\` }; }`);
  if (has("auth")) entry.push(`export function verifyToken(token: string): boolean { return token.length > 0; }`);
  if (has("data")) entry.push(`export function connectDatabase(url: string): { url: string } { return { url }; }`);
  if (!entry.some((l) => l.startsWith("export"))) entry.push(`export const build = "${name}";`);
  files.push(["src/index.ts", entry.join("\n") + "\n"]);

  files.push([
    "src/index.test.ts",
    [`import { test } from "node:test";`, `import assert from "node:assert";`, ``, `test("scaffold loads", () => { assert.ok(true); });`, ``].join("\n"),
  ]);

  return files;
}

function buildStages(
  detection: DetectionResult,
  validation: BuildPlanValidation,
  exec: ReturnType<typeof executableHere>,
  intent: EngineeringIntent,
  hasExecutor: boolean,
): EngineeringPlanStage[] {
  const wantsDeploy = intent.signals.some((s) => s.id === "deploy");
  const hasDeps = (detection.package_manager !== null) || detection.evidence.includes("package.json") || detection.evidence.includes("requirements.txt");

  const stages: EngineeringPlanStage[] = [
    {
      id: "DETECTING",
      label: "Detect project",
      description: "Infer language, runtime, package manager, build/test commands and Dockerfiles from real workspace files.",
      service: "ProjectDetector (devops)",
      availability: "ready",
      blockedReason: null,
    },
    {
      id: "BUILDING",
      label: "Build",
      description: "Run the allow-listed build command against the workspace.",
      service: "PipelineEngine · CommandExecutor",
      availability: hasExecutor && validation.ok ? "ready" : "blocked",
      blockedReason: !hasExecutor
        ? "No command runtime in this browser sandbox — build execution requires a host shell or CI runner."
        : !validation.ok
          ? `Build plan rejected: ${validation.rejected.join("; ")}`
          : null,
    },
    {
      id: "TESTING",
      label: "Test",
      description: "Run the detected test command and capture pass/fail counts.",
      service: "PipelineEngine · CommandExecutor",
      availability: hasExecutor && validation.ok ? "ready" : "blocked",
      blockedReason: !hasExecutor
        ? "No command runtime in this browser sandbox — test execution requires a host shell or CI runner."
        : !validation.ok
          ? "Build plan rejected; tests cannot be scheduled."
          : null,
    },
    {
      id: "SECURITY_REVIEW",
      label: "Security review",
      description: "Static scan for hardcoded secrets and unsafe configuration across the workspace.",
      service: "SecurityScanner (devops)",
      availability: "ready",
      blockedReason: null,
    },
    {
      id: "SBOM_GENERATION",
      label: "Source SBOM",
      description: "Generate a CycloneDX bill of materials from real dependency manifests.",
      service: "SBOMService (devops)",
      availability: hasDeps ? "ready" : "blocked",
      blockedReason: hasDeps ? null : "No dependency manifest (package.json / requirements.txt) detected — nothing to enumerate.",
    },
    {
      id: "ARTIFACT_REGISTRATION",
      label: "Register artifacts",
      description: "Record produced artifacts with real sha256 digests for integrity.",
      service: "ArtifactService + ArtifactIntegrityService",
      availability: "ready",
      blockedReason: null,
    },
  ];

  if (wantsDeploy) {
    stages.push(
      {
        id: "DOCKER_BUILD",
        label: "Docker build",
        description: "Build an immutable container image from the detected/generated Dockerfile.",
        service: "DockerRuntimeAdapter (Phase 3 runtime)",
        availability: exec.docker ? "ready" : "blocked",
        blockedReason: exec.docker ? null : "Docker daemon is unavailable in this runtime — container build is BLOCKED, never simulated.",
      },
      {
        id: "IMAGE_INSPECTION",
        label: "Image inspection",
        description: "Inspect the built image (digest, arch, entrypoint, layers).",
        service: "DockerRuntimeAdapter (Phase 3 runtime)",
        availability: exec.docker ? "ready" : "blocked",
        blockedReason: exec.docker ? null : "Requires a real built image; Docker is unavailable.",
      },
      {
        id: "IMAGE_SECURITY_SCAN",
        label: "Container scan",
        description: "Scan the image for vulnerabilities (Trivy / Grype / OSV).",
        service: "Container scanner adapters (Phase 3 runtime)",
        availability: exec.docker ? "ready" : "blocked",
        blockedReason: exec.docker ? null : "No container scanner runtime available — scan is BLOCKED, never faked.",
      },
    );
  }

  return stages;
}

/**
 * Generate a real engineering plan: provisions an isolated workspace, writes a
 * real scaffold, then runs genuine detection + build-plan validation +
 * capability probing. Every stage's availability is honest.
 */
export async function generatePlan(
  svc: KernelServices,
  actor: Actor,
  project: Project,
  intent: EngineeringIntent,
  opts: { scaffold: boolean },
): Promise<EngineeringPlan> {
  const planId = nid("plan");

  // Isolated workspace via the existing WorkspaceService (authorized, TTL'd).
  const ws = await svc.workspaces.create(actor, { project_id: project.id, execution_id: planId });
  const active = await svc.workspaces.activate(actor, ws.id);

  if (opts.scaffold) {
    for (const [path, content] of scaffoldProject(intent)) {
      await svc.workspaces.writeFile(actor, active.id, path, content);
    }
  }

  const reader = workspaceReader(svc, actor, active.id);
  const detection = await new ProjectDetector().detect(reader);
  const buildPlan = buildPlanFrom(detection);
  const buildValidation = validateBuildPlan(buildPlan);
  const capabilities = await detectCapabilities();
  const exec = executableHere(capabilities);
  const hasExecutor = capabilities.probes.find((p) => p.name === "Node.js (spawnable)")?.status === "AVAILABLE";

  const stages = buildStages(detection, buildValidation, exec, intent, hasExecutor);
  const readyCount = stages.filter((s) => s.availability === "ready").length;

  return {
    id: planId,
    intent,
    project: { id: project.id, name: project.name },
    workspaceId: active.id,
    detection,
    buildPlan,
    buildValidation,
    capabilities,
    stages,
    readyCount,
    blockedCount: stages.length - readyCount,
    createdAt: Date.now(),
  };
}

/* ============================== Execution ================================== */

export type EngStageOutcome = "PASSED" | "FAILED" | "BLOCKED" | "SKIPPED";

export interface EngStageResult {
  stageId: PipelineStageName;
  label: string;
  outcome: EngStageOutcome;
  detail: string | null;
  blockedReason: string | null;
  durationMs: number | null;
  artifacts: number;
}

export type EngVerdict = "PASSED" | "FAILED" | "BLOCKED";

export interface EngRunResult {
  execution: Execution;
  agentSummary: string | null;
  runId: string;
  stages: EngStageResult[];
  verdict: EngVerdict;
  passed: number;
  failed: number;
  blocked: number;
  recovery: string[];
  artifacts: number;
}

function toPipelineServices(svc: KernelServices): PipelineServices {
  return { engine: svc.engine, events: svc.events, audit: svc.audit, evidence: svc.evidence, artifacts: svc.artifacts, authz: svc.authz };
}

/** Map a pipeline stage record to an honest EngStageResult. */
function mapStage(rec: PipelineStage, label: string): EngStageResult {
  const outcome: EngStageOutcome =
    rec.status === "SUCCEEDED" ? "PASSED" : rec.status === "FAILED" ? "FAILED" : rec.status === "BLOCKED" ? "BLOCKED" : "SKIPPED";
  return {
    stageId: rec.stage,
    label,
    outcome,
    detail: rec.error?.message ?? null,
    blockedReason: rec.blocked_reason,
    durationMs: rec.duration_ms,
    artifacts: 0,
  };
}

function cyclonedx(components: SbomComponent[], projectName: string): string {
  return JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: { timestamp: new Date().toISOString(), component: { type: "application", name: projectName } },
      components: components.map((c) => ({
        type: "library",
        "bom-ref": `pkg:${c.ecosystem}/${c.name}@${c.version}`,
        name: c.name,
        version: c.version,
        purl: `pkg:${c.ecosystem}/${c.name}@${c.version}`,
        scope: c.dev ? "optional" : "required",
      })),
    },
    null,
    2,
  );
}

/** Build the stage runners from existing devops services (no reimplementation). */
function stageRunners(reader: WsReader, detection: DetectionResult, projectName: string): Partial<Record<PipelineStageName, StageRunner>> {
  const detector = new ProjectDetector();
  const scanner = new SecurityScanner();
  const sbom = new SBOMService();

  return {
    DETECTING: async (): Promise<StageOutput> => {
      const det = await detector.detect(reader);
      return {
        status: "SUCCEEDED",
        command: null,
        logs: `detected language=${det.language} runtime=${det.runtime ?? "—"} pm=${det.package_manager ?? "—"} files=[${det.evidence.join(", ")}]`,
        evidence: [{ type: "report", content: JSON.stringify(det, null, 2), metadata: { stage: "DETECTING" } }],
      };
    },
    BUILDING: async (): Promise<StageOutput> => {
      // No command runtime in the browser sandbox → honest BLOCKED.
      return {
        status: "BLOCKED",
        blocked_reason: "command execution unavailable in this browser runtime (no shell/Node spawn); build requires a host runtime or CI runner",
        logs: "BUILDING skipped: executor not available in this environment.",
      };
    },
    TESTING: async (): Promise<StageOutput> => {
      return {
        status: "BLOCKED",
        blocked_reason: "command execution unavailable in this browser runtime (no shell/Node spawn); tests require a host runtime or CI runner",
        logs: "TESTING skipped: executor not available in this environment.",
      };
    },
    SECURITY_REVIEW: async (): Promise<StageOutput> => {
      const res = await scanner.staticScan(reader);
      return {
        status: res.status === "PASSED" ? "SUCCEEDED" : res.status === "FAILED" ? "FAILED" : "BLOCKED",
        blocked_reason: res.blocked_reason,
        logs: res.status === "PASSED" ? "static security scan: no secrets or unsafe config found" : `findings:\n${res.findings.join("\n")}`,
        evidence: [{ type: "report", content: JSON.stringify(res, null, 2), metadata: { stage: "SECURITY_REVIEW" } }],
      };
    },
    SBOM_GENERATION: async (): Promise<StageOutput> => {
      const res = await sbom.generateSourceSbom(reader, detection, projectName);
      if (res.status === "BLOCKED") {
        return { status: "BLOCKED", blocked_reason: res.blocked_reason, logs: "SBOM generation blocked: " + (res.blocked_reason ?? "no manifests") };
      }
      const doc = cyclonedx(res.components, projectName);
      return {
        status: "SUCCEEDED",
        logs: `SBOM generated: ${res.components.length} components (${res.format}) digest=${res.digest}`,
        artifacts: [{ kind: "SBOM", name: "sbom.cdx.json", content: doc }],
        evidence: [{ type: "hash", content: res.digest ?? "", metadata: { stage: "SBOM_GENERATION", components: res.components.length } }],
      };
    },
    ARTIFACT_REGISTRATION: async (): Promise<StageOutput> => {
      // Register a real build manifest (actual detection snapshot) so artifact
      // integrity has genuine content to digest — never a placeholder.
      const manifest = JSON.stringify(
        {
          project: projectName,
          detected: detection,
          build_command: detection.build_command,
          test_command: detection.test_command,
          generated_at: new Date().toISOString(),
        },
        null,
        2,
      );
      return {
        status: "SUCCEEDED",
        logs: `build manifest registered (${manifest.length} bytes)`,
        artifacts: [{ kind: "LOG", name: "build-manifest.json", content: manifest }],
        evidence: [{ type: "file", content: manifest, metadata: { stage: "ARTIFACT_REGISTRATION" } }],
      };
    },
  };
}

function buildRecovery(stages: EngStageResult[]): string[] {
  const recovery: string[] = [];
  for (const s of stages) {
    if (s.outcome === "BLOCKED") {
      if (s.stageId === "BUILDING" || s.stageId === "TESTING") {
        recovery.push(`${s.label}: connect a command runtime (host shell / CI runner) to enable real execution.`);
      } else if (s.stageId === "DOCKER_BUILD" || s.stageId === "IMAGE_INSPECTION" || s.stageId === "IMAGE_SECURITY_SCAN") {
        recovery.push(`${s.label}: provide a Docker daemon + scanner to unblock container stages.`);
      } else if (s.stageId === "SBOM_GENERATION") {
        recovery.push(`${s.label}: add a dependency manifest (package.json / requirements.txt) to the workspace.`);
      } else {
        recovery.push(`${s.label}: ${s.blockedReason ?? "unavailable in this environment."}`);
      }
    } else if (s.outcome === "FAILED") {
      recovery.push(`${s.label}: ${s.detail ?? "stage failed"} — fix the finding and re-run.`);
    }
  }
  if (!recovery.length) recovery.push("All executable stages passed. No action required.");
  return recovery;
}

/**
 * Execute an engineering plan. Reuses the existing NexusOrchestrator for the
 * agent execution (authorization + audit + events + evidence + artifacts), then
 * drives the existing devops PipelineEngine across the plan's stages. Honesty:
 * any stage without a real runtime is BLOCKED, never PASSED.
 */
export async function executePlan(svc: KernelServices, actor: Actor, plan: EngineeringPlan): Promise<EngRunResult> {
  // 1. Real execution via the existing orchestrator (audited + evented). This
  //    performs authorization (execution:create), runs the inspector agent and
  //    records evidence/artifacts. Throws on denial — never bypassed.
  const submitted = await svc.orchestrator.submit(actor, plan.project.id, plan.intent.raw);
  const execution = submitted.execution;

  // 2. Drive the existing devops pipeline against the plan's live workspace.
  const psvc = toPipelineServices(svc);
  const engine = new PipelineEngine(psvc);
  const reader = workspaceReader(svc, actor, plan.workspaceId);

  const ctx: PipelineContext = {
    actor,
    project_id: plan.project.id,
    execution_id: execution.id,
    attempt: 1,
    correlation_id: execution.id,
    workspace_id: plan.workspaceId,
    reader,
    executor: null, // no command runtime in the browser sandbox → BLOCKED build/test
  };

  const run: PipelineRun = await engine.ensureRun(ctx, false);
  const runners = stageRunners(reader, plan.detection, plan.project.name);

  const results: EngStageResult[] = [];
  let artifactCount = 0;
  let failed = false;
  let blocked = false;

  for (const stage of plan.stages) {
    const runner = runners[stage.id];
    if (!runner) {
      results.push({ stageId: stage.id, label: stage.label, outcome: "SKIPPED", detail: "no runner for this stage in this pass", blockedReason: null, durationMs: null, artifacts: 0 });
      continue;
    }
    // Wrap to count REAL artifacts produced by this stage's runner.
    let stageArtifacts = 0;
    const wrapped: StageRunner = async (c) => {
      const out = await runner(c);
      stageArtifacts = out.artifacts?.length ?? 0;
      return out;
    };
    const rec = await engine.runStage(ctx, run, stage.id, wrapped);
    const mapped = mapStage(rec, stage.label);
    mapped.artifacts = stageArtifacts;
    artifactCount += stageArtifacts;
    if (mapped.outcome === "FAILED") failed = true;
    if (mapped.outcome === "BLOCKED") blocked = true;
    results.push(mapped);
  }

  const passed = results.filter((r) => r.outcome === "PASSED").length;
  const verdict: EngVerdict = failed ? "FAILED" : blocked ? "BLOCKED" : passed === results.length ? "PASSED" : "BLOCKED";

  const finalStatus = verdict === "FAILED" ? "FAILED" : verdict === "PASSED" ? "COMPLETED" : "BLOCKED";
  await engine.setRunStatus(run, finalStatus, ctx, verdict === "BLOCKED" ? "one or more required stages are unavailable in this runtime" : null);

  return {
    execution,
    agentSummary: submitted.agent_run?.outcome_summary ?? null,
    runId: run.id,
    stages: results,
    verdict,
    passed,
    failed: results.filter((r) => r.outcome === "FAILED").length,
    blocked: results.filter((r) => r.outcome === "BLOCKED").length,
    recovery: buildRecovery(results),
    artifacts: artifactCount,
  };
}

export { toSystemError };
