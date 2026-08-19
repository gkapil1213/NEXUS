/**
 * NEXUS Phase 3 — DevOps build & artifact foundation.
 *
 * This module provides the REAL pipeline foundation:
 *   ProjectDetector        — detects language/framework/runtime/commands from
 *                            actual workspace files (never invents values).
 *   build plan + validation— structured BuildPlan; commands checked against an
 *                            allowlist; dangerous operations rejected.
 *   SecurityScanner        — real static scan (secrets / unsafe config).
 *   SBOMService            — REAL source SBOM (CycloneDX) from actual deps.
 *   ArtifactIntegrityService — deterministic sha256 digests + verification.
 *   PipelineEngine         — shared state machine + stage-record persistence.
 *
 * HONESTY RULE: build/test *execution* requires a command/shell runtime that
 * does not exist in the browser sandbox. When no CommandExecutor is provided
 * the engine reports BLOCKED with the real reason — it never fabricates a
 * SUCCEEDED build. Tests may inject a stub executor (dependency injection) to
 * exercise the SUCCEEDED/FAILED paths; the production default stays BLOCKED.
 */

import { digestOf, nid, type NexusEngine } from "./db";
import { Err, toSystemError } from "./errors";
import type { AuditService } from "./audit";
import type { EventService } from "./events";
import type { ArtifactService, EvidenceService } from "./services";
import type {
  ArtifactReference,
  BuildPlan,
  DetectionResult,
  Evidence,
  PipelineRun,
  PipelineStage,
  PipelineStageName,
  PipelineStatus,
  SbomComponent,
  SbomRecord,
  SbomResult,
  SecurityScanResult,
  StageStatus,
} from "./types";
import type { Actor } from "./services";
import type { AuthorizationService } from "./security";

/* ------------------------------ Workspace reader --------------------------- */

/** Minimal, read-only view of a workspace. Decouples detection/SBOM from the
 *  concrete WorkspaceService so they are unit-testable and stay inside the
 *  Phase 2 FileAccessPolicy boundary (the orchestrator binds a real reader). */
export interface WsReader {
  read(path: string): Promise<string | null>;
  list(): Promise<string[]>;
}

/* ------------------------------ ProjectDetector ---------------------------- */

interface PkgJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export class ProjectDetector {
  /** Detect project characteristics from REAL workspace files. */
  async detect(reader: WsReader): Promise<DetectionResult> {
    const files = await reader.list();
    const has = (f: string) => files.includes(f);
    const evidence: string[] = [];

    const pkgRaw = has("package.json") ? await reader.read("package.json") : null;
    const reqRaw = has("requirements.txt") ? await reader.read("requirements.txt") : null;
    const pyprojectRaw = has("pyproject.toml") ? await reader.read("pyproject.toml") : null;

    let pkg: PkgJson | null = null;
    if (pkgRaw) {
      try {
        pkg = JSON.parse(pkgRaw) as PkgJson;
        evidence.push("package.json");
      } catch {
        pkg = null; // present but unparsable — do not guess
      }
    }
    if (reqRaw) evidence.push("requirements.txt");
    if (pyprojectRaw) evidence.push("pyproject.toml");

    const dockerfile = has("Dockerfile");
    const docker_compose = has("docker-compose.yml") || has("docker-compose.yaml");
    if (dockerfile) evidence.push("Dockerfile");
    if (docker_compose) evidence.push(has("docker-compose.yml") ? "docker-compose.yml" : "docker-compose.yaml");

    // TypeScript vs Node: tsconfig or a .ts entry implies typescript.
    const isTs = has("tsconfig.json") || files.some((f) => f.endsWith(".ts"));
    if (isTs && pkg) evidence.push("tsconfig.json|*.ts");

    let language: DetectionResult["language"] = "unknown";
    let framework: string | null = null;
    let runtime: string | null = null;
    let package_manager: string | null = null;
    let build_command: string | null = null;
    let test_command: string | null = null;
    let entrypoint: string | null = null;
    let confidence = 0;

    if (pkg) {
      language = isTs ? "typescript" : "node";
      runtime = "node";
      package_manager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps["next"]) framework = "next";
      else if (deps["vite"]) framework = "vite";
      else if (deps["react"]) framework = "react";
      build_command = pkg.scripts?.build ?? null;
      test_command = pkg.scripts?.test ?? null;
      entrypoint = pkg.scripts?.start ?? (isTs ? "dist/index.js" : "index.js");
      confidence = isTs ? 0.9 : 0.85;
    } else if (reqRaw || pyprojectRaw) {
      language = "python";
      runtime = "python";
      package_manager = "pip";
      const text = `${pyprojectRaw ?? ""}\n${reqRaw ?? ""}`;
      if (/fastapi/i.test(text)) framework = "fastapi";
      build_command = null; // python has no compile step by default
      test_command = /pytest/i.test(text) ? "pytest" : null;
      entrypoint = framework === "fastapi" ? "main:app" : "main.py";
      confidence = framework ? 0.8 : 0.7;
    }

