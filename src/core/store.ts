/**
 * NEXUS persistence — a real, typed store.
 *
 * Runs headlessly (Node) for the verification harness and in the browser with
 * a localStorage adapter. Entities are real records keyed by id; nothing here
 * depends on the DOM.
 */

import type {
  ApprovalRecord,
  ArtifactRecord,
  DeploymentRecord,
  EngineeringRequest,
  OrchestrationRun,
  RollbackRecord,
  StageRecord,
  TransitionRecord,
} from "./types";

export interface Collections {
  requests: Map<string, EngineeringRequest>;
  runs: Map<string, OrchestrationRun>;
  stages: Map<string, StageRecord>;
  transitions: Map<string, TransitionRecord>;
  artifacts: Map<string, ArtifactRecord>;
  approvals: Map<string, ApprovalRecord>;
  deployments: Map<string, DeploymentRecord>;
  rollbacks: Map<string, RollbackRecord>;
}

export class Store {
  private c: Collections;
  private persistKey: string | null;

  constructor(persistKey: string | null = null) {
    this.persistKey = persistKey;
    this.c = this.empty();
    if (persistKey) this.load();
  }

  private empty(): Collections {
    return {
      requests: new Map(),
      runs: new Map(),
      stages: new Map(),
      transitions: new Map(),
      artifacts: new Map(),
      approvals: new Map(),
      deployments: new Map(),
      rollbacks: new Map(),
    };
  }

  get requests() { return this.c.requests; }
  get runs() { return this.c.runs; }
  get stages() { return this.c.stages; }
  get transitions() { return this.c.transitions; }
  get artifacts() { return this.c.artifacts; }
  get approvals() { return this.c.approvals; }
  get deployments() { return this.c.deployments; }
  get rollbacks() { return this.c.rollbacks; }

  /** Reset to an empty database. Used only by tests and explicit user action. */
  reset(): void {
    this.c = this.empty();
    this.save();
  }

  save(): void {
    if (!this.persistKey) return;
    try {
      const g = globalThis as { localStorage?: Storage };
      if (!g.localStorage) return;
      const serialise = (m: Map<string, unknown>) => Array.from(m.entries());
      g.localStorage.setItem(
        this.persistKey,
        JSON.stringify({
          requests: serialise(this.c.requests),
          runs: serialise(this.c.runs),
          stages: serialise(this.c.stages),
          transitions: serialise(this.c.transitions),
          artifacts: serialise(this.c.artifacts),
          approvals: serialise(this.c.approvals),
          deployments: serialise(this.c.deployments),
          rollbacks: serialise(this.c.rollbacks),
        }),
      );
    } catch {
      /* persistence is best-effort; in-memory state remains authoritative */
    }
  }

  private load(): void {
    try {
      const g = globalThis as { localStorage?: Storage };
      if (!g.localStorage || !this.persistKey) return;
      const raw = g.localStorage.getItem(this.persistKey);
      if (!raw) return;
      const data = JSON.parse(raw) as Record<string, [string, unknown][]>;
      const hydrate = <T>(key: string): Map<string, T> => new Map((data[key] ?? []) as [string, T][]);
      this.c = {
        requests: hydrate<EngineeringRequest>("requests"),
        runs: hydrate<OrchestrationRun>("runs"),
        stages: hydrate<StageRecord>("stages"),
        transitions: hydrate<TransitionRecord>("transitions"),
        artifacts: hydrate<ArtifactRecord>("artifacts"),
        approvals: hydrate<ApprovalRecord>("approvals"),
        deployments: hydrate<DeploymentRecord>("deployments"),
        rollbacks: hydrate<RollbackRecord>("rollbacks"),
      };
    } catch {
      this.c = this.empty();
    }
  }

  /* Convenience queries used across the app. */
  runsFor(requestId: string): OrchestrationRun[] {
    return Array.from(this.c.runs.values())
      .filter((r) => r.request_id === requestId)
      .sort((a, b) => b.attempt - a.attempt || b.started_at - a.started_at);
  }

  stagesFor(runId: string): StageRecord[] {
    return Array.from(this.c.stages.values())
      .filter((s) => s.run_id === runId)
      .sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
  }

  transitionsFor(runId: string): TransitionRecord[] {
    return Array.from(this.c.transitions.values())
      .filter((t) => t.run_id === runId)
      .sort((a, b) => a.seq - b.seq);
  }

  artifactsFor(requestId: string): ArtifactRecord[] {
    return Array.from(this.c.artifacts.values())
      .filter((a) => a.request_id === requestId)
      .sort((a, b) => a.created_at - b.created_at);
  }
}

/**
 * Real SHA-256 via WebCrypto. Available in all modern browsers and Node 18+
 * (globalThis.crypto), so the same code path runs headless in the harness and
 * in the browser. Requires Node >= 18 for the CLI harness.
 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const g = globalThis as { crypto?: { subtle?: SubtleCrypto } };
  if (!g.crypto?.subtle) {
    throw new Error("WebCrypto is unavailable — use Node >= 18 or a modern browser");
  }
  const buf = await g.crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convenience digest with the sha256: prefix used by digests/artifacts. */
export async function digestOf(input: string): Promise<string> {
  return `sha256:${await sha256Hex(input)}`;
}

let counter = 0;
/** Deterministic-enough id; good enough for a client-side store. */
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
