// Child process for test-phase300-wp3-cross-process.ts.
// Reads a JSON payload from WP3_PAYLOAD env var. Calls
// persistRemoteExecutionResultAndDispatchAsOwnerAsync once, with the result
// and dispatch described by the payload. Emits the outcome as JSON on stdout.
//
// The payload fields:
//   dispatchId, jobId, workerId, leaseId, resultId, resultSha256,
//   dispatchStatus ("COMPLETED" | "FAILED")
//
// No other behavior. This keeps the child's contribution to the test
// strictly one persist call, so the parent can reason about exactly what
// each process did.

import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { ExecutionStore } from "../src/core/execution-store";
import type { RemoteExecutionResult, RemoteDispatchRecord } from "../src/core/execution-models";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const payloadRaw = process.env.WP3_PAYLOAD;
  if (!url || !payloadRaw) {
    console.error(JSON.stringify({ error: "missing DATABASE_URL or WP3_PAYLOAD" }));
    process.exit(1);
  }
  const p = JSON.parse(payloadRaw) as {
    dispatchId: string; jobId: string; workerId: string; leaseId: string;
    resultId: string; resultSha256: string;
    dispatchStatus: "COMPLETED" | "FAILED";
  };

  const client = new PgClient();
  await client.connect(url);
  const engine = new PgAsyncEngine(client);
  const store = new (ExecutionStore as any)({} as any, engine);

  const now = Date.now();
  const result: RemoteExecutionResult = {
    resultId: p.resultId,
    jobId: p.jobId,
    attemptId: undefined,
    workerId: p.workerId,
    dispatchId: p.dispatchId,
    leaseId: p.leaseId,
    success: p.dispatchStatus === "COMPLETED",
    exitCode: 0,
    stdoutRef: "hello",
    stderrRef: "",
    evidence: { test: true },
    createdAt: now,
    stdoutSha256: "a".repeat(64),
    stderrSha256: "b".repeat(64),
    resultSha256: p.resultSha256,
    verificationStatus: "VERIFIED",
    verifiedAt: now,
  };
  const dispatch: RemoteDispatchRecord = {
    dispatchId: p.dispatchId,
    jobId: p.jobId,
    workerId: p.workerId,
    leaseId: p.leaseId,
    attemptId: undefined,
    idempotencyKey: "idem-" + p.dispatchId,
    status: p.dispatchStatus,
    createdAt: 0,
    updatedAt: now,
    result: { success: p.dispatchStatus === "COMPLETED", exitCode: 0, stdout: "hello", stderr: "" },
  };

  let outcome: any;
  try {
    outcome = await store.persistRemoteExecutionResultAndDispatchAsOwnerAsync(result, dispatch, p.leaseId, p.workerId);
  } catch (e) {
    console.error(JSON.stringify({ error: String(e) }));
    await client.close();
    process.exit(1);
    return;
  }

  await client.close();
  console.log(JSON.stringify({ outcome }));
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(JSON.stringify({ error: String(e) }));
  process.exit(1);
});