    return {
      language,
      framework,
      runtime,
      package_manager,
      build_command: build_command ? `${package_manager} run ${build_command === "true" ? "build" : "build"}`.replace(/^(\w+) run true$/, "$1 run build") : build_command === null ? null : `${package_manager} run build`,
      test_command: test_command ? (runtime === "python" ? test_command : `${package_manager} test`) : null,
      entrypoint,
      confidence,
      dockerfile,
      docker_compose,
      evidence,
    };
  }
}

/* ------------------------------ Build plan safety --------------------------- */

/** Commands/patterns that are NEVER allowed. The plan validator rejects them. */
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-z]*\s+)*-?r/i, // rm -rf / recursive rm
  /\bformat\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  />\s*\/dev\/sd/i,
  /\bcurl\b.*\|\s*(bash|sh)\b/i, // piped remote shell
  /\bwget\b.*\|\s*(bash|sh)\b/i,
  /~?\/\.ssh\b/i,
  /~?\/\.aws\b/i,
  /\bchmod\s+(-[a-z]+\s+)*777\b/i,
  /\beval\b/i,
  /\$\(\s*cat\b/i, // credential extraction
  /\/etc\/(passwd|shadow)\b/i,
];

/** Only these base commands may begin an allow-listed build/test command. */
const ALLOWED_BASE_COMMANDS = ["npm", "pnpm", "yarn", "npx", "node", "python", "python3", "pip", "pytest", "tsc", "vite", "next", "go", "cargo", "mvn", "docker"];

export interface BuildPlanValidation {
  ok: boolean;
  rejected: string[]; // the specific dangerous patterns/commands found
  normalized: BuildPlan | null;
}

export function buildPlanFrom(d: DetectionResult): BuildPlan {
  return {
    runtime: d.runtime === "python" ? "python" : d.runtime === "node" ? "node" : "none",
    package_manager: d.package_manager,
    install_command: d.runtime === "python" ? "pip install -r requirements.txt" : d.runtime === "node" ? `${d.package_manager ?? "npm"} install` : null,
    build_command: d.build_command,
    test_command: d.test_command,
    working_directory: ".",
  };
}

/** Validate every command in a BuildPlan against the allowlist. Fail closed. */
export function validateBuildPlan(plan: BuildPlan): BuildPlanValidation {
  const rejected: string[] = [];
  const cmds = [plan.install_command, plan.build_command, plan.test_command].filter(Boolean) as string[];

  for (const cmd of cmds) {
    for (const re of DANGEROUS_PATTERNS) {
      if (re.test(cmd)) rejected.push(`dangerous pattern in "${cmd}"`);
    }
    const base = cmd.trim().split(/\s+/)[0];
    if (!ALLOWED_BASE_COMMANDS.includes(base)) rejected.push(`disallowed base command "${base}"`);
    if (cmd.includes("&&") || cmd.includes(";") || cmd.includes("|")) {
      // chained/piped commands are not allow-listed
      rejected.push(`command chaining not allowed in "${cmd}"`);
    }
  }

  if (plan.working_directory !== "." && !/^[A-Za-z0-9._\-/]+$/.test(plan.working_directory)) {
    rejected.push(`invalid working_directory "${plan.working_directory}"`);
  }
  if (plan.working_directory.startsWith("/") || plan.working_directory.includes("..")) {
    rejected.push(`working_directory escapes the workspace`);
  }

  return { ok: rejected.length === 0, rejected, normalized: rejected.length === 0 ? plan : null };
}

/* ------------------------------ Command executor ---------------------------- */

/** Abstraction for running a command. The browser sandbox has NO real executor,
 *  so the orchestrator receives `null` and honestly reports BLOCKED. Tests may
 *  inject a stub to exercise success/failure paths. */
export interface CommandExecutor {
  exec(command: string, cwd: string): Promise<{ exit_code: number; stdout: string; stderr: string }>;
}

/* ------------------------------ SecurityScanner ----------------------------- */

const SECRET_PATTERNS: [RegExp, string][] = [
  [/ghp_[A-Za-z0-9]{20,}/g, "github token"],
  [/gho_[A-Za-z0-9]{20,}/g, "github oauth token"],
  [/sk-[A-Za-z0-9]{16,}/g, "provider api key"],
  [/AKIA[0-9A-Z]{16}/g, "aws access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private key"],
  [/(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}["']?/gi, "embedded credential"],
];

const UNSAFE_CONFIG: [RegExp, string][] = [
  [/\beval\s*\(/g, "use of eval()"],
  [/new\s+Function\s*\(/g, "use of new Function()"],
  [/rejectUnauthorized\s*:\s*false/g, "TLS verification disabled"],
  [/\bhttp:\/\/(?!localhost|127\.0\.0\.1)/g, "insecure http endpoint"],
];

export class SecurityScanner {
  /** Real static scan of workspace files. Never claims an external feed ran. */
  async staticScan(reader: WsReader): Promise<SecurityScanResult> {
    const files = await reader.list();
    const findings: string[] = [];

    for (const f of files) {
      const content = await reader.read(f);
      if (content === null) continue;
      for (const [re, label] of SECRET_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(content)) findings.push(`${f}: ${label}`);
      }
      for (const [re, label] of UNSAFE_CONFIG) {
        re.lastIndex = 0;
        if (re.test(content)) findings.push(`${f}: ${label}`);
      }
    }

    return {
      status: findings.length === 0 ? "PASSED" : "FAILED",
      findings,
      external_scanner: "BLOCKED",
      blocked_reason: null,
    };
  }
}

/* --------------------------------- SBOM ------------------------------------- */

export class SBOMService {
  /** Generate a REAL source SBOM (CycloneDX) from actual dependency manifests.
   *  Never invents components or versions. Returns BLOCKED when there is no
   *  manifest to read. */
  async generateSourceSbom(reader: WsReader, detection: DetectionResult, projectId: string): Promise<SbomResult> {
    const components: SbomComponent[] = [];

    const pkgRaw = await reader.read("package.json");
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as PkgJson;
        for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
          components.push({ name, version: cleanVersion(version), ecosystem: "npm", dev: false });
        }
        for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
          components.push({ name, version: cleanVersion(version), ecosystem: "npm", dev: true });
        }
      } catch {
        /* unparsable manifest contributes nothing */
      }
    }

    const reqRaw = await reader.read("requirements.txt");
    if (reqRaw) {
      for (const line of reqRaw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const m = trimmed.match(/^([A-Za-z0-9._\-]+)\s*(?:==|>=|<=|~=|!=)\s*([^\s;#]+)/);
        if (m) components.push({ name: m[1], version: m[2], ecosystem: "pypi", dev: false });
        else components.push({ name: trimmed.split(/[=<>~!;\s]/)[0], version: "unpinned", ecosystem: "pypi", dev: false });
      }
    }

    if (components.length === 0) {
      return { status: "BLOCKED", format: null, components: [], digest: null, blocked_reason: "no dependency manifest found (package.json / requirements.txt)" };
    }

    const doc = this.cyclonedx(components, projectId, detection);
    const digest = await digestOf(doc);
    return { status: "SUCCEEDED", format: "CycloneDX", components, digest, blocked_reason: null };
  }

  private cyclonedx(components: SbomComponent[], projectId: string, detection: DetectionResult): string {
    return JSON.stringify(
      {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        version: 1,
        metadata: {
          timestamp: new Date().toISOString(),
          tools: [{ vendor: "nexus", name: "nexus-sbom", version: "1.0.0" }],
          component: { type: "application", "bom-ref": projectId, name: projectId, language: detection.language },
        },
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

  toRecord(result: SbomResult, source: "SOURCE_SBOM" | "IMAGE_SBOM"): SbomRecord | null {
    if (result.status !== "SUCCEEDED" || !result.digest) return null;
    return {
      source,
      format: "CycloneDX",
      generator: "nexus-sbom@1.0.0",
      timestamp: Date.now(),
      digest: result.digest,
      components: result.components,
    };
  }
}

function cleanVersion(v: string): string {
  return v.replace(/^[\^~>=<\s]+/, "");
}

/* --------------------------- ArtifactIntegrityService ----------------------- */

export class ArtifactIntegrityService {
  constructor(private artifacts: ArtifactService) {}

  async calculateDigest(content: string): Promise<string> {
    return digestOf(content);
  }

  /** Verify an artifact's stored content still matches its recorded digest. */
  async verifyDigest(artifactId: string, engine: NexusEngine): Promise<{ ok: boolean; expected: string | null; actual: string }> {
    const rec = await engine.get<ArtifactReference & { __content?: string }>("artifacts", artifactId);
    if (!rec) throw Err.notFound("ARTIFACT_NOT_FOUND", "artifact not found");
    const actual = await digestOf(rec.__content ?? "");
    return { ok: actual === rec.digest, expected: rec.digest ?? null, actual };
  }

  /** Register an artifact with REAL content. The digest is computed from the
   *  actual bytes by ArtifactService — never invented. */
  async register(executionId: string, input: { kind: string; name: string; content: string }): Promise<ArtifactReference> {
    return this.artifacts.register(executionId, input);
  }
}

/* ------------------------------- Pipeline engine ---------------------------- */

export interface PipelineContext {
  actor: Actor;
  project_id: string;
  execution_id: string;
  attempt: number;
  correlation_id: string;
  workspace_id: string;
  reader: WsReader;
  /** Injected command executor; null in the browser sandbox (honest BLOCKED). */
  executor: CommandExecutor | null;
}

export interface StageOutput {
  status: Exclude<StageStatus, "RUNNING">; // SUCCEEDED | FAILED | BLOCKED
  command?: string | null;
  logs?: string;
  error?: string | null;
  blocked_reason?: string | null;
  artifacts?: { kind: string; name: string; content: string }[];
  evidence?: { type: "log" | "report" | "hash" | "file"; content: string; metadata?: Record<string, unknown> }[];
}

export type StageRunner = (ctx: PipelineContext) => Promise<StageOutput>;

export interface PipelineServices {
  engine: NexusEngine;
  events: EventService;
  audit: AuditService;
  evidence: EvidenceService;
  artifacts: ArtifactService;
  authz: AuthorizationService;
}

/** Legal forward pipeline order. A stage may only be reached from its
 *  predecessor; any stage may also terminate the run as FAILED/BLOCKED. */
export const PIPELINE_ORDER: PipelineStageName[] = [
  "DETECTING",
  "BUILDING",
  "TESTING",
  "SECURITY_REVIEW",
  "DOCKERFILE_DETECTION",
  "DOCKERFILE_VALIDATION",
  "DOCKER_BUILD",
  "IMAGE_INSPECTION",
  "IMAGE_SECURITY_SCAN",
  "SBOM_GENERATION",
  "ARTIFACT_REGISTRATION",
];

export function isLegalTransition(from: PipelineStatus, to: PipelineStatus): boolean {
  if (from === "FAILED" || from === "BLOCKED" || from === "COMPLETED") return false; // terminal
  if (to === "FAILED" || to === "BLOCKED" || to === "COMPLETED") return true; // any stage may terminate
  const fi = PIPELINE_ORDER.indexOf(from as PipelineStageName);
  const ti = PIPELINE_ORDER.indexOf(to as PipelineStageName);
  if (fi === -1 || ti === -1) return false;
  return ti === fi + 1; // strictly the next stage
}

export class PipelineEngine {
  constructor(private svc: PipelineServices) {}

  /** Load (idempotently) or create the PipelineRun for an execution+attempt. */
  async ensureRun(ctx: PipelineContext, docker: boolean): Promise<PipelineRun> {
    const existing = await this.svc.engine.byIndex<PipelineRun>("pipeline_runs", "byExecution", ctx.execution_id);
    const match = existing.find((r) => r.attempt === ctx.attempt);
    if (match) return match;

    const now = Date.now();
    const run: PipelineRun = {
      id: nid("pln"),
      project_id: ctx.project_id,
      execution_id: ctx.execution_id,
      attempt: ctx.attempt,
      correlation_id: ctx.correlation_id,
      status: "DETECTING",
      current_stage: "DETECTING",
      created_at: now,
      updated_at: now,
      error: null,
      blocked_reason: null,
      docker: docker ? { dockerfile: false, compose: false, runtime: "BLOCKED" } : null,
    };
    await this.svc.engine.put("pipeline_runs", run.id, run);
    await this.emit("devops.pipeline.started", ctx, { run_id: run.id, attempt: ctx.attempt });
    return run;
  }

  /** Finalize (upsert) the single logical stage record for (exec, stage, attempt). */
  async stageRecord(ctx: PipelineContext, stage: PipelineStageName, status: Exclude<StageStatus, "RUNNING"> | "RUNNING", extra: Partial<PipelineStage> = {}): Promise<PipelineStage> {
    const existing = await this.svc.engine.byIndex<PipelineStage>("pipeline_stages", "byExecution", ctx.execution_id);
    const rec = existing.find((s) => s.stage === stage && s.attempt === ctx.attempt);
    const now = Date.now();

    if (rec && status !== "RUNNING") {
      // Finalize in place — never insert a duplicate terminal record.
      rec.status = status;
      rec.completed_at = now;
      rec.duration_ms = rec.started_at ? now - rec.started_at : null;
      Object.assign(rec, extra);
      await this.svc.engine.put("pipeline_stages", rec.id, rec);
      return rec;
    }
    if (rec) return rec; // already RUNNING

    const fresh: PipelineStage = {
      id: nid("stg"),
      run_id: extra.run_id ?? "",
      execution_id: ctx.execution_id,
      stage,
      attempt: ctx.attempt,
      correlation_id: ctx.correlation_id,
      status: "RUNNING",
      started_at: now,
      completed_at: null,
      duration_ms: null,
      evidence_id: null,
      command: null,
      logs_ref: null,
      error: null,
      blocked_reason: null,
      ...extra,
    };
    await this.svc.engine.put("pipeline_stages", fresh.id, fresh);
    return fresh;
  }

  private eventStage(stage: PipelineStageName): { started: string; completed: string } {
    const key = stage.toLowerCase();
    return { started: `devops.${key}.started`, completed: `devops.${key}.completed` };
  }

  private async emit(type: string, ctx: PipelineContext, payload: Record<string, unknown>): Promise<void> {
    await this.svc.events.emit({
      type: type as never,
      source: "PipelineEngine",
      execution_id: ctx.execution_id,
      payload: { ...payload, stage: payload.stage ?? null, attempt: ctx.attempt, correlation_id: ctx.correlation_id, status: payload.status ?? null },
    });
  }

  private async audit(ctx: PipelineContext, action: string, result: "allow" | "deny" | "error" | "info", meta: Record<string, unknown>): Promise<void> {
    await this.svc.audit.record({
      actor: ctx.actor.email,
      action,
      resource_type: "pipeline",
      resource_id: ctx.execution_id,
      result,
      metadata: meta,
    });
  }

  /** Run a stage: record RUNNING, execute, finalize, evidence, event, audit. */
  async runStage(ctx: PipelineContext, run: PipelineRun, stage: PipelineStageName, runner: StageRunner): Promise<PipelineStage> {
    await this.stageRecord(ctx, stage, "RUNNING", { run_id: run.id });
    const ev = this.eventStage(stage);
    await this.emit(ev.started, ctx, { stage, status: "RUNNING" });
    await this.audit(ctx, `stage.started:${stage}`, "info", { stage, attempt: ctx.attempt });

    let out: StageOutput;
    try {
      out = await runner(ctx);
    } catch (e) {
      const err = toSystemError(e, "STAGE_FAILED");
      out = { status: "FAILED", error: err.message, logs: err.message };
    }

    // Register any produced artifacts (real content → real digests).
    const artifactIds: string[] = [];
    for (const a of out.artifacts ?? []) {
      const ref = await this.svc.artifacts.register(ctx.execution_id, { kind: a.kind, name: a.name, content: a.content });
      artifactIds.push(ref.id);
    }

    // Record evidence (log/report), never secrets.
    let evidenceId: string | null = null;
    if (out.logs || out.evidence) {
      const evi: Evidence = await this.svc.evidence.record(ctx.execution_id, {
        type: "log",
        source: out.status === "BLOCKED" ? "ENVIRONMENT_BLOCK" : "REAL_EXECUTION",
        content: out.logs ?? JSON.stringify(out.evidence ?? {}),
        metadata: { stage, status: out.status, command: out.command ?? null },
      });
      evidenceId = evi.id;
    }

    const rec = await this.stageRecord(ctx, stage, out.status, {
      run_id: run.id,
      command: out.command ?? null,
      logs_ref: out.logs ? `evidence://${evidenceId}` : null,
      evidence_id: evidenceId,
      error: out.error ? toSystemError(new Error(out.error), "STAGE_FAILED") : null,
      blocked_reason: out.blocked_reason ?? null,
    });

    await this.emit(ev.completed, ctx, { stage, status: out.status, artifacts: artifactIds.length });
    const auditResult = out.status === "SUCCEEDED" ? "allow" : out.status === "BLOCKED" ? "info" : "error";
    await this.audit(ctx, `stage.completed:${stage}`, auditResult, {
      stage,
      attempt: ctx.attempt,
      status: out.status,
      blocked_reason: out.blocked_reason ?? null,
      artifacts: artifactIds.length,
    });
    return rec;
  }

  async setRunStatus(run: PipelineRun, status: PipelineStatus, ctx: PipelineContext, reason: string | null): Promise<void> {
    run.status = status;
    run.current_stage = status === "COMPLETED" || status === "FAILED" || status === "BLOCKED" ? null : run.current_stage;
    run.updated_at = Date.now();
    run.blocked_reason = status === "BLOCKED" ? reason : null;
    run.error = status === "FAILED" ? toSystemError(new Error(reason ?? "pipeline failed"), "PIPELINE_FAILED") : null;
    await this.svc.engine.put("pipeline_runs", run.id, run);
    const evType = status === "COMPLETED" ? "devops.pipeline.completed" : status === "FAILED" ? "devops.pipeline.failed" : "devops.pipeline.blocked";
    await this.emit(evType, ctx, { run_id: run.id, status, reason });
  }
}
