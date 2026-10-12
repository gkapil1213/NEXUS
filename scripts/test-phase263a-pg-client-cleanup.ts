// scripts/test-phase263a-pg-client-cleanup.ts
// Phase 263A - PostgreSQL startup cleanup and failure-safe resource lifecycle.
//
// Unit tests for PgClient.connect using fake pools. No live database is
// required. Four scenarios are exercised:
//
//   A. pool.connect() rejects -> pool.end() called once, original error
//      propagated, client remains disconnected.
//   B. pool.connect() succeeds, SELECT 1 rejects -> client.release() called
//      once, pool.end() called once, original validation error propagated,
//      client remains disconnected.
//   C. Same as B, but pool.end() also rejects -> original validation error
//      preserved (not replaced by cleanup error), client.release() called
//      once, client remains disconnected.
//   D. Connection and validation succeed -> client marked connected only
//      after validation, validation client released once, pool not
//      prematurely closed; close() closes the active pool.

import { PgClient } from "../src/core/pg-client";

type Result = "PASS" | "FAIL";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : "[FAIL]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

async function test(id: string, name: string, fn: () => Promise<string> | string): Promise<void> {
  try { record(id, name, "PASS", await fn()); }
  catch (e) {
    record(id, name, "FAIL", e instanceof Error ? e.message : String(e));
  }
}

// ------------------------------------------------------------------
// Fake Pool / PoolClient.
// ------------------------------------------------------------------

interface FakeClient {
  query: (sql: string) => Promise<unknown>;
  release: () => void;
}

interface FakePool {
  connect: () => Promise<FakeClient>;
  end: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
}

interface FakePoolOptions {
  connectError?: Error;
  validationError?: Error;
  endError?: Error;
}

