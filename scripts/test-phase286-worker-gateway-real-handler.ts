import Database from "better-sqlite3";
import crypto from "crypto";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerGateway } from "../src/core/worker-gateway";
import { SqliteWorkerAuthStore } from "../src/core/sqlite-worker-auth-store";
import { WorkerAuthentication } from "../src/core/worker-authentication";
import { WorkerSessionStore } from "../src/core/worker-session-store";
import { RemoteWorkerStore } from "../src/core/remote-worker-store";

let passed = 0;
let failed = 0;

function check(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log("PASS: " + label);
  } else {
    failed++;
    console.error("FAIL: " + label);
  }
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
  `);

  const authStore = new SqliteWorkerAuthStore(engine);
  const auth = new WorkerAuthentication(authStore, undefined, engine);
  const sessions = new WorkerSessionStore(engine);
  const workers = new RemoteWorkerStore(engine);

  const workerId = "worker-real-handler-test";
  const credential = "real-handler-test-credential";
  authStore.setCredential(workerId, credential);

  workers.registerWorker({
    workerId,
    hostname: "localhost",
    platform: process.platform,
    architecture: process.arch,
    agentVersion: "real-handler-test",
    capabilities: { operations: ["node"] },
    status: "ONLINE",
    registeredAt: Date.now(),
  });

  const gateway = new WorkerGateway(0, sessions, workers, auth, undefined, engine);

  try {
    await gateway.start();

    // Read the actual ephemeral port from the live HTTP server.
    const server = (gateway as any).server;
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not determine gateway HTTP port");
    }
    const url = `http://127.0.0.1:${address.port}`;

    async function post(message: Record<string, unknown>) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      });
      const body = await response.json() as Record<string, any>;
      return { status: response.status, body };
    }

    const authResponse = await post({
      messageId: "auth-real-handler-1",
      type: "AUTH_REQUEST",
      workerId,
      timestamp: Date.now(),
      protocolVersion: "1.0",
      payload: {
        workerId,
        credential,
        nonce: crypto.randomBytes(16).toString("hex"),
      },
    });

    check(authResponse.status === 200, "live AUTH_REQUEST returns HTTP 200");
    check(authResponse.body.authenticated === true, "live authentication succeeds");
    const sessionId = authResponse.body.sessionId as string;

    if (!sessionId) {
      throw new Error("Authentication did not return a session ID");
    }

    const initial = sessions.getSession(sessionId);
    check(initial?.lastSequence === 0, "authenticated session starts at sequence 0");

    const badProtocol = await post({
      messageId: "bad-protocol-1",
      type: "HEARTBEAT",
      protocolVersion: "0.0",
      sessionId,
      workerId,
      sequence: 1,
      payload: {},
    });
    check(badProtocol.status === 400, "unsupported protocol returns HTTP 400");
    check(
      badProtocol.body.error === "unsupported_protocol_version",
      "unsupported protocol returns stable error code",
    );
    check(
      sessions.getSession(sessionId)?.lastSequence === 0,
      "protocol rejection does not advance durable sequence",
    );

    const missingSession = await post({
      messageId: "missing-session-1",
      type: "HEARTBEAT",
      protocolVersion: "1.0",
      workerId,
      sequence: 1,
      payload: {},
    });
    check(missingSession.status === 400, "missing session returns HTTP 400");
    check(
      missingSession.body.error === "missing_session_or_worker",
      "missing session returns stable error code",
    );

    const invalidSession = await post({
      messageId: "invalid-session-1",
      type: "HEARTBEAT",
      protocolVersion: "1.0",
      sessionId: "no-such-session",
      workerId,
      sequence: 1,
      payload: {},
    });
    check(invalidSession.status === 400, "unknown session returns HTTP 400");
    check(
      invalidSession.body.error === "invalid_session",
      "unknown session returns stable error code",
    );

    const staleSequence = await post({
      messageId: "stale-sequence-1",
      type: "HEARTBEAT",
      protocolVersion: "1.0",
      sessionId,
      workerId,
      sequence: 0,
      payload: {},
    });
    check(staleSequence.status === 400, "stale sequence returns HTTP 400");
    check(
      staleSequence.body.error === "invalid_sequence",
      "stale sequence returns stable error code",
    );
    check(
      sessions.getSession(sessionId)?.lastSequence === 0,
      "stale sequence does not advance durable sequence",
    );

    const heartbeat = await post({
      messageId: "heartbeat-real-handler-1",
      type: "HEARTBEAT",
      protocolVersion: "1.0",
      sessionId,
      workerId,
      sequence: 1,
      payload: {},
    });
    check(heartbeat.status === 200, "valid heartbeat reaches real handler");
    check(
      heartbeat.body.type === "HEARTBEAT_ACK",
      "valid heartbeat returns HEARTBEAT_ACK",
    );
    check(
      sessions.getSession(sessionId)?.lastSequence === 1,
      "valid heartbeat persists sequence 1",
    );

    // Reusing a previously accepted message ID with a newer sequence reaches
    // the in-memory freshness check after the durable sequence check.
    const duplicateId = await post({
      messageId: "heartbeat-real-handler-1",
      type: "HEARTBEAT",
      protocolVersion: "1.0",
      sessionId,
      workerId,
      sequence: 2,
      payload: {},
    });
    check(duplicateId.status === 400, "duplicate message ID returns HTTP 400");
    check(
      duplicateId.body.error === "duplicate_message",
      "duplicate message ID returns duplicate_message",
    );
    check(
      sessions.getSession(sessionId)?.lastSequence === 1,
      "duplicate message rejection does not advance durable sequence",
    );

    // Expiry revokes the persisted session before returning the error.
    const expiredId = "expired-session-real-handler";
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
    });

    const expired = await post({
      messageId: "expired-session-message",
      type: "HEARTBEAT",
      protocolVersion: "1.0",
      sessionId: expiredId,
      workerId,
      sequence: 1,
      payload: {},
    });
    check(expired.status === 400, "expired session returns HTTP 400");
    check(
      expired.body.error === "session_expired",
      "expired session returns stable error code",
    );
    check(
      sessions.getSession(expiredId)?.status === "REVOKED",
      "expired session is durably revoked",
    );

    console.log(`\nPHASE286_REAL_HANDLER: ${passed} PASS, ${failed} FAIL`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await gateway.stop();
    rawDb.close();
  }
}

main().catch((error) => {
  console.error("PHASE286_REAL_HANDLER: ERROR");
  console.error(error);
  process.exitCode = 1;
});
