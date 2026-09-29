// src/core/engineering-build-executor.ts
// Phase 219: real engineering BUILD stage executor.
//
// Drives the canonical BUILD stage (DAG ordinal 3, dependsOn IMPLEMENTATION)
// through the production execution boundary established in Phase 218:
//
//   ExecutionEngine → DispatchService → EngineeringStageExecutor
//     → EngineeringBuildExecutor → ProjectDetector + CommandExecutor
//
// Reuses the repository's existing production abstractions:
//   - ProjectDetector (devops.ts) — real project/file detection
//   - CommandExecutor (devops.ts) — allow-listed command execution
//   - ArtifactStore — durable build-log artifacts
//   - engineering_run_events — lifecycle events
//   - host-workspace materialization when a HostBridge is available,
//     with a Node-side mkdtemp fallback so BUILD works under tsx.
//
// Never fabricates SUCCESS. Provider/tool/workspace absence → BLOCKED.
// Real command failures → FAILED.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PgClient } from "./pg-client";
import type { ExecutionStore } from "./execution-store";
import type { ArtifactStore } from "./artifact-store";
import type { WorkspaceService, WorkspaceActor } from "./workspace";
import type { HostBridge } from "./runtime";
import { ProjectDetector, type WsReader } from "./devops";
import type { CommandExecutor } from "./devops";
import {
  hasHostMaterialization,
  prepareHostWorkspace,
  cleanupHostWorkspace,
} from "./host-workspace";
import { safeWorkspacePath } from "./security";

export type EngineeringBuildStatus = "SUCCEEDED" | "FAILED" | "BLOCKED";

export interface EngineeringBuildOutcome {
  status: EngineeringBuildStatus;
  reason: string;
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  artifactRef: string | null;
  blockedReason: string | null;
  stdout: string;
  stderr: string;
  detection: {
    language: string;
    framework: string | null;
    packageManager: string | null;
    confidence: number;
  } | null;
}

export interface EngineeringBuildExecutorDeps {
  dbUrl: string;
  store: ExecutionStore;
  artifacts: ArtifactStore;
  workspaces: WorkspaceService;
  bridge: HostBridge | null;
  commandExecutor: CommandExecutor | null;
}

export interface RunBuildInput {
  runId: string;
  workspaceId: string;
  actor: WorkspaceActor;
}

interface MaterializedWorkspace {
  cwd: string;
  token: string;
  filesWritten: number;
  cleanup: () => Promise<{ cleaned: boolean; error?: string }>;
}

function genEventId(): string {
  return "eevt-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function sanitize(s: string): string {
  if (!s) return "";
  return s
    .replace(/postgres:\/\/[^@\s]+@/gi, "postgres://<redacted>@")
    .replace(/(sk-|pk-|Bearer\s+)[A-Za-z0-9._-]{16,}/g, "$1<redacted>")
    .replace(/(api[_-]?key\s*[:=]\s*)[A-Za-z0-9._-]{16,}/gi, "$1<redacted>")
    .slice(0, 65536);
}

