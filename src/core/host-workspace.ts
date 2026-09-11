import { getHostBridge } from "./runtime";
import type { HostBridge, HostWorkspaceCleanupResult } from "./runtime";
import type { WorkspaceService, WorkspaceActor } from "./workspace";
import { safeWorkspacePath } from "./security";
import { nid } from "./db";

export interface HostWorkspaceDeps {
  workspaces: WorkspaceService;
  bridge: HostBridge | null;
}

export type PrepareHostWorkspaceResult =
  | {
      status: "READY";
      token: string;
      cwd: string;
      files_written: number;
      files: { path: string; size: number }[];
    }
  | { status: "BLOCKED"; reason: string };

export function hasHostMaterialization(bridge: HostBridge | null): boolean {
  return !!bridge
    && typeof bridge.materializeWorkspace === "function"
    && typeof bridge.cleanupWorkspace === "function";
}

export async function prepareHostWorkspace(
  deps: HostWorkspaceDeps,
  actor: WorkspaceActor,
  workspaceId: string,
): Promise<PrepareHostWorkspaceResult> {
  const bridge = deps.bridge;
  if (!bridge) return { status: "BLOCKED", reason: "no host bridge — process execution unavailable" };
  if (!hasHostMaterialization(bridge)) {
    return {
      status: "BLOCKED",
      reason: "host bridge does not implement workspace materialization/cleanup (materializeWorkspace, cleanupWorkspace)",
    };
  }

  let records;
  try {
    records = await deps.workspaces.listFiles(actor, workspaceId);
  } catch (e) {
    return { status: "BLOCKED", reason: `workspace listing failed: ${(e as Error).message}` };
  }

  const files: { path: string; content: string }[] = [];
  for (const rec of records) {
    let norm: string;
    try {
      norm = safeWorkspacePath(rec.path);
    } catch (e) {
      return { status: "BLOCKED", reason: `unsafe workspace path '${rec.path}': ${(e as Error).message}` };
    }
    if (norm !== rec.path) {
      return { status: "BLOCKED", reason: `workspace path normalizes unexpectedly: '${rec.path}' -> '${norm}'` };
    }
    files.push({ path: norm, content: rec.content });
  }

  const token = nid("hws");
  try {
    const res = await bridge.materializeWorkspace!({ token, files });
    if (typeof res.cwd !== "string" || !res.cwd) {
      await bridge.cleanupWorkspace!(token).catch(() => undefined);
      return { status: "BLOCKED", reason: "host bridge returned an invalid cwd" };
    }
    return {
      status: "READY",
      token,
      cwd: res.cwd,
      files_written: res.files_written,
      files: files.map((f) => ({ path: f.path, size: f.content.length })),
    };
  } catch (e) {
    return { status: "BLOCKED", reason: `materialization failed: ${(e as Error).message}` };
  }
}

export async function cleanupHostWorkspace(
  deps: HostWorkspaceDeps,
  token: string,
): Promise<HostWorkspaceCleanupResult> {
  const bridge = deps.bridge ?? getHostBridge();
  if (!bridge || typeof bridge.cleanupWorkspace !== "function") {
    return { cleaned: false, error: "no host bridge cleanup capability" };
  }
  try {
    return await bridge.cleanupWorkspace(token);
  } catch (e) {
    return { cleaned: false, error: (e as Error).message };
  }
}
