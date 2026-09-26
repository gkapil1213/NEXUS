// Phase 201: canonical dependency-edge persistence for stage execution graphs.
//
// Reuses the generic graph primitive from worker-recovery-dependency.ts
// (DependencyGraph + detectCycle) instead of defining a second one.

import type { NexusEngine } from "./db";
import type { AsyncNexusEngine } from "./db";
import { detectCycle, type DependencyGraph } from "./worker-recovery-dependency";

export type StageDepError =
  | "SELF_DEPENDENCY"
  | "DUPLICATE_EDGE"
  | "EXECUTION_NOT_FOUND";

export interface StageDependencyEdge {
  executionId: string;
  stageName: string;
  dependsOnStage: string;
  createdAt: number;
}

interface EdgeRow {
  execution_id: string;
  stage_name: string;
  depends_on_stage: string;
  created_at: number | string;
}

function buildGraph(edges: StageDependencyEdge[], declaredStages: string[]): DependencyGraph {
  const nodes = new Set<string>(declaredStages);
  const map: Record<string, string[]> = {};
  for (const s of declaredStages) map[s] = map[s] ?? [];
  for (const e of edges) {
    nodes.add(e.stageName);
    nodes.add(e.dependsOnStage);
    map[e.stageName] = [...(map[e.stageName] ?? []), e.dependsOnStage];
  }
  return { nodes: [...nodes], edges: map };
}

function classifySqliteError(err: any): StageDepError | null {
  const code = err?.code;
  const msg = String(err?.message ?? "");
  if (code === "SQLITE_CONSTRAINT_CHECK" || /CHECK constraint failed/i.test(msg)) return "SELF_DEPENDENCY";
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(msg)) return "DUPLICATE_EDGE";
  return null;
}

function classifyPgError(err: any): StageDepError | null {
  const code = err?.code;
  const msg = String(err?.message ?? "");
  if (code === "23514" || /check constraint/i.test(msg)) return "SELF_DEPENDENCY";
  if (code === "23505" || /duplicate key/i.test(msg)) return "DUPLICATE_EDGE";
  return null;
}

export class StageDependencyStore {
  constructor(private db: NexusEngine) {}

  add(input: {
    executionId: string;
    stageName: string;
    dependsOnStage: string;
    now?: number;
  }): { ok: true; created: boolean } | { ok: false; reason: StageDepError } {
    if (input.stageName === input.dependsOnStage) {
      return { ok: false, reason: "SELF_DEPENDENCY" };
    }
    const now = input.now ?? Date.now();
    const exists = this.db.prepare(
      "SELECT 1 FROM execution_stage_dependencies " +
      "WHERE execution_id = ? AND stage_name = ? AND depends_on_stage = ?"
    ).get(input.executionId, input.stageName, input.dependsOnStage);
    if (exists) return { ok: false, reason: "DUPLICATE_EDGE" };

    try {
      this.db.prepare(
        "INSERT INTO execution_stage_dependencies " +
        "(execution_id, stage_name, depends_on_stage, created_at) VALUES (?, ?, ?, ?)"
      ).run(input.executionId, input.stageName, input.dependsOnStage, now);
      return { ok: true, created: true };
    } catch (err: any) {
      const classified = classifySqliteError(err);
      if (classified) return { ok: false, reason: classified };
      throw err;
    }
  }

  getDependencies(executionId: string, stageName: string): string[] {
    const rows = this.db.prepare(
      "SELECT depends_on_stage FROM execution_stage_dependencies " +
      "WHERE execution_id = ? AND stage_name = ? ORDER BY depends_on_stage ASC"
    ).all(executionId, stageName) as Array<{ depends_on_stage: string }>;
    return rows.map((r) => r.depends_on_stage);
  }

  listGraph(executionId: string): StageDependencyEdge[] {
    const rows = this.db.prepare(
      "SELECT execution_id, stage_name, depends_on_stage, created_at FROM execution_stage_dependencies " +
      "WHERE execution_id = ? ORDER BY stage_name ASC, depends_on_stage ASC"
    ).all(executionId) as EdgeRow[];
    return rows.map((r) => ({
      executionId: r.execution_id,
      stageName: r.stage_name,
      dependsOnStage: r.depends_on_stage,
      createdAt: Number(r.created_at),
    }));
  }