function isSafeBuildCommand(cmd: string): boolean {
  if (!cmd || typeof cmd !== "string") return false;
  if (/[;&|`$(){}<>]/.test(cmd)) return false;
  if (cmd.includes("\\n") || cmd.includes("\\r")) return false;
  return cmd.trim().length > 0;
}

export class EngineeringBuildExecutor {
  constructor(private readonly deps: EngineeringBuildExecutorDeps) {}

  private workspaceReader(actor: WorkspaceActor, wsId: string): WsReader {
    const { workspaces } = this.deps;
    return {
      async read(filePath: string): Promise<string | null> {
        try {
          const rec = await workspaces.readFile(actor, wsId, filePath);
          return rec.content;
        } catch { return null; }
      },
      async list(): Promise<string[]> {
        try {
          const files = await workspaces.listFiles(actor, wsId);
          return files.map((f) => f.path);
        } catch { return []; }
      },
    };
  }

  private async materialize(
    actor: WorkspaceActor,
    workspaceId: string,
  ): Promise<MaterializedWorkspace | { blocked: string }> {
    // Path 1: HostBridge materialization (browser context)
    if (hasHostMaterialization(this.deps.bridge)) {
      const prepared = await prepareHostWorkspace(
        { workspaces: this.deps.workspaces, bridge: this.deps.bridge },
        actor, workspaceId,
      );
      if (prepared.status === "BLOCKED") return { blocked: prepared.reason };
      const bridge = this.deps.bridge!;
      return {
        cwd: prepared.cwd,
        token: prepared.token,
        filesWritten: prepared.files_written,
        cleanup: async () => {
          const r = await cleanupHostWorkspace(
            { workspaces: this.deps.workspaces, bridge },
            prepared.token,
          );
          return { cleaned: r.cleaned, error: r.error };
        },
      };
    }

    // Path 2: Node-side materialization (tsx / server runtime)
    if (typeof process === "undefined" || !process.versions?.node) {
      return { blocked: "NO_MATERIALIZATION_CAPABILITY: not Node and no HostBridge" };
    }

    let records;
    try {
      records = await this.deps.workspaces.listFiles(actor, workspaceId);
    } catch (e) {
      return { blocked: "WORKSPACE_LIST_FAILED:" + (e instanceof Error ? e.message : String(e)) };
    }

    let tmpDir: string;
    try {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-build-"));
    } catch (e) {
      return { blocked: "TMPDIR_CREATE_FAILED:" + (e instanceof Error ? e.message : String(e)) };
    }

    let written = 0;
    try {
      for (const rec of records) {
        let norm: string;
        try { norm = safeWorkspacePath(rec.path); }
        catch { return { blocked: "UNSAFE_WORKSPACE_PATH:" + rec.path }; }
        if (norm !== rec.path) return { blocked: "PATH_NORMALIZATION_MISMATCH:" + rec.path };
        const abs = path.join(tmpDir, norm);
        const parent = path.dirname(abs);
        await fs.mkdir(parent, { recursive: true });
        await fs.writeFile(abs, rec.content, "utf8");
        written++;
      }
    } catch (e) {
      try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
      return { blocked: "MATERIALIZE_WRITE_FAILED:" + (e instanceof Error ? e.message : String(e)) };
    }

    return {
      cwd: tmpDir,
      token: "nws-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      filesWritten: written,
      cleanup: async () => {
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
          return { cleaned: true };
        } catch (e) {
          return { cleaned: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    };
  }


  private async appendEvent(
    runId: string,
    stageId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const pg = new PgClient();
    await pg.connect(this.deps.dbUrl);
    try {
      await pg.query(
        "INSERT INTO engineering_run_events (event_id, run_id, stage_id, event_type, payload, created_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6)",
        [genEventId(), runId, stageId, eventType, JSON.stringify(payload), Date.now()],
      );
    } finally { await pg.close(); }
  }

  async runBuild(input: RunBuildInput): Promise<EngineeringBuildOutcome> {
    const { runId, workspaceId, actor } = input;
    const stageId = runId + "__BUILD";
    const empty = (status: EngineeringBuildStatus, reason: string, blockedReason: string | null): EngineeringBuildOutcome => ({
      status, reason,
      command: null, exitCode: null, durationMs: 0,
      artifactRef: null, blockedReason,
      stdout: "", stderr: "", detection: null,
    });

    // 1. IMPLEMENTATION must be SUCCEEDED.
    const implJob = await this.deps.store.getJobAsync(runId + "__IMPLEMENTATION");
    if (!implJob || implJob.status !== "SUCCEEDED") {
      await this.appendEvent(runId, stageId, "engineering_build.blocked", {
        reason: "IMPLEMENTATION_NOT_SUCCEEDED",
        implementationStatus: implJob?.status ?? null,
      });
      return empty("BLOCKED", "IMPLEMENTATION_NOT_SUCCEEDED",
        "IMPLEMENTATION_NOT_SUCCEEDED:" + (implJob?.status ?? "MISSING"));
    }

    // 2. Project detection.
    let detection;
    try {
      detection = await new ProjectDetector().detect(this.workspaceReader(actor, workspaceId));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      await this.appendEvent(runId, stageId, "engineering_build.blocked", { reason: "DETECTION_FAILED", detail: m });
      return empty("BLOCKED", "DETECTION_FAILED:" + m, "DETECTION_FAILED");
    }

    const det = {
      language: detection.language,
      framework: detection.framework ?? null,
      packageManager: detection.package_manager ?? null,
      confidence: detection.confidence,
    };

    // 3. No build command → BLOCKED (unsupported project).
    if (!detection.build_command) {
      await this.appendEvent(runId, stageId, "engineering_build.blocked", {
        reason: "NO_BUILD_COMMAND_DETECTED",
        language: det.language, framework: det.framework,
      });
      return {
        status: "BLOCKED", reason: "NO_BUILD_COMMAND_DETECTED",
        command: null, exitCode: null, durationMs: 0,
        artifactRef: null, blockedReason: "NO_BUILD_COMMAND_DETECTED: language=" + det.language,
        stdout: "", stderr: "", detection: det,
      };
    }

    const command = detection.build_command;

    // 4. Safety check.
    if (!isSafeBuildCommand(command)) {
      await this.appendEvent(runId, stageId, "engineering_build.blocked", { reason: "UNSAFE_BUILD_COMMAND" });
      return {
        status: "BLOCKED", reason: "UNSAFE_BUILD_COMMAND",
        command, exitCode: null, durationMs: 0,
        artifactRef: null, blockedReason: "UNSAFE_BUILD_COMMAND",
        stdout: "", stderr: "", detection: det,
      };
    }

    // 5. Executor must be wired.
    if (!this.deps.commandExecutor) {
      await this.appendEvent(runId, stageId, "engineering_build.blocked", {
        reason: "COMMAND_EXECUTOR_UNAVAILABLE",
      });
      return {
        status: "BLOCKED", reason: "COMMAND_EXECUTOR_UNAVAILABLE",
        command, exitCode: null, durationMs: 0,
        artifactRef: null, blockedReason: "no command executor configured",
        stdout: "", stderr: "", detection: det,
      };
    }

    // 6. Materialize.
    const prepared = await this.materialize(actor, workspaceId);
    if ("blocked" in prepared) {
      await this.appendEvent(runId, stageId, "engineering_build.blocked", {
        reason: "MATERIALIZATION_FAILED", detail: prepared.blocked,
      });
      return {
        status: "BLOCKED", reason: "MATERIALIZATION_FAILED:" + prepared.blocked,
        command, exitCode: null, durationMs: 0,
        artifactRef: null, blockedReason: prepared.blocked,
        stdout: "", stderr: "", detection: det,
      };
    }

    // 7. Execute.
    await this.appendEvent(runId, stageId, "engineering_build.started", {
      command, cwd: prepared.cwd, token: prepared.token, files: prepared.filesWritten,
    });

    const startedAt = Date.now();
    let execResult: { exit_code: number; stdout: string; stderr: string } | null = null;
    let execError: string | null = null;
    let execErrorCode: string | null = null;
    try {
      execResult = await this.deps.commandExecutor.exec(
        command, prepared.cwd, { workspace_token: prepared.token },
      );
    } catch (e) {
      execError = e instanceof Error ? e.message : String(e);
      execErrorCode = (e as any)?.code ?? null;
    }
    const durationMs = Date.now() - startedAt;

    // 8. Cleanup — always.
    const cleanup = await prepared.cleanup();

    const stdout = sanitize(execResult?.stdout ?? "");
    const stderr = sanitize(execResult?.stderr ?? execError ?? "");
    const exitCode = execResult?.exit_code ?? null;

    // 9. Register artifact.
    let artifactRef: string | null = null;
    try {
      const logContent = JSON.stringify({
        runId, workspaceId, command, exitCode, durationMs,
        stdout, stderr,
        materializedFiles: prepared.filesWritten,
        cleanup: { cleaned: cleanup.cleaned, error: cleanup.error ?? null },
        detection: det,
        capturedAt: new Date().toISOString(),
      }, null, 2);
      const record = await this.deps.artifacts.registerArtifactAsync(
        {
          artifactId: "art-build-" + runId,
          jobId: runId,
          name: "build-log-" + runId + ".json",
          type: "ENGINEERING_BUILD_LOG",
          metadata: { runId, command, exitCode, durationMs, language: det.language },
          createdAt: startedAt,
        } as any,
        logContent,
      );
      artifactRef = "artifact://" + record.artifactId;
    } catch { /* artifact failure does not mask build result */ }

    // 10. Determine final status.
    if (execError) {
      // Distinguish honest unavailability from a real failed build:
      //   EXECUTOR_BLOCKED / "process execution unavailable" → BLOCKED
      //   anything else (spawn error, timeout)             → FAILED
      const isBlocked =
        execErrorCode === "EXECUTOR_BLOCKED" ||
        /EXECUTOR_BLOCKED|process execution unavailable|runtime capability is BLOCKED/i.test(execError);
      const mappedStatus: EngineeringBuildStatus = isBlocked ? "BLOCKED" : "FAILED";
      const mappedReason = (isBlocked ? "BUILD_EXECUTOR_BLOCKED:" : "BUILD_EXECUTION_ERROR:") + execError;
      await this.appendEvent(runId, stageId,
        isBlocked ? "engineering_build.blocked" : "engineering_build.failed",
        { command, error: execError.slice(0, 500), durationMs, code: execErrorCode });
      return {
        status: mappedStatus, reason: mappedReason,
        command, exitCode, durationMs, artifactRef,
        blockedReason: isBlocked ? execError : null,
        stdout, stderr, detection: det,
      };
    }

    if (!cleanup.cleaned) {
      await this.appendEvent(runId, stageId, "engineering_build.failed", {
        command, error: "cleanup failed: " + (cleanup.error ?? "unknown"), durationMs,
      });
      return {
        status: "FAILED", reason: "CLEANUP_FAILED:" + (cleanup.error ?? "unknown"),
        command, exitCode, durationMs, artifactRef, blockedReason: null,
        stdout, stderr, detection: det,
      };
    }

    if (exitCode === 0) {
      await this.appendEvent(runId, stageId, "engineering_build.completed", {
        command, exitCode: 0, durationMs, artifactRef,
      });
      return {
        status: "SUCCEEDED", reason: "BUILD_EXITED_ZERO",
        command, exitCode: 0, durationMs, artifactRef, blockedReason: null,
        stdout, stderr, detection: det,
      };
    }

    await this.appendEvent(runId, stageId, "engineering_build.failed", {
      command, exitCode, durationMs,
    });
    return {
      status: "FAILED", reason: "BUILD_NONZERO_EXIT:" + exitCode,
      command, exitCode, durationMs, artifactRef, blockedReason: null,
      stdout, stderr, detection: det,
    };
  }
}