function makeFakePool(opts: FakePoolOptions): {
  pool: FakePool;
  connectCalls: { n: number };
  releaseCalls: { n: number };
  endCalls: { n: number };
} {
  const connectCalls = { n: 0 };
  const releaseCalls = { n: 0 };
  const endCalls = { n: 0 };

  const client: FakeClient = {
    async query(_sql: string) {
      if (opts.validationError) throw opts.validationError;
      return { rowCount: 1, rows: [{ "?column?": 1 }] };
    },
    release() { releaseCalls.n++; },
  };

  const pool: FakePool = {
    async connect() {
      connectCalls.n++;
      if (opts.connectError) throw opts.connectError;
      return client;
    },
    async end() {
      endCalls.n++;
      if (opts.endError) throw opts.endError;
    },
    async query(_sql: string, _params?: unknown[]) {
      return { rows: [], rowCount: 0 };
    },
  };

  return { pool, connectCalls, releaseCalls, endCalls };
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------
  // Test A - pool.connect() rejects
  // ---------------------------------------------------------------
  await test("263A-A", "pool.connect() failure closes pool and preserves error", async () => {
    const connectError = new Error("A: connect failed");
    const fake = makeFakePool({ connectError });
    const pg = new PgClient(() => fake.pool as any);

    let caught: unknown = null;
    try { await pg.connect("postgres://ignored"); } catch (e) { caught = e; }

    ok(caught === connectError, `original connect error must be propagated; got ${String(caught)}`);
    ok(fake.connectCalls.n === 1, `pool.connect() must be called exactly once; got ${fake.connectCalls.n}`);
    ok(fake.endCalls.n === 1, `pool.end() must be called exactly once; got ${fake.endCalls.n}`);
    ok(fake.releaseCalls.n === 0, `client.release() must not be called; got ${fake.releaseCalls.n}`);
    ok(pg.isConnected() === false, "client must remain disconnected after failed connect()");
    return `connect=1 end=1 release=0 disconnected`;
  });

  // ---------------------------------------------------------------
  // Test B - validation query rejects
  // ---------------------------------------------------------------
  await test("263A-B", "SELECT 1 failure releases client, closes pool, preserves error", async () => {
    const validationError = new Error("B: SELECT 1 failed");
    const fake = makeFakePool({ validationError });
    const pg = new PgClient(() => fake.pool as any);

    let caught: unknown = null;
    try { await pg.connect("postgres://ignored"); } catch (e) { caught = e; }

    ok(caught === validationError, `original validation error must be propagated; got ${String(caught)}`);
    ok(fake.connectCalls.n === 1, `pool.connect() must be called exactly once; got ${fake.connectCalls.n}`);
    ok(fake.releaseCalls.n === 1, `client.release() must be called exactly once; got ${fake.releaseCalls.n}`);
    ok(fake.endCalls.n === 1, `pool.end() must be called exactly once; got ${fake.endCalls.n}`);
    ok(pg.isConnected() === false, "client must remain disconnected after failed validation");
    return `connect=1 release=1 end=1 disconnected`;
  });

  // ---------------------------------------------------------------
  // Test C - validation fails AND pool.end() also rejects
  // ---------------------------------------------------------------
  await test("263A-C", "cleanup failure does not replace original validation error", async () => {
    const validationError = new Error("C: SELECT 1 failed");
    const endError = new Error("C: pool.end() failed");
    const fake = makeFakePool({ validationError, endError });
    const pg = new PgClient(() => fake.pool as any);

    let caught: unknown = null;
    try { await pg.connect("postgres://ignored"); } catch (e) { caught = e; }

    ok(caught === validationError,
       `original validation error must be preserved, not replaced by cleanup error; got ${String(caught)}`);
    ok(fake.connectCalls.n === 1, `pool.connect() must be called exactly once; got ${fake.connectCalls.n}`);
    ok(fake.releaseCalls.n === 1, `client.release() must be called exactly once; got ${fake.releaseCalls.n}`);
    ok(fake.endCalls.n === 1, `pool.end() must be attempted exactly once; got ${fake.endCalls.n}`);
    ok(pg.isConnected() === false, "client must remain disconnected after failed validation + cleanup");
    return `connect=1 release=1 end=1 (end rejected) original preserved`;
  });

  // ---------------------------------------------------------------
  // Test D - successful initialization and close
  // ---------------------------------------------------------------
  await test("263A-D", "successful connect: marked connected, client released, close() closes pool", async () => {
    const fake = makeFakePool({});
    const pg = new PgClient(() => fake.pool as any);

    await pg.connect("postgres://ignored");

    ok(pg.isConnected() === true, "client must be connected after successful validation");
    ok(fake.connectCalls.n === 1, `pool.connect() must be called exactly once; got ${fake.connectCalls.n}`);
    ok(fake.releaseCalls.n === 1, `validation client must be released exactly once; got ${fake.releaseCalls.n}`);
    ok(fake.endCalls.n === 0, `pool must NOT be closed during successful connect; got ${fake.endCalls.n}`);

    // Idempotent connect: second call is a no-op because this.pool is set.
    await pg.connect("postgres://ignored");
    ok(fake.connectCalls.n === 1, `second connect() must be a no-op; got ${fake.connectCalls.n}`);
    ok(fake.endCalls.n === 0, `second connect() must not close pool; got ${fake.endCalls.n}`);

    // close() releases the active pool.
    await pg.close();
    ok(pg.isConnected() === false, "client must be disconnected after close()");
    ok(fake.endCalls.n === 1, `close() must call pool.end() exactly once; got ${fake.endCalls.n}`);

    // Repeated close() is a no-op.
    await pg.close();
    ok(fake.endCalls.n === 1, `repeated close() must be a no-op; got ${fake.endCalls.n}`);

    return `connect=1 release=1 end=1 after close(); disconnected`;
  });

  // ---------------------------------------------------------------
  // Test E - concurrent connect() calls share one initialization.
  // ---------------------------------------------------------------
  await test("263A-E", "concurrent connect() calls share one pool initialization", async () => {
    let resolveClient!: (client: FakeClient) => void;
    const connectGate = new Promise<FakeClient>((resolve) => {
      resolveClient = resolve;
    });

    const counters = { factory: 0, connect: 0, release: 0, end: 0 };
    const client: FakeClient = {
      async query(_sql: string) {
        return { rowCount: 1, rows: [{ "?column?": 1 }] };
      },
      release() { counters.release++; },
    };
    const pool: FakePool = {
      connect() {
        counters.connect++;
        return connectGate;
      },
      async end() { counters.end++; },
      async query(_sql: string, _params?: unknown[]) {
        return { rows: [], rowCount: 0 };
      },
    };

    const pg = new PgClient(() => {
      counters.factory++;
      return pool as any;
    });

    const first = pg.connect("postgres://ignored");
    const second = pg.connect("postgres://ignored");

    ok(counters.factory === 1, `pool factory must run once; got ${counters.factory}`);
    ok(counters.connect === 1, `pool.connect() must run once while pending; got ${counters.connect}`);

    resolveClient(client);
    await Promise.all([first, second]);

    ok(pg.isConnected(), "client must be connected after shared initialization");
    ok(counters.factory === 1, `pool factory must run once total; got ${counters.factory}`);
    ok(counters.connect === 1, `pool.connect() must run once total; got ${counters.connect}`);
    ok(counters.release === 1, `validation client must be released once; got ${counters.release}`);
    ok(counters.end === 0, `active pool must not be closed; got ${counters.end}`);

    await pg.close();
    ok(counters.end === 1, `close() must close the shared pool once; got ${counters.end}`);
    return "two callers shared one initialization; one pool closed once";
  });

  // ---------------------------------------------------------------
  // Test F - close() during pending initialization closes the pool.
  // ---------------------------------------------------------------
  await test("263A-F", "close() waits for pending initialization and closes its pool", async () => {
    let resolveClient!: (client: FakeClient) => void;
    const connectGate = new Promise<FakeClient>((resolve) => {
      resolveClient = resolve;
    });

    const counters = { connect: 0, release: 0, end: 0 };
    const client: FakeClient = {
      async query(_sql: string) {
        return { rowCount: 1, rows: [{ "?column?": 1 }] };
      },
      release() { counters.release++; },
    };
    const pool: FakePool = {
      connect() {
        counters.connect++;
        return connectGate;
      },
      async end() { counters.end++; },
      async query(_sql: string, _params?: unknown[]) {
        return { rows: [], rowCount: 0 };
      },
    };

    const pg = new PgClient(() => pool as any);
    const connecting = pg.connect("postgres://ignored");
    const closing = pg.close();

    ok(counters.end === 0, "close() must wait instead of closing before initialization settles");

    resolveClient(client);
    await Promise.all([connecting, closing]);

    ok(counters.connect === 1, `pool.connect() must run once; got ${counters.connect}`);
    ok(counters.release === 1, `validation client must be released once; got ${counters.release}`);
    ok(counters.end === 1, `pool must be closed exactly once; got ${counters.end}`);
    ok(!pg.isConnected(), "client must remain disconnected after close() completes");

    await pg.close();
    ok(counters.end === 1, `repeated close() must not close again; got ${counters.end}`);
    return "close waited for initialization; pool closed once; disconnected";
  });
  const failed = rows.filter((r) => r.result === "FAIL");
  console.log(`\n${rows.length} checks, ${failed.length} failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });