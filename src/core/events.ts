/**
 * NEXUS Phase 1 — event system.
 *
 * Append-only: events are never updated or overwritten. Ordering is
 * guaranteed by a strictly increasing sequence number resumed from the
 * persisted maximum on startup. Live subscribers receive events as they are
 * recorded.
 */

import { nid, openEngine, type NexusEngine } from "./db";
import { Err } from "./errors";
import type { NexusEvent, NexusEventType } from "./types";

export type EventListener = (e: NexusEvent) => void;

export class EventService {
  private engine: NexusEngine;
  private seq = 0;
  private listeners = new Set<EventListener>();
  private ready: Promise<void>;
  /** Serializes every emit so the max-read → seq-assign → put cycle is atomic
   *  per instance. Rapid concurrent emissions cannot interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(engine: NexusEngine) {
    this.engine = engine;
    this.ready = engine.maxSeq("events").then((m) => {
      this.seq = m;
    });
  }

  /** Wait until the sequence counter has been resumed from persistence. */
  init(): Promise<void> {
    return this.ready;
  }

  on(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Append an event. Returns the persisted record. Append-only: this method
   *  can only create, never modify or renumber, an event.
   *
   *  Sequence guarantee: before assigning, the counter is re-synced against
   *  the persisted maximum. This keeps ordering strictly increasing across
   *  page reloads AND across independent EventService instances that share
   *  the same store (e.g. a second booted kernel in the verification suite),
   *  which a construction-time-only resume cannot guarantee. Existing history
   *  is never rewritten. */
  emit(input: {
    type: NexusEventType;
    source: string;
    execution_id?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<NexusEvent> {
    const run = async (): Promise<NexusEvent> => {
      await this.ready;
      // Re-sync with the store: another instance (or a prior page session)
      // may have appended events this instance has not seen.
      const storedMax = await this.engine.maxSeq("events");
      this.seq = Math.max(this.seq, storedMax) + 1;
      const event: NexusEvent = {
        id: nid("evt"),
        seq: this.seq,
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
    // Queue the emission; a failure must not stall later emissions.
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async list(limit = 200): Promise<NexusEvent[]> {
    const rows = await this.engine.all<NexusEvent>("events");
    return rows.sort((a, b) => a.seq - b.seq).slice(-limit).reverse();
  }

  async byExecution(executionId: string): Promise<NexusEvent[]> {
    const rows = await this.engine.byIndex<NexusEvent>("events", "byExecution", executionId);
    return rows.sort((a, b) => a.seq - b.seq);
  }

  async count(): Promise<number> {
    return (await this.engine.all("events")).length;
  }

  /** True once a real read succeeds — used by health probes. */
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
