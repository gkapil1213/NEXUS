import { CONFIG } from "./config";
import { Err } from "./errors";


export const SCHEMA_VERSION = 8;

export const NEXUS_STORES = [
  "users",
  "sessions",
  "projects",
  "executions",
  "agent_runs",
  "events",
  "audit",
  "evidence",
  "artifacts",
  "secrets",
  "kv",
  "workspaces",
  "workspace_files",
  "approvals",
  "agent_executions",
  "pipeline_runs",
  "pipeline_stages",
  "change_requests",
  "git_operations",
  "ci_pipeline_runs",
  "deployments",
  "security_executions",
  "security_evidence",
  "security_findings",
  "security_decisions",
  "security_risk_assessments",
  "finding_audit_log",
] as const;
export type StoreName = (typeof NEXUS_STORES)[number];

export type EngineKind = "memory" | "idb" | "sqlite";

export interface NexusEngine {
  readonly kind: EngineKind;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  all<T>(store: StoreName): Promise<T[]>;
  byIndex<T>(store: StoreName, index: string, key: IDBValidKey | IDBKeyRange): Promise<T[]>;
  del(store: StoreName, key: string): Promise<void>;
  clear(store: StoreName): Promise<void>;
  maxSeq(store: StoreName): Promise<number>;
  stores(): string[];
}

export function nid(prefix: string): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${uuid}`;
}

/* ----------------------------- IndexedDB engine ---------------------------- */

const INDEXES: Record<string, [string, string][]> = {
  executions: [["byProject", "project_id"]],
  agent_runs: [["byExecution", "execution_id"]],
  events: [["byExecution", "execution_id"]],
  audit: [["byResource", "resource_id"]],
  evidence: [["byExecution", "execution_id"]],
  artifacts: [["byExecution", "execution_id"]],
  security_executions: [
    ["byProject", "project_id"],
    ["byExecution", "execution_id"],
    ["byRelease", "release_id"],
  ],
  security_evidence: [
    ["byExecution", "execution_id"],
    ["byArtifact", "artifact_digest"],
  ],
  security_findings: [
    ["byEvidence", "evidence_id"],
    ["byFingerprint", "fingerprint"],
    ["byStatus", "status"],
    ["byProject", "project_id"],
    ["byExecution", "execution_id"],
  ],
  security_decisions: [
    ["byExecution", "execution_id"],
    ["byRelease", "release_id"],
  ],
  security_risk_assessments: [["byExecution", "execution_id"]],
  finding_audit_log: [["byFinding", "finding_id"]],
  workspaces: [
    ["byProject", "project_id"],
    ["byExecution", "execution_id"],
  ],
  workspace_files: [["byWorkspace", "workspace_id"]],
  agent_executions: [["byExecution", "execution_id"]],
  pipeline_runs: [
    ["byProject", "project_id"],
    ["byExecution", "execution_id"],
  ],
  pipeline_stages: [
    ["byRun", "run_id"],
    ["byExecution", "execution_id"],
  ],
  change_requests: [
    ["byExecution", "execution_id"],
    ["byRepository", "repository"],
  ],
  git_operations: [["byExecution", "execution_id"]],
  ci_pipeline_runs: [
    ["byExecution", "execution_id"],
    ["byProject", "project_id"],
  ],
};

class IdbEngine implements NexusEngine {
  readonly kind = "idb" as const;
  private db: IDBDatabase;
  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(name: string): Promise<IdbEngine> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, SCHEMA_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const store of NEXUS_STORES) {
          if (d.objectStoreNames.contains(store)) continue;
          const os = d.createObjectStore(store, { keyPath: "__key" });
          for (const [index, field] of INDEXES[store] ?? []) os.createIndex(index, field);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(Err.persistence("DB_OPEN_FAILED", "could not open the IndexedDB database"));
      req.onblocked = () => reject(Err.persistence("DB_BLOCKED", "database open blocked by another connection"));
    });
    return new IdbEngine(db);
  }

  private tx(store: StoreName, mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(store, mode).objectStore(store);
  }

  private done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(Err.persistence("TX_FAILED", "persistence transaction failed"));
      tx.onabort = () => reject(Err.persistence("TX_ABORTED", "persistence transaction aborted"));
    });
  }

  async put(store: StoreName, key: string, value: unknown): Promise<void> {
    const os = this.tx(store, "readwrite");
    const tx = os.transaction;
    os.put({ ...(value as object), __key: key });
    await this.done(tx);
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const os = this.tx(store, "readonly");
    const rec = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const req = os.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(Err.persistence("READ_FAILED", "persistence read failed"));
    });
    if (!rec) return undefined;
    const { __key: _k, ...rest } = rec;
    return rest as T;
  }

  async all<T>(store: StoreName): Promise<T[]> {
    const os = this.tx(store, "readonly");
    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const req = os.getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(Err.persistence("READ_FAILED", "persistence read failed"));
    });
    return rows.map((r) => {
      const { __key: _k, ...rest } = r;
      return rest as T;
    });
  }

  async byIndex<T>(store: StoreName, index: string, key: IDBValidKey | IDBKeyRange): Promise<T[]> {
    const os = this.tx(store, "readonly");
    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const req = os.index(index).getAll(key);
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(Err.persistence("READ_FAILED", "persistence index read failed"));
    });
    return rows.map((r) => {
      const { __key: _k, ...rest } = r;
      return rest as T;
    });
  }

  async del(store: StoreName, key: string): Promise<void> {
    const os = this.tx(store, "readwrite");
    const tx = os.transaction;
    os.delete(key);
    await this.done(tx);
  }

  async clear(store: StoreName): Promise<void> {
    const os = this.tx(store, "readwrite");
    const tx = os.transaction;
    os.clear();
    await this.done(tx);
  }

  async maxSeq(store: StoreName): Promise<number> {
    const rows = await this.all<{ seq?: number }>(store);
    return rows.reduce((m, r) => Math.max(m, r.seq ?? 0), 0);
  }

  stores(): string[] {
    return Array.from(this.db.objectStoreNames);
  }
}

/* ------------------------- Memory engine (non-browser) --------------------- */

class MemEngine implements NexusEngine {
  readonly kind = "memory" as const;
  private data = new Map<StoreName, Map<string, unknown>>();

  constructor() {
    for (const s of NEXUS_STORES) this.data.set(s, new Map());
  }
  private store(s: StoreName): Map<string, unknown> {
    return this.data.get(s)!;
  }
  async put(store: StoreName, key: string, value: unknown): Promise<void> {
    this.store(store).set(key, structuredClone(value));
  }
  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const v = this.store(store).get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async all<T>(store: StoreName): Promise<T[]> {
    return Array.from(this.store(store).values()).map((v) => structuredClone(v) as T);
  }
  async byIndex<T>(store: StoreName, index: string, key: IDBValidKey | IDBKeyRange): Promise<T[]> {
    const field = (INDEXES[store] ?? []).find(([i]) => i === index)?.[1];
    if (!field) return [];
    const rows = await this.all<Record<string, unknown>>(store);
    const matches = (v: unknown) =>
      typeof IDBKeyRange !== "undefined" && key instanceof IDBKeyRange ? key.includes(v as IDBValidKey) : v === key;
    return rows.filter((r) => matches(r[field])).map((r) => structuredClone(r) as T);
  }
  async del(store: StoreName, key: string): Promise<void> {
    this.store(store).delete(key);
  }
  async clear(store: StoreName): Promise<void> {
    this.store(store).clear();
  }
  async maxSeq(store: StoreName): Promise<number> {
    const rows = await this.all<{ seq?: number }>(store);
    return rows.reduce((m, r) => Math.max(m, r.seq ?? 0), 0);
  }
  stores(): string[] {
    return [...NEXUS_STORES];
  }
}

/* --------------------------------- open ----------------------------------- */

let enginePromise: Promise<NexusEngine> | null = null;

export function openEngine(): Promise<NexusEngine> {
  if (!enginePromise) {
    const p = (async () => {
      // Environment variable overrides (used by test scripts, e.g., Phase 5 Pass 7)
      const envEngine =
        typeof process !== "undefined" && process.env?.NEXUS_PERSISTENCE_ENGINE
          ? (process.env.NEXUS_PERSISTENCE_ENGINE as EngineKind)
          : undefined;
      const kind = envEngine ?? CONFIG.persistence.engine;
      const dbName =
        (typeof process !== "undefined" && process.env?.NEXUS_DB_PATH) || CONFIG.persistence.dbName;

      if (kind === "memory") {
        return new MemEngine();
      }  else if (kind === "sqlite") {
        // Dynamically load Node-only SQLite engine only when used, keeping
        // better-sqlite3 and Node core modules out of the browser bundle.
        const { SQLiteEngine } = await import("./sqlite-engine");
        return await SQLiteEngine.open(dbName);
      } else  {
        throw new Error(`Unsupported engine: ${kind}`);
      }
    })();
    enginePromise = p;
    return p;
  }
  return enginePromise;
}

/** Resets the cached engine promise so a new engine can be created with a different config. */
export function resetEngineForTesting(): void {
  enginePromise = null;
}

/** Real round-trip probe: write → read → verify → delete. Returns latency ms. */
export async function probeEngine(engine: NexusEngine): Promise<number> {
  const t0 = performance.now();
  const probeKey = "__health_probe";
  const value = { value: Math.random().toString(36).slice(2), at: Date.now() };
  await engine.put("kv", probeKey, value);
  const read = await engine.get<typeof value>("kv", probeKey);
  await engine.del("kv", probeKey);
  if (!read || read.value !== value.value) {
    throw Err.persistence("PROBE_MISMATCH", "persistence probe verification failed");
  }
  return Math.round((performance.now() - t0) * 10) / 10;
}

/* ------------------------------ crypto helpers ----------------------------- */

const encoder = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function digestOf(input: string): Promise<string> {
  return `sha256:${await sha256Hex(input)}`;
}

export function randomTokenHex(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashSecret(secret: string, salt: string, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const saltBuf = encoder.encode(salt);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBuf, iterations },
    keyMaterial,
    256,
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}