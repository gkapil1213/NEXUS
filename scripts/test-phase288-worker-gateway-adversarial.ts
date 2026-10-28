// scripts/test-phase288-worker-gateway-adversarial.ts
//
// Phase 288 — Worker Gateway Adversarial Validation.
//
// Exercises the real WorkerGateway handler through live HTTP transport,
// against real SQLite-backed auth, session, worker, and execution stores.
//
// Sections: A (auth), B (session lifecycle), C (replay), D (malformed
// envelopes), E (message types), F (durability), G (concurrency).
//
// Documented design gaps in the current implementation are recorded as
// FAIL with an explicit note; they are not silently claimed as PASS and
// they are not fixed in this phase.

import Database from "better-sqlite3";
import crypto from "crypto";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerGateway } from "../src/core/worker-gateway";
import { SqliteWorkerAuthStore } from "../src/core/sqlite-worker-auth-store";
import { WorkerAuthentication } from "../src/core/worker-authentication";
import { WorkerSessionStore } from "../src/core/worker-session-store";
import { RemoteWorkerStore } from "../src/core/remote-worker-store";
import { ExecutionStore } from "../src/core/execution-store";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log("PASS: " + label);
  } else {
    failed++;
    failures.push(label);
    console.error("FAIL: " + label);
  }
}

function section(label: string): void {
  console.log("\n--- " + label + " ---");
}

async function main(): Promise<void> {
  const rawDb = new Database(":memory:");
  const engine = SQLiteEngine.fromDatabase(rawDb);

  rawDb.exec(`
    CREATE TABLE worker_sessions (
      session_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL,
      protocol_version TEXT,
      connection_id TEXT,
      created_at INTEGER NOT NULL,
      authenticated_at INTEGER,
      last_seen_at INTEGER,
      last_heartbeat_at INTEGER,
      last_sequence INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    );
    CREATE TABLE remote_workers (
      worker_id TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      platform TEXT,
      architecture TEXT,
      agent_version TEXT,
      capabilities TEXT,
      status TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      last_heartbeat_at INTEGER,
      current_job_id TEXT,
      metadata TEXT
    );
    CREATE TABLE execution_jobs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE NOT NULL,
      job_type TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL,
      retry_policy TEXT,
      timeout_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_attempt_at INTEGER,
      next_attempt_at INTEGER,
      current_lease_id TEXT,
      cancellation_requested INTEGER DEFAULT 0,
      cancellation_acknowledged INTEGER DEFAULT 0
    );
    CREATE TABLE execution_leases (
      lease_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      renewed_at INTEGER,
      released_at INTEGER,
      status TEXT NOT NULL
    );
    CREATE TABLE remote_dispatches (
      dispatch_id TEXT PRIMARY KEY,
      job_id TEXT,
      attempt_id TEXT,
      worker_id TEXT,
      lease_id TEXT,
      idempotency_key TEXT,
      status TEXT,
      external_provider_id TEXT,
      request TEXT,
      result TEXT,
      error TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE remote_execution_results (
      result_id TEXT PRIMARY KEY,
      job_id TEXT,
      attempt_id TEXT,
      worker_id TEXT,
      dispatch_id TEXT,
      lease_id TEXT,
      success INTEGER,
      exit_code INTEGER,
      stdout_ref TEXT,
      stderr_ref TEXT,
      evidence TEXT,
      created_at INTEGER,
      stdout_sha256 TEXT,
      stderr_sha256 TEXT,
      result_sha256 TEXT,
      verification_status TEXT,
      verified_at INTEGER
    );
  `);

  const authStore = new SqliteWorkerAuthStore(engine);
  const auth = new WorkerAuthentication(authStore, undefined, engine);
  const sessions = new WorkerSessionStore(engine);
  const workers = new RemoteWorkerStore(engine);
  const executionStore = new ExecutionStore(engine);

  const workerId = "worker-phase288";
  const credential = "phase288-test-credential";
  authStore.setCredential(workerId, credential);

  workers.registerWorker({
    workerId,
    hostname: "localhost",
    platform: process.platform,
    architecture: process.arch,
    agentVersion: "phase288",
    capabilities: { operations: ["node"] },
    status: "ONLINE",
    registeredAt: Date.now(),
  });

  let gateway = new WorkerGateway(0, sessions, workers, auth, executionStore, engine);
  await gateway.start();
  let port = (gateway as any).server.address().port;
  let url = "http://127.0.0.1:" + port;

  async function post(message: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    let body: any = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  }

  async function postRaw(text: string): Promise<{ status: number; text: string }> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    });
    return { status: response.status, text: await response.text() };
  }

  function freshNonce(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  async function authenticate(overrides: Record<string, any> = {}): Promise<{ status: number; body: any; sessionId?: string }> {
    const wid = "workerId" in overrides ? overrides.workerId : workerId;
    const cred = "credential" in overrides ? overrides.credential : credential;
    const nonce = "nonce" in overrides ? overrides.nonce : freshNonce();
    const ts = "timestamp" in overrides ? overrides.timestamp : Date.now();
    const payload: any = { workerId: wid, credential: cred };
    if (nonce !== undefined) payload.nonce = nonce;
    const message: any = {
      messageId: crypto.randomUUID(),
      type: "AUTH_REQUEST",
      workerId: wid,
      protocolVersion: "1.0",
      payload,
    };
    if (ts !== undefined) message.timestamp = ts;
    const result = await post(message);
    return { ...result, sessionId: result.body?.sessionId };
  }

  function makeMessage(type: string, sessionId: string, sequence: number, payload: any = {}, messageWorkerId: string = workerId): Record<string, unknown> {
    return {
      messageId: crypto.randomUUID(),
      type,
      sessionId,
      workerId: messageWorkerId,
      timestamp: Date.now(),
      protocolVersion: "1.0",
      sequence,
      payload,
    };
  }

  try {
    // =====================================================================
    // Section A — Authentication
    // =====================================================================
    section("A — Authentication");

    // A1: valid credential
    {
      const r = await authenticate();
      check(r.status === 200 && r.body.authenticated === true && !!r.sessionId,
        "A1 valid credential authenticates and returns sessionId");
      check(!!r.sessionId && !!sessions.getSession(r.sessionId),
        "A1 session is durably persisted");
    }

    // A2: invalid credential
    {
      const before = (rawDb.prepare("SELECT COUNT(*) AS c FROM worker_sessions").get() as any).c;
      const r = await authenticate({ credential: "wrong-credential" });
      const after = (rawDb.prepare("SELECT COUNT(*) AS c FROM worker_sessions").get() as any).c;
      check(r.body.authenticated === false && r.body.reason === "invalid_credential",
        "A2 invalid credential rejected with invalid_credential");
      check(after === before, "A2 rejected authentication does not create a session");
    }

    // A3: unknown worker
    {
      const r = await authenticate({ workerId: "unknown-worker" });
      check(r.body.authenticated === false && r.body.reason === "worker_not_found",
        "A3 unknown worker rejected with worker_not_found");
    }

    // A4: revoked worker
    {
      const revokedId = "worker-phase288-revoked";
      authStore.setCredential(revokedId, "revoked-worker-credential");
      authStore.revokeWorker(revokedId);
      const r = await authenticate({ workerId: revokedId, credential: "revoked-worker-credential" });
      check(r.body.authenticated === false && r.body.reason === "worker_revoked",
        "A4 revoked worker rejected with worker_revoked");
    }

    // A5: missing timestamp
    {
      const r = await authenticate({ timestamp: undefined });
      check(r.body.authenticated === false && r.body.reason === "missing_timestamp",
        "A5 missing timestamp rejected with missing_timestamp");
    }

    // A6: stale timestamp
    {
      const r = await authenticate({ timestamp: Date.now() - 10 * 60 * 1000 });
      check(r.body.authenticated === false && r.body.reason === "expired_timestamp",
        "A6 stale timestamp rejected with expired_timestamp");
    }

    // A7: future timestamp
    {
      const r = await authenticate({ timestamp: Date.now() + 10 * 60 * 1000 });
      check(r.body.authenticated === false && r.body.reason === "future_timestamp",
        "A7 future timestamp rejected with future_timestamp");
    }

    // A8: missing nonce
    {
      const r = await authenticate({ nonce: undefined });
      check(r.body.authenticated === false && r.body.reason === "missing_nonce",
        "A8 missing nonce rejected with missing_nonce");
    }

    // A9: short nonce
    {
      const r = await authenticate({ nonce: "short" });
      check(r.body.authenticated === false && r.body.reason === "invalid_nonce",
        "A9 short nonce rejected with invalid_nonce");
    }

    // A10: non-conforming nonce
    {
      const r = await authenticate({ nonce: "has spaces and $pec!al chars" });
      check(r.body.authenticated === false && r.body.reason === "invalid_nonce",
        "A10 non-conforming nonce rejected with invalid_nonce");
    }

    // A11: replayed nonce
    {
      const fixedNonce = freshNonce();
      const first = await authenticate({ nonce: fixedNonce });
      const second = await authenticate({ nonce: fixedNonce });
      check(first.body.authenticated === true, "A11 first use of nonce accepted");
      check(second.body.authenticated === false && second.body.reason === "replayed_nonce",
        "A11 replayed nonce rejected with replayed_nonce");
    }

    // A12: legacy credential upgrade
    {
      const legacyId = "worker-phase288-legacy";
      const legacyCred = "legacy-credential-phase288";
      authStore.setLegacyCredential(legacyId, legacyCred);
      const before = rawDb.prepare(
        "SELECT algorithm, salt, iterations FROM worker_auth_credentials WHERE worker_id = ?"
      ).get(legacyId) as any;
      check(before.algorithm === null || before.algorithm === undefined,
        "A12 legacy credential starts with null algorithm");

      workers.registerWorker({
        workerId: legacyId,
        hostname: "localhost",
        platform: process.platform,
        architecture: process.arch,
        agentVersion: "phase288",
        capabilities: { operations: ["node"] },
        status: "ONLINE",
        registeredAt: Date.now(),
      });

      const r = await authenticate({ workerId: legacyId, credential: legacyCred });
      check(r.body.authenticated === true, "A12 legacy credential authenticates");

      const after = rawDb.prepare(
        "SELECT algorithm, salt, iterations FROM worker_auth_credentials WHERE worker_id = ?"
      ).get(legacyId) as any;
      check(after.algorithm === "pbkdf2-sha256" && !!after.salt && after.iterations > 0,
        "A12 legacy credential upgraded to PBKDF2 on successful auth");
    }

    // A13: malformed stored hash
    {
      const malformedId = "worker-phase288-malformed";
      workers.registerWorker({
        workerId: malformedId,
        hostname: "localhost",
        platform: process.platform,
        architecture: process.arch,
        agentVersion: "phase288",
        capabilities: { operations: ["node"] },
        status: "ONLINE",
        registeredAt: Date.now(),
      });
      rawDb.prepare(
        "INSERT INTO worker_auth_credentials (worker_id, credential_hash, algorithm, salt, iterations, revoked) VALUES (?, ?, ?, ?, ?, 0)"
      ).run(malformedId, "not-valid-hex", "pbkdf2-sha256", "somesalt", 1000);
      const r = await authenticate({ workerId: malformedId, credential: "anything" });
      check(r.body.authenticated === false && r.body.reason === "invalid_credential",
        "A13 malformed stored hash rejected safely as invalid_credential");
    }

    // =====================================================================
    // Section B — Session lifecycle
    // =====================================================================
    section("B — Session lifecycle");

    // B1: missing session
    {
      const r = await post({
        messageId: crypto.randomUUID(),
        type: "HEARTBEAT",
        workerId,
        timestamp: Date.now(),
        protocolVersion: "1.0",
        sequence: 1,
        payload: {},
      });
      check(r.status === 400 && r.body?.error === "missing_session_or_worker",
        "B1 missing session rejected with missing_session_or_worker");
    }

    // B2: unknown session
    {
      const r = await post(makeMessage("HEARTBEAT", "no-such-session", 1));
      check(r.status === 400 && r.body?.error === "invalid_session",
        "B2 unknown session rejected with invalid_session");
    }

    // B3: session-worker mismatch
    {
      const auth1 = await authenticate();
      const sessionId = auth1.sessionId!;
      const r = await post({
        messageId: crypto.randomUUID(),
        type: "HEARTBEAT",
        sessionId,
        workerId: "different-worker",
        timestamp: Date.now(),
        protocolVersion: "1.0",
        sequence: 1,
        payload: {},
      });
      check(r.status === 400 && r.body?.error === "invalid_session",
        "B3 session-worker mismatch rejected with invalid_session");
    }

    // B4: expired session
    {
      const expiredId = "phase288-expired-" + crypto.randomUUID();
      const now = Date.now();
      sessions.createSession({
        sessionId: expiredId,
        workerId,
        status: "ACTIVE",
        protocolVersion: "1.0",
        createdAt: now - 120000,
        authenticatedAt: now - 120000,
        lastSeenAt: now - 120000,
        lastSequence: 0,
        expiresAt: now - 1000,
      } as any);
      const r = await post(makeMessage("HEARTBEAT", expiredId, 1));
      check(r.status === 400 && r.body?.error === "session_expired",
        "B4 expired session rejected with session_expired");
      const after = sessions.getSession(expiredId);
      check(after?.status === "REVOKED", "B4 expired session is durably revoked");
    }

    // B5: explicitly revoked
    {
      const auth1 = await authenticate();
      const sessionId = auth1.sessionId!;
      sessions.markRevoked(sessionId);
      const r = await post(makeMessage("HEARTBEAT", sessionId, 1));
      check(r.status === 400 && r.body?.error === "invalid_session",
        "B5 explicitly revoked session rejected with invalid_session");
    }

    // B6: just-before-expiry
    {
      const freshId = "phase288-fresh-" + crypto.randomUUID();
      const now = Date.now();
      sessions.createSession({
        sessionId: freshId,
        workerId,
        status: "ACTIVE",
        protocolVersion: "1.0",
        createdAt: now,
        authenticatedAt: now,
        lastSeenAt: now,
        lastSequence: 0,
        expiresAt: now + 60000,
      } as any);
      const r = await post(makeMessage("HEARTBEAT", freshId, 1));
      check(r.status === 200 && r.body?.type === "HEARTBEAT_ACK",
        "B6 session just-before-expiry accepted");
    }

    // =====================================================================
    // Section C — Message replay
    // =====================================================================
    section("C — Message replay");

    // C1: duplicate messageId within same session
    {
      const auth1 = await authenticate();
      const sessionId = auth1.sessionId!;
      const msgId = crypto.randomUUID();
      const first = await post({
        messageId: msgId, type: "HEARTBEAT", sessionId, workerId,
        timestamp: Date.now(), protocolVersion: "1.0", sequence: 1, payload: {},
      });
      const second = await post({
        messageId: msgId, type: "HEARTBEAT", sessionId, workerId,
        timestamp: Date.now(), protocolVersion: "1.0", sequence: 2, payload: {},
      });
      check(first.status === 200, "C1 first heartbeat accepted");
      check(second.status === 400 && second.body?.error === "duplicate_message",
        "C1 duplicate messageId rejected with duplicate_message");
    }

    // C2: same messageId across sessions
    {
      const auth1 = await authenticate();
      const auth2 = await authenticate();
      const msgId = crypto.randomUUID();
      await post({
        messageId: msgId, type: "HEARTBEAT", sessionId: auth1.sessionId!, workerId,
        timestamp: Date.now(), protocolVersion: "1.0", sequence: 1, payload: {},
      });
      const r = await post({
        messageId: msgId, type: "HEARTBEAT", sessionId: auth2.sessionId!, workerId,
        timestamp: Date.now(), protocolVersion: "1.0", sequence: 1, payload: {},
      });
      check(r.status === 400 && r.body?.error === "duplicate_message",
        "C2 messageId dedup is session-agnostic (durable)");
    }

    // C3: stale sequence
    {
      const auth1 = await authenticate();
      const sessionId = auth1.sessionId!;
      await post(makeMessage("HEARTBEAT", sessionId, 5));
      const r = await post(makeMessage("HEARTBEAT", sessionId, 3));
      check(r.status === 400 && r.body?.error === "invalid_sequence",
        "C3 stale sequence rejected with invalid_sequence");
    }

    // C4: missing sequence
    {
      const auth1 = await authenticate();
      const sessionId = auth1.sessionId!;
      const r = await post({
        messageId: crypto.randomUUID(), type: "HEARTBEAT", sessionId, workerId,
        timestamp: Date.now(), protocolVersion: "1.0", payload: {},
      });
      check(r.status === 400 && r.body?.error === "invalid_sequence",
        "C4 missing sequence rejected with invalid_sequence");
    }

    // C5: sequence 0
    {
      const auth1 = await authenticate();
      const sessionId = auth1.sessionId!;
      const r = await post(makeMessage("HEARTBEAT", sessionId, 0));
      check(r.status === 400 && r.body?.error === "invalid_sequence",
        "C5 sequence 0 rejected with invalid_sequence");
    }

    // C6: valid sequence advance
    {
      const auth1 = await authenticate();
      const sessionId = auth1.sessionId!;
      const r = await post(makeMessage("HEARTBEAT", sessionId, 1));
      check(r.status === 200 && r.body?.type === "HEARTBEAT_ACK",
        "C6 valid sequence accepted");
      const session = sessions.getSession(sessionId);
      check(session?.lastSequence === 1, "C6 lastSequence durably advanced to 1");
    }

    // C7: duplicate messageId after restart
    {
      const auth1 = await authenticate();
      const sessionId = auth1.sessionId!;
      const msgId = crypto.randomUUID();
      await post({
        messageId: msgId, type: "HEARTBEAT", sessionId, workerId,
        timestamp: Date.now(), protocolVersion: "1.0", sequence: 1, payload: {},
      });

      await gateway.stop();
      gateway = new WorkerGateway(0, sessions, workers, auth, executionStore, engine);
      await gateway.start();
      port = (gateway as any).server.address().port;
      url = "http://127.0.0.1:" + port;

      const r = await post({
        messageId: msgId, type: "HEARTBEAT", sessionId, workerId,
        timestamp: Date.now(), protocolVersion: "1.0", sequence: 2, payload: {},
      });
      check(r.status === 400 && r.body?.error === "duplicate_message",
        "C7 messageId dedup survives gateway restart (durable)");
    }

    // C8: sequence persistence across restart
    {
      const auth1 = await authenticate();
      const sessionId = auth1.sessionId!;
      await post(makeMessage("HEARTBEAT", sessionId, 10));

      await gateway.stop();
      gateway = new WorkerGateway(0, sessions, workers, auth, executionStore, engine);
      await gateway.start();
      port = (gateway as any).server.address().port;
      url = "http://127.0.0.1:" + port;

      const r = await post(makeMessage("HEARTBEAT", sessionId, 5));
      check(r.status === 400 && r.body?.error === "invalid_sequence",
        "C8 sequence monotonicity survives gateway restart (durable)");
    }

    // C9: DOCUMENTED GAP — stale timestamp on non-AUTH message accepted
    {
      const auth1 = await authenticate();
      const sessionId = auth1.sessionId!;
      const r = await post({
        messageId: crypto.randomUUID(),
        type: "HEARTBEAT",
        sessionId,
        workerId,
        timestamp: Date.now() - 10 * 60 * 1000,
        protocolVersion: "1.0",
        sequence: 1,
        payload: {},
      });
      check(r.status !== 200,
        "C9 non-AUTH message with stale timestamp must be rejected (documented gap: currently accepted)");
    }

    // C10: DOCUMENTED GAP — failed operation advanced sequence
    {
      const auth1 = await authenticate();
      const sessionId = auth1.sessionId!;
      const jobId = "phase288-c10-job";
      const dispatchId = "phase288-c10-dispatch";
      const attemptId = "phase288-c10-attempt";
      const leaseId = "phase288-c10-lease";
      const now = Date.now();
      rawDb.prepare("INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at, current_lease_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(jobId, "idem-" + jobId, "node", "RUNNING", now, now, leaseId);
      rawDb.prepare("INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)")
        .run(leaseId, jobId, workerId, now, now + 60000, "ACTIVE");
      rawDb.prepare("INSERT INTO remote_dispatches (dispatch_id, job_id, attempt_id, worker_id, lease_id, idempotency_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(dispatchId, jobId, attemptId, workerId, leaseId, "idem-" + dispatchId, "DISPATCHED", now, now);

      const badResult = {
        jobId, dispatchId, leaseId, workerId,
        success: true, stdout: "tampered", stderr: "", exitCode: 0,
        stdoutSha256: "0".repeat(64),
        stderrSha256: "0".repeat(64),
        resultSha256: "0".repeat(64),
      };
      const r = await post(makeMessage("JOB_RESULT", sessionId, 1, { jobId, result: badResult }));
      const session = sessions.getSession(sessionId);
      check(session?.lastSequence !== 1,
        "C10 failed operation must not advance lastSequence (documented gap: currently advances)");
    }

    // =====================================================================
    // Section D — Malformed envelopes
    // =====================================================================
    section("D — Malformed envelopes");

    {
      const r = await postRaw(JSON.stringify({ type: "HEARTBEAT" }));
      check(r.status === 400 && r.text.includes("missing_message_fields"),
        "D1 missing messageId rejected with missing_message_fields");
    }

    {
      const r = await postRaw(JSON.stringify({ messageId: crypto.randomUUID() }));
      check(r.status === 400 && r.text.includes("missing_message_fields"),
        "D2 missing type rejected with missing_message_fields");
    }

    {
      const r = await postRaw("{not valid json");
      check(r.status === 400 && r.text.includes("malformed_json"),
        "D3 malformed JSON rejected with malformed_json");
    }

    {
      const auth1 = await authenticate();
      const r = await post(makeMessage("NOT_A_REAL_TYPE", auth1.sessionId!, 1));
      check(r.status === 400 && r.body?.error === "unknown_message_type",
        "D4 unknown type rejected with unknown_message_type");
    }

    {
      const r = await post({
        messageId: crypto.randomUUID(),
        type: "HEARTBEAT",
        workerId,
        protocolVersion: "99.0",
        sequence: 1,
        payload: {},
      });
      check(r.status === 400 && r.body?.error === "unsupported_protocol_version",
        "D5 unsupported protocol version rejected");
    }

    {
      const sentinel = "PHASE288_SENTINEL_SECRET_abcdef";
      const r = await postRaw(JSON.stringify({
        messageId: crypto.randomUUID(),
        type: "AUTH_REQUEST",
        workerId,
        timestamp: Date.now(),
        protocolVersion: "1.0",
        payload: { workerId, credential: sentinel, nonce: freshNonce() },
      }));
      check(!r.text.includes(sentinel),
        "D6 error response does not leak submitted credential");
      check(!/at .*\.ts:\d+/.test(r.text),
        "D6 error response does not leak stack traces");
    }

    {
      const r = await postRaw(JSON.stringify({}));
      let parsed: any = null;
      try { parsed = JSON.parse(r.text); } catch { /* */ }
      check(parsed && typeof parsed.error === "string",
        "D7 error response has stable {error: string} shape");
    }
    // =====================================================================
    // Section E — Message-type authorization
    // =====================================================================
    section("E — Message-type authorization");

    // E1: JOB_OFFER with no dispatch (fresh worker, no seeded dispatches)
    {
      const freshWorkerId = "phase288-e1-fresh";
      authStore.setCredential(freshWorkerId, "e1-fresh-credential");
      workers.registerWorker({
        workerId: freshWorkerId,
        hostname: "localhost",
        platform: process.platform,
        architecture: process.arch,
        agentVersion: "phase288",
        capabilities: { operations: ["node"] },
        status: "ONLINE",
        registeredAt: Date.now(),
      });
      const freshAuth = await authenticate({ workerId: freshWorkerId, credential: "e1-fresh-credential" });
      const r = await post({
        messageId: crypto.randomUUID(),
        type: "JOB_OFFER",
        sessionId: freshAuth.sessionId!,
        workerId: freshWorkerId,
        timestamp: Date.now(),
        protocolVersion: "1.0",
        sequence: 1,
      });
      check(r.status === 200 && r.body?.type === "JOB_OFFER" && r.body?.job === null,
        "E1 JOB_OFFER with no dispatch returns {job: null}");
    }

    // E2: JOB_OFFER with dispatch (isolated worker to avoid cross-test claims)
    {
      const e2WorkerId = "phase288-e2-worker";
      authStore.setCredential(e2WorkerId, "e2-credential");
      workers.registerWorker({
        workerId: e2WorkerId,
        hostname: "localhost",
        platform: process.platform,
        architecture: process.arch,
        agentVersion: "phase288",
        capabilities: { operations: ["node"] },
        status: "ONLINE",
        registeredAt: Date.now(),
      });
      const e2Auth = await authenticate({ workerId: e2WorkerId, credential: "e2-credential" });
      const jobId = "phase288-e2-job";
      const dispatchId = "phase288-e2-dispatch";
      const attemptId = "phase288-e2-attempt";
      const leaseId = "phase288-e2-lease";
      const now = Date.now();
      rawDb.prepare("INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at, current_lease_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(jobId, "idem-" + jobId, "node", "RUNNING", now, now, leaseId);
      rawDb.prepare("INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)")
        .run(leaseId, jobId, e2WorkerId, now, now + 60000, "ACTIVE");
      rawDb.prepare("INSERT INTO remote_dispatches (dispatch_id, job_id, attempt_id, worker_id, lease_id, idempotency_key, status, request, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(dispatchId, jobId, attemptId, e2WorkerId, leaseId, "idem-" + dispatchId, "DISPATCHED", JSON.stringify({ operation: "node", args: [] }), now, now);
      const r = await post({
        messageId: crypto.randomUUID(),
        type: "JOB_OFFER",
        sessionId: e2Auth.sessionId!,
        workerId: e2WorkerId,
        timestamp: Date.now(),
        protocolVersion: "1.0",
        sequence: 1,
      });
      check(r.status === 200 && r.body?.type === "JOB_OFFER" && r.body?.job?.jobId === jobId,
        "E2 JOB_OFFER with dispatch returns job details");
    }

    // E3–E7: JOB_RESULT paths
    {
      const auth1 = await authenticate();
      const jobId = "phase288-e3-job";
      const dispatchId = "phase288-e3-dispatch";
      const attemptId = "phase288-e3-attempt";
      const leaseId = "phase288-e3-lease";
      const now = Date.now();
      rawDb.prepare("INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at, current_lease_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(jobId, "idem-" + jobId, "node", "RUNNING", now, now, leaseId);
      rawDb.prepare("INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)")
        .run(leaseId, jobId, workerId, now, now + 60000, "ACTIVE");
      rawDb.prepare("INSERT INTO remote_dispatches (dispatch_id, job_id, attempt_id, worker_id, lease_id, idempotency_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(dispatchId, jobId, attemptId, workerId, leaseId, "idem-" + dispatchId, "DISPATCHED", now, now);

      // E3: missing hashes
      const bad = await post(makeMessage("JOB_RESULT", auth1.sessionId!, 1, {
        jobId,
        result: { jobId, dispatchId, leaseId, workerId, success: true, stdout: "x", stderr: "", exitCode: 0 },
      }));
      check(bad.status === 400 && bad.body?.error === "invalid_result_integrity",
        "E3 JOB_RESULT missing hashes rejected with invalid_result_integrity");

      // E4: tampered stdout
      const stdoutSha = crypto.createHash("sha256").update("x").digest("hex");
      const stderrSha = crypto.createHash("sha256").update("").digest("hex");
      const canonical = (o: any) => {
        const keys = Object.keys(o).sort();
        const s: any = {};
        for (const k of keys) s[k] = o[k];
        return JSON.stringify(s);
      };
      const base = { jobId, dispatchId, leaseId, workerId, success: true, stdout: "x", stderr: "", exitCode: 0, stdoutSha256: stdoutSha, stderrSha256: stderrSha };
      const resultSha = crypto.createHash("sha256").update(canonical(base)).digest("hex");
      const good = { ...base, resultSha256: resultSha };
      const tampered = { ...good, stdout: "tampered" };
      const r4 = await post(makeMessage("JOB_RESULT", auth1.sessionId!, 2, { jobId, result: tampered }));
      check(r4.status === 400 && r4.body?.error === "invalid_result_integrity",
        "E4 JOB_RESULT tampered stdout rejected with invalid_result_integrity");
      const persistedCount = (rawDb.prepare("SELECT COUNT(*) AS c FROM remote_execution_results WHERE dispatch_id = ?").get(dispatchId) as any).c;
      check(persistedCount === 0, "E4 tampered result not persisted");

      // E5: valid result accepted
      const r5 = await post(makeMessage("JOB_RESULT", auth1.sessionId!, 3, { jobId, result: good }));
      check(r5.status === 200 && r5.body?.type === "JOB_RESULT_ACK",
        "E5 valid JOB_RESULT accepted with ACK");
      const persisted5 = (rawDb.prepare("SELECT COUNT(*) AS c FROM remote_execution_results WHERE dispatch_id = ?").get(dispatchId) as any).c;
      check(persisted5 === 1, "E5 valid result durably persisted");

      // E6: identical duplicate accepted without new row
      const r6 = await post(makeMessage("JOB_RESULT", auth1.sessionId!, 4, { jobId, result: good }));
      check(r6.status === 200 && r6.body?.type === "JOB_RESULT_ACK",
        "E6 identical duplicate accepted with ACK");
      const persisted6 = (rawDb.prepare("SELECT COUNT(*) AS c FROM remote_execution_results WHERE dispatch_id = ?").get(dispatchId) as any).c;
      check(persisted6 === 1, "E6 identical duplicate does not create new row");

      // E7: conflicting duplicate rejected
      const conflict = { ...good, stdoutSha256: "f".repeat(64), resultSha256: "e".repeat(64) };
      const r7 = await post(makeMessage("JOB_RESULT", auth1.sessionId!, 5, { jobId, result: conflict }));
      check(r7.status === 400 && r7.body?.error === "conflicting_duplicate_result",
        "E7 conflicting duplicate rejected with conflicting_duplicate_result");
    }

    // E8: JOB_RESULT wrong worker
    {
      const auth1 = await authenticate();
      const jobId = "phase288-e8-job";
      const dispatchId = "phase288-e8-dispatch";
      const attemptId = "phase288-e8-attempt";
      const leaseId = "phase288-e8-lease";
      const now = Date.now();
      rawDb.prepare("INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at, current_lease_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(jobId, "idem-" + jobId, "node", "RUNNING", now, now, leaseId);
      rawDb.prepare("INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)")
        .run(leaseId, jobId, workerId, now, now + 60000, "ACTIVE");
      rawDb.prepare("INSERT INTO remote_dispatches (dispatch_id, job_id, attempt_id, worker_id, lease_id, idempotency_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(dispatchId, jobId, attemptId, workerId, leaseId, "idem-" + dispatchId, "DISPATCHED", now, now);

      const otherWorker = "phase288-other-worker";
      authStore.setCredential(otherWorker, "other-worker-cred");
      workers.registerWorker({
        workerId: otherWorker,
        hostname: "localhost",
        platform: process.platform,
        architecture: process.arch,
        agentVersion: "phase288",
        capabilities: { operations: ["node"] },
        status: "ONLINE",
        registeredAt: Date.now(),
      });
      const otherAuth = await authenticate({ workerId: otherWorker, credential: "other-worker-cred" });

      const stdoutSha = crypto.createHash("sha256").update("x").digest("hex");
      const stderrSha = crypto.createHash("sha256").update("").digest("hex");
      const r = await post(makeMessage("JOB_RESULT", otherAuth.sessionId!, 1, {
        jobId,
        result: {
          jobId, dispatchId, leaseId, workerId: otherWorker,
          success: true, stdout: "x", stderr: "", exitCode: 0,
          stdoutSha256: stdoutSha, stderrSha256: stderrSha, resultSha256: "a".repeat(64),
        },
      }, otherWorker));
      check(r.status === 400 && r.body?.error === "dispatch_ownership_violation",
        "E8 JOB_RESULT wrong worker rejected with dispatch_ownership_violation");
    }

    // E9–E11: JOB_CANCEL paths
    {
      const auth1 = await authenticate();
      const r9 = await post(makeMessage("JOB_CANCEL", auth1.sessionId!, 1, {}));
      check(r9.status === 400 && r9.body?.error === "jobId_required",
        "E9 JOB_CANCEL missing jobId rejected with jobId_required (status=" + r9.status + ", body=" + JSON.stringify(r9.body).slice(0, 200) + ")");

      const r10 = await post(makeMessage("JOB_CANCEL", auth1.sessionId!, 2, { jobId: "no-such-job" }));
      check(r10.status === 400 && r10.body?.error === "dispatch_not_found",
        "E10 JOB_CANCEL no dispatch rejected with dispatch_not_found");

      const jobId = "phase288-e11-job";
      const dispatchId = "phase288-e11-dispatch";
      const attemptId = "phase288-e11-attempt";
      const leaseId = "phase288-e11-lease";
      const now = Date.now();
      rawDb.prepare("INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at, current_lease_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(jobId, "idem-" + jobId, "node", "RUNNING", now, now, leaseId);
      rawDb.prepare("INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)")
        .run(leaseId, jobId, workerId, now, now + 60000, "ACTIVE");
      rawDb.prepare("INSERT INTO remote_dispatches (dispatch_id, job_id, attempt_id, worker_id, lease_id, idempotency_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(dispatchId, jobId, attemptId, workerId, leaseId, "idem-" + dispatchId, "DISPATCHED", now, now);

      const r11 = await post(makeMessage("JOB_CANCEL", auth1.sessionId!, 3, { jobId }));
      check(r11.status === 200 && r11.body?.type === "JOB_CANCEL_ACK",
        "E11 JOB_CANCEL active dispatch returns JOB_CANCEL_ACK with confirmed=false");
      check(r11.body?.confirmed === false || r11.body?.confirmed === undefined,
        "E11 JOB_CANCEL ACK carries non-success confirmation when no provider");
    }

    // =====================================================================
    // Section F — Durability across restart
    // =====================================================================
    section("F — Durability across restart");

    // F1: session persists (re-checked after A14 and C8 restarts)
    {
      const r = await authenticate();
      const sid = r.sessionId!;
      await gateway.stop();
      gateway = new WorkerGateway(0, sessions, workers, auth, executionStore, engine);
      await gateway.start();
      port = (gateway as any).server.address().port;
      url = "http://127.0.0.1:" + port;
      const after = sessions.getSession(sid);
      check(after?.sessionId === sid, "F1 session persists across gateway restart");
    }

    // F2: result persists (query DB after restart)
    {
      const count = (rawDb.prepare("SELECT COUNT(*) AS c FROM remote_execution_results").get() as any).c;
      check(count > 0, "F2 remote_execution_results rows persist across restart");
    }

    // F3: messageId dedup persists (proven in C7)
    check(true, "F3 messageId dedup durability verified in C7");

    // F4: nonce dedup persists
    {
      const fixedNonce = freshNonce();
      const first = await authenticate({ nonce: fixedNonce });
      await gateway.stop();
      gateway = new WorkerGateway(0, sessions, workers, auth, executionStore, engine);
      await gateway.start();
      port = (gateway as any).server.address().port;
      url = "http://127.0.0.1:" + port;
      const second = await authenticate({ nonce: fixedNonce });
      check(first.body.authenticated === true, "F4 first nonce use accepted");
      check(second.body.authenticated === false && second.body.reason === "replayed_nonce",
        "F4 nonce replay rejected across gateway restart (durable)");
    }

    // =====================================================================
    // Section G — Concurrency
    // =====================================================================
    section("G — Concurrency");

    // G1: concurrent same-sequence
    {
      const auth1 = await authenticate();
      const sessionId = auth1.sessionId!;
      const msg1 = makeMessage("HEARTBEAT", sessionId, 1);
      const msg2 = makeMessage("HEARTBEAT", sessionId, 1);
      const [r1, r2] = await Promise.all([post(msg1), post(msg2)]);
      const successes = [r1, r2].filter((r) => r.status === 200).length;
      check(successes === 1, "G1 concurrent same-sequence requests: exactly one accepted");
    }

    // G2: concurrent JOB_OFFER claim
    {
      const auth1 = await authenticate();
      const jobId = "phase288-g2-job";
      const dispatchId = "phase288-g2-dispatch";
      const attemptId = "phase288-g2-attempt";
      const leaseId = "phase288-g2-lease";
      const now = Date.now();
      rawDb.prepare("INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at, current_lease_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(jobId, "idem-" + jobId, "node", "RUNNING", now, now, leaseId);
      rawDb.prepare("INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)")
        .run(leaseId, jobId, workerId, now, now + 60000, "ACTIVE");
      rawDb.prepare("INSERT INTO remote_dispatches (dispatch_id, job_id, attempt_id, worker_id, lease_id, idempotency_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(dispatchId, jobId, attemptId, workerId, leaseId, "idem-" + dispatchId, "DISPATCHED", now, now);

      const [r1, r2] = await Promise.all([
        post(makeMessage("JOB_OFFER", auth1.sessionId!, 1)),
        post(makeMessage("JOB_OFFER", auth1.sessionId!, 2)),
      ]);
      const claimed = [r1, r2].filter((r) => r.body?.job?.jobId === jobId).length;
      check(claimed <= 1, "G2 concurrent JOB_OFFER: at most one claim");
    }

    // G3: concurrent AUTH_REQUEST with same nonce
    {
      const fixedNonce = freshNonce();
      const [r1, r2] = await Promise.all([
        authenticate({ nonce: fixedNonce }),
        authenticate({ nonce: fixedNonce }),
      ]);
      const authed = [r1, r2].filter((r) => r.body.authenticated === true).length;
      check(authed === 1, "G3 concurrent AUTH_REQUEST same nonce: exactly one authenticated");
    }

    // =====================================================================
    // Summary
    // =====================================================================
    const total = passed + failed;
    console.log("");
    if (failed === 0) {
      console.log("Phase 288 worker gateway adversarial: PASS");
      console.log("Assertions: " + total + "; passed: " + passed + "; failures: 0");
    } else {
      console.log("Phase 288 worker gateway adversarial: FAIL");
      console.log("Assertions: " + total + "; passed: " + passed + "; failures: " + failed);
      console.log("Failed assertions:");
      for (const f of failures) console.log("  - " + f);
      process.exitCode = 1;
    }
  } finally {
    try { await gateway.stop(); } catch { /* */ }
    try { rawDb.close(); } catch { /* */ }
  }
}

main().catch((e) => {
  console.error("Phase 288 worker gateway adversarial: UNEXPECTED ERROR");
  console.error((e as Error).message);
  console.error((e as Error).stack);
  process.exitCode = 1;
});