  deleteGraph(executionId: string): number {
    const r = this.db.prepare(
      "DELETE FROM execution_stage_dependencies WHERE execution_id = ?"
    ).run(executionId);
    return r.changes ?? 0;
  }

  validateGraph(executionId: string, declaredStages: string[]): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    const edges = this.listGraph(executionId);
    const declared = new Set(declaredStages);

    for (const e of edges) {
      if (!declared.has(e.stageName)) errors.push("DEPENDENT_NOT_DECLARED: " + e.stageName);
      if (!declared.has(e.dependsOnStage)) errors.push("DEPENDENCY_NOT_DECLARED: " + e.dependsOnStage + " -> " + e.stageName);
    }

    if (detectCycle(buildGraph(edges, declaredStages))) errors.push("CYCLE_DETECTED");
    return { ok: errors.length === 0, errors };
  }
}

export class AsyncStageDependencyStore {
  constructor(private asyncDb: AsyncNexusEngine) {}

  async add(input: {
    executionId: string;
    stageName: string;
    dependsOnStage: string;
    now?: number;
  }): Promise<{ ok: true; created: boolean } | { ok: false; reason: StageDepError }> {
    if (input.stageName === input.dependsOnStage) {
      return { ok: false, reason: "SELF_DEPENDENCY" };
    }
    const now = input.now ?? Date.now();
    const exists = await this.asyncDb.prepareAsync(
      "SELECT 1 FROM execution_stage_dependencies " +
      "WHERE execution_id = ? AND stage_name = ? AND depends_on_stage = ?"
    ).get(input.executionId, input.stageName, input.dependsOnStage);
    if (exists) return { ok: false, reason: "DUPLICATE_EDGE" };

    try {
      await this.asyncDb.prepareAsync(
        "INSERT INTO execution_stage_dependencies " +
        "(execution_id, stage_name, depends_on_stage, created_at) VALUES (?, ?, ?, ?)"
      ).run(input.executionId, input.stageName, input.dependsOnStage, now);
      return { ok: true, created: true };
    } catch (err: any) {
      const classified = classifyPgError(err);
      if (classified) return { ok: false, reason: classified };
      throw err;
    }
  }

  async getDependencies(executionId: string, stageName: string): Promise<string[]> {
    const rows = await this.asyncDb.prepareAsync(
      "SELECT depends_on_stage FROM execution_stage_dependencies " +
      "WHERE execution_id = ? AND stage_name = ? ORDER BY depends_on_stage ASC"
    ).all<{ depends_on_stage: string }>(executionId, stageName);
    return rows.map((r) => r.depends_on_stage);
  }

  async listGraph(executionId: string): Promise<StageDependencyEdge[]> {
    const rows = await this.asyncDb.prepareAsync(
      "SELECT execution_id, stage_name, depends_on_stage, created_at FROM execution_stage_dependencies " +
      "WHERE execution_id = ? ORDER BY stage_name ASC, depends_on_stage ASC"
    ).all<EdgeRow>(executionId);
    return rows.map((r) => ({
      executionId: r.execution_id,
      stageName: r.stage_name,
      dependsOnStage: r.depends_on_stage,
      createdAt: Number(r.created_at),
    }));
  }

  async deleteGraph(executionId: string): Promise<number> {
    const r = await this.asyncDb.prepareAsync(
      "DELETE FROM execution_stage_dependencies WHERE execution_id = ?"
    ).run(executionId);
    return r.changes ?? 0;
  }

  async validateGraph(executionId: string, declaredStages: string[]): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const edges = await this.listGraph(executionId);
    const declared = new Set(declaredStages);

    for (const e of edges) {
      if (!declared.has(e.stageName)) errors.push("DEPENDENT_NOT_DECLARED: " + e.stageName);
      if (!declared.has(e.dependsOnStage)) errors.push("DEPENDENCY_NOT_DECLARED: " + e.dependsOnStage + " -> " + e.stageName);
    }

    if (detectCycle(buildGraph(edges, declaredStages))) errors.push("CYCLE_DETECTED");
    return { ok: errors.length === 0, errors };
  }
}