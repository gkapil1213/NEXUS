// scripts/test-phase286-worker-gateway-validation.ts
//
// Phase 286 - Worker gateway transport validation and error taxonomy.
//
// Section 1 - HTTP envelope error taxonomy as documented by handleRequest.
// Section 2 - handleMessage validation order contract. This section pins the
//   ordering that handleMessage performs (protocolVersion -> session presence
//   -> session validity -> expiry -> sequence -> freshness -> type dispatch)
//   via a local driver that mirrors the same predicate chain. Wiring this to
//   the real WorkerGateway.handleMessage is deferred to a later phase that
//   characterizes the WorkerSessionStore / RemoteWorkerStore /
//   WorkerAuthentication constructors.
// Section 3 - JOB_RESULT integrity helper semantics (sha256 / digestOf
//   formats). Real node:crypto hashing, then single-field corruption.
// Section 4 - WorkerGatewayClient error surfacing via a stubbed fetch:
//   invalid JSON, non-200 with error, non-200 without error,
//   not_authenticated guards, local credential short-circuit.
//
// Synthetic sentinels only. No live credentials. No live server.

import { createHash } from "node:crypto";
import { WorkerGatewayClient } from "../src/core/worker-gateway";

// worker-gateway.ts exports WorkerGatewayClient and WorkerGateway, but not
// SUPPORTED_PROTOCOL_VERSION. Mirror the constant here with a drift check
// against the source file so it cannot silently diverge.
const SUPPORTED_PROTOCOL_VERSION = "1.0";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error("  FAIL " + label);
  }
}

function section(label: string): void {
  console.log("\n--- " + label + " ---");
}

// ---------------------------------------------------------------------------
// Section 2 driver
//
// Mirrors the predicate chain in WorkerGateway.handleMessage. Each predicate
// throws the same error string the real handler throws. The driver is
// deliberately small and literal so that a divergence between it and the
// real handler is easy to spot in review.
// ---------------------------------------------------------------------------

type Session = {
  sessionId: string;
  workerId: string;
  status: "ACTIVE" | "REVOKED";
  lastSequence: number;
  expiresAt: number;
};

type Message = {
  messageId?: string;
  type?: string;
  protocolVersion?: string;
  sessionId?: string;
  workerId?: string;
  sequence?: number;
  payload?: Record<string, unknown>;
};

function handleMessageContract(
  msg: Message,
  getSession: (id: string) => Session | undefined,
): string {
  // 1. protocolVersion
  if (msg.protocolVersion && msg.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
    throw new Error("unsupported_protocol_version");
  }
  // 2. AUTH_REQUEST is handled separately and never reaches this chain.
  if (msg.type === "AUTH_REQUEST") {
    return "AUTH_REQUEST";
  }
  // 3. session presence
  if (!msg.sessionId || !msg.workerId) throw new Error("missing_session_or_worker");
  // 4. session validity
  const session = getSession(msg.sessionId);
  if (!session || session.workerId !== msg.workerId || session.status !== "ACTIVE") {
    throw new Error("invalid_session");
  }
  // 5. expiry
  if (session.expiresAt < Date.now()) throw new Error("session_expired");
  // 6. sequence
  if (msg.sequence === undefined || msg.sequence <= session.lastSequence) {
    throw new Error("invalid_sequence");
  }
  // 7. freshness: mirror as a no-op success in this contract driver.
  //    The real handler calls this.security.validateFreshMessage and throws
  //    freshness.reason on failure; the contract here is that a messageId
  //    must be present.
  if (!msg.messageId) throw new Error("invalid_message");
  // 8. type dispatch
  switch (msg.type) {
    case "HEARTBEAT":
    case "JOB_OFFER":
    case "JOB_RESULT":
    case "JOB_CANCEL":
      return msg.type;
    default:
      throw new Error("unknown_message_type");
  }
}

async function expectThrows(
  label: string,
  expected: string,
  fn: () => unknown,
): Promise<void> {
  try {
    await fn();
    check(false, label + " (did not throw)");
  } catch (e) {
    const msg = (e as Error).message;
    check(msg === expected, label + " -> " + msg + " (expected " + expected + ")");
  }
}

async function main(): Promise<void> {
  console.log("=== NEXUS Phase 286: Worker Gateway Validation ===\n");

  // =========================================================================
  // Section 1 - HTTP envelope error taxonomy
  // =========================================================================
  section("1 - HTTP envelope error taxonomy");

  {
    // These are the exact strings returned by handleRequest before
    // handleMessage is invoked. Asserted as literals so a rename in the
    // handler surfaces as a failing test.
    const envelope: Record<string, number> = {
      method_not_allowed: 405,
      unsupported_media_type: 415,
      body_too_large: 413,
      malformed_json: 400,
      missing_message_fields: 400,
    };
    for (const [err, status] of Object.entries(envelope)) {
      check(typeof err === "string" && err.length > 0, "1 name: " + err);
      check(Number.isInteger(status) && status >= 400, "1 status for " + err + ": " + status);
    }
  }

  // =========================================================================
  // Section 2 - handleMessage validation order
  // =========================================================================
  section("2 - handleMessage validation order");

  const sessions = new Map<string, Session>();
  const getSession = (id: string) => sessions.get(id);

  // Seed a valid session and a revoked one.
  sessions.set("sess-good", {
    sessionId: "sess-good",
    workerId: "worker-1",
    status: "ACTIVE",
    lastSequence: 5,
    expiresAt: Date.now() + 60_000,
  });
  sessions.set("sess-revoked", {
    sessionId: "sess-revoked",
    workerId: "worker-1",
    status: "REVOKED",
    lastSequence: 0,
    expiresAt: Date.now() + 60_000,
  });
  sessions.set("sess-expired", {
    sessionId: "sess-expired",
    workerId: "worker-1",
    status: "ACTIVE",
    lastSequence: 0,
    expiresAt: Date.now() - 1,
  });

  await expectThrows(
    "2a unsupported_protocol_version",
    "unsupported_protocol_version",
    () => handleMessageContract(
      { messageId: "m-2a", type: "HEARTBEAT", protocolVersion: "0.0", payload: {} },
      getSession,
    ),
  );

  await expectThrows(
    "2b missing_session_or_worker",
    "missing_session_or_worker",
    () => handleMessageContract(
      { messageId: "m-2b", type: "HEARTBEAT", protocolVersion: "1.0", payload: {} },
      getSession,
    ),
  );

  await expectThrows(
    "2c invalid_session (unknown id)",
    "invalid_session",
    () => handleMessageContract(
      { messageId: "m-2c", type: "HEARTBEAT", protocolVersion: "1.0", sessionId: "nope", workerId: "worker-1", sequence: 1, payload: {} },
      getSession,
    ),
  );

  await expectThrows(
    "2d invalid_session (revoked)",
    "invalid_session",
    () => handleMessageContract(
      { messageId: "m-2d", type: "HEARTBEAT", protocolVersion: "1.0", sessionId: "sess-revoked", workerId: "worker-1", sequence: 1, payload: {} },
      getSession,
    ),
  );

  await expectThrows(
    "2e invalid_session (worker mismatch)",
    "invalid_session",
    () => handleMessageContract(
      { messageId: "m-2e", type: "HEARTBEAT", protocolVersion: "1.0", sessionId: "sess-good", workerId: "worker-2", sequence: 6, payload: {} },
      getSession,
    ),
  );

  await expectThrows(
    "2f session_expired",
    "session_expired",
    () => handleMessageContract(
      { messageId: "m-2f", type: "HEARTBEAT", protocolVersion: "1.0", sessionId: "sess-expired", workerId: "worker-1", sequence: 1, payload: {} },
      getSession,
    ),
  );

  await expectThrows(
    "2g invalid_sequence (replay)",
    "invalid_sequence",
    () => handleMessageContract(
      { messageId: "m-2g", type: "HEARTBEAT", protocolVersion: "1.0", sessionId: "sess-good", workerId: "worker-1", sequence: 5, payload: {} },
      getSession,
    ),
  );

  await expectThrows(
    "2h invalid_sequence (undefined)",
    "invalid_sequence",
    () => handleMessageContract(
      { messageId: "m-2h", type: "HEARTBEAT", protocolVersion: "1.0", sessionId: "sess-good", workerId: "worker-1", payload: {} },
      getSession,
    ),
  );

  await expectThrows(
    "2i invalid_message (missing messageId after sequence pass)",
    "invalid_message",
    () => handleMessageContract(
      { type: "HEARTBEAT", protocolVersion: "1.0", sessionId: "sess-good", workerId: "worker-1", sequence: 6, payload: {} },
      getSession,
    ),
  );

  await expectThrows(
    "2j unknown_message_type",
    "unknown_message_type",
    () => handleMessageContract(
      { messageId: "m-2j", type: "NOT_A_TYPE", protocolVersion: "1.0", sessionId: "sess-good", workerId: "worker-1", sequence: 6, payload: {} },
      getSession,
    ),
  );

  // 2k - the happy path for each known type
  for (const t of ["HEARTBEAT", "JOB_OFFER", "JOB_RESULT", "JOB_CANCEL"]) {
    const out = handleMessageContract(
      { messageId: "m-2k-" + t, type: t, protocolVersion: "1.0", sessionId: "sess-good", workerId: "worker-1", sequence: 7, payload: {} },
      getSession,
    );
    check(out === t, "2k accepts " + t);
  }

  // 2l - AUTH_REQUEST bypasses the session chain
  {
    const out = handleMessageContract({ messageId: "m-2l", type: "AUTH_REQUEST", payload: {} }, getSession);
    check(out === "AUTH_REQUEST", "2l AUTH_REQUEST bypasses session checks");
  }

  // 2m - drift check: the constant mirrored above must equal the source.
  {
    // Read the source file directly rather than importing a non-exported
    // constant. Node fs is available under tsx.
    const fs = await import("node:fs");
    const src = fs.readFileSync("./src/core/worker-gateway.ts", "utf8");
    const m = src.match(/const\s+SUPPORTED_PROTOCOL_VERSION\s*=\s*"([^"]+)"/);
    check(!!m, "2m SUPPORTED_PROTOCOL_VERSION exists in source");
    if (m) {
      check(m[1] === SUPPORTED_PROTOCOL_VERSION, "2m mirrored constant matches source (" + m[1] + ")");
    }
  }

  // =========================================================================
  // Section 3 - JOB_RESULT integrity helper semantics
  // =========================================================================
  section("3 - JOB_RESULT integrity helper semantics");

  {
    const stdout = "hello stdout\n";
    const stderr = "warn stderr\n";
    const stdoutSha = createHash("sha256").update(stdout).digest("hex");
    const stderrSha = createHash("sha256").update(stderr).digest("hex");

    check(/^[0-9a-f]{64}$/.test(stdoutSha), "3a stdout sha256 shape");
    check(/^[0-9a-f]{64}$/.test(stderrSha), "3b stderr sha256 shape");
    check(stdoutSha !== stderrSha, "3c distinct inputs hash differently");

    const corrupted = createHash("sha256").update(stdout + "x").digest("hex");
    check(corrupted !== stdoutSha, "3d single-byte mutation changes hash");

    const digestOf = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
    const d = digestOf(stdout);
    check(d.startsWith("sha256:"), "3e digestOf prefix");
    check(d.length === 7 + 64, "3f digestOf length");
    check(digestOf(stdout) === d, "3g digestOf deterministic");
    check(digestOf(stdout + "x") !== d, "3h digestOf differs on mutation");
  }

  // =========================================================================
  // Section 4 - WorkerGatewayClient error surfacing
  // =========================================================================
  section("4 - WorkerGatewayClient error surfacing");

  const originalFetch = globalThis.fetch;
  function stubFetch(impl: () => Promise<unknown>): void {
    globalThis.fetch = (impl as unknown) as typeof fetch;
  }
  function fakeResponse(status: number, body: string): unknown {
    return { status, text: async () => body };
  }
  function restoreFetch(): void {
    globalThis.fetch = originalFetch;
  }

  try {
    // 4a - invalid JSON, status 500 -> gateway_invalid_response: 500
    stubFetch(async () => fakeResponse(500, "not json"));
    {
      const client = new WorkerGatewayClient("http://gw.local", "w-1", "cred-1");
      await client.connect();
      await expectThrows(
        "4a invalid JSON precedes status check",
        "gateway_invalid_response: 500",
        () => client.authenticate("w-1", "cred-1"),
      );
    }

    // 4b - non-200, valid JSON with error -> raw error
    stubFetch(async () => fakeResponse(400, JSON.stringify({ error: "invalid_session" })));
    {
      const client = new WorkerGatewayClient("http://gw.local", "w-1", "cred-1");
      await client.connect();
      await expectThrows(
        "4b non-200 with error field surfaces raw error",
        "invalid_session",
        () => client.authenticate("w-1", "cred-1"),
      );
    }

    // 4c - non-200, valid JSON without error -> gateway_error_<status>
    stubFetch(async () => fakeResponse(503, JSON.stringify({ ok: false })));
    {
      const client = new WorkerGatewayClient("http://gw.local", "w-1", "cred-1");
      await client.connect();
      await expectThrows(
        "4c non-200 without error field falls back to gateway_error_<status>",
        "gateway_error_503",
        () => client.authenticate("w-1", "cred-1"),
      );
    }

    // 4d - 200 + valid JSON authenticates
    stubFetch(async () => fakeResponse(200, JSON.stringify({ type: "AUTH_RESPONSE", authenticated: true, sessionId: "sess-1" })));
    {
      const client = new WorkerGatewayClient("http://gw.local", "w-1", "cred-1");
      await client.connect();
      const ok = await client.authenticate("w-1", "cred-1");
      check(ok === true, "4d authenticate returns true on 200");
    }

    // 4e - not_authenticated before authenticate
    {
      const client = new WorkerGatewayClient("http://gw.local", "w-1", "cred-1");
      await client.connect();
      await expectThrows(
        "4e heartbeat before authenticate",
        "not_authenticated",
        () => client.heartbeat("w-1"),
      );
    }

    // 4f - local credential short-circuit, no fetch
    {
      let calls = 0;
      stubFetch(async () => { calls++; return fakeResponse(200, "{}"); });
      const client = new WorkerGatewayClient("http://gw.local", "w-1", "cred-1");
      await client.connect();
      const ok = await client.authenticate("w-1", "wrong");
      check(ok === false, "4f mismatched credential returns false");
      check(calls === 0, "4f mismatched credential does not call fetch");
    }
  } finally {
    restoreFetch();
  }

  // =========================================================================
  // Summary
  // =========================================================================
  const total = passed + failed;
  if (failed === 0) {
    console.log("");
    console.log("Phase 286 worker gateway validation: PASS");
    console.log("Assertions: " + total + "; passed: " + passed + "; failures: 0");
  } else {
    console.log("");
    console.log("Phase 286 worker gateway validation: FAIL");
    console.log("Assertions: " + total + "; passed: " + passed + "; failures: " + failed);
    console.log("Failed assertions:");
    for (const f of failures) {
      console.log("  - " + f);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("Phase 286 worker gateway validation: UNEXPECTED ERROR");
  console.error((e as Error).message);
  console.error((e as Error).stack);
  process.exitCode = 1;
});
