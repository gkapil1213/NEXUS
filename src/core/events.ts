import { nid, openEngine, type NexusEngine } from "./db";
import { Err } from "./errors";
import type { NexusEvent, NexusEventType } from "./types";

export type EventListener = (e: NexusEvent) => void;

// Global process-level sequence counter and emit chain.
// These are shared across ALL EventService instances so sequence numbers
// are strictly increasing even when multiple kernels / services coexist.
let globalSeq = 0;
let globalChain: Promise<unknown> = Promise.resolve();

export class EventService {
  private engine: NexusEngine;
  private listeners = new Set<EventListener>();
  private ready: Promise<void>;

  constructor(engine: NexusEngine) {
    this.engine = engine;
    // Resume from the persisted maximum, but only ever increase the global counter.
    this.ready = engine.maxSeq("events").then((m) => {
      globalSeq = Math.max(globalSeq, m);
    });
  }

  init(): Promise<void> {
    return this.ready;
  }

  on(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(input: {
    type: NexusEventType;
    source: string;
    execution_id?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<NexusEvent> {
    const run = async (): Promise<NexusEvent> => {
      await this.ready;
      // Re-sync with persistence, then increment the GLOBAL counter.
      const storedMax = await this.engine.maxSeq("events");
      globalSeq = Math.max(globalSeq, storedMax) + 1;

      const event: NexusEvent = {
        id: nid("evt"),
        seq: globalSeq,
        execution_id: input.execution_id ?? null,
        type: input.type,
        timestamp: Date.now(),
        source: input.source,
        payload: input.payload ?? {},
      };
      await this.engine.put("events", event.id, event);
      this.listeners.forEach((fn) => fn(event));
      return event;
    };

    // Use the global chain so emissions from different instances are serialized.
    const next = globalChain.then(run, run);
    globalChain = next.catch(() => undefined);
    return next;
  }

  async list(limit = 200): Promise<NexusEvent[]> {
    const rows = await this.engine.all<NexusEvent>("events");
    return rows.sort((a, b) => a.seq - b.seq).slice(-limit);
  }

  async byExecution(executionId: string): Promise<NexusEvent[]> {
    const rows = await this.engine.byIndex<NexusEvent>("events", "byExecution", executionId);
    return rows.sort((a, b) => a.seq - b.seq);
  }

  async count(): Promise<number> {
    return (await this.engine.all("events")).length;
  }

  async probe(): Promise<boolean> {
    try {
      await this.count();
      return true;
    } catch {
      return false;
    }
  }
}

export function assertEventValid(e: NexusEvent): void {
  if (!e.id || typeof e.seq !== "number" || !e.type || typeof e.timestamp !== "number") {
    throw Err.validation("INVALID_EVENT", "event record failed schema validation");
  }
}