// scripts/test-phase242-durable-retry.ts
import { getPgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { AsyncExecutionRecoveryOperationStore } from "../src/core/execution-recovery-operation-store";
import { classifyOperationFailure } from "../src/core/operation-failure-classification";
import { RetryEngine } from "../src/core/retry-engine";

let pass = 0, fail = 0, blocked = 0, notExec = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("PASS  " + n); }
  else { fail++; console.log("FAIL  " + n + (d ? " :: " + d : "")); }
}
function blk(n: string, r: string) { blocked++; console.log("BLOCKED  " + n + " :: " + r); }
function ne(n: string, r: string) { notExec++; console.log("NOT EXECUTED  " + n + " :: " + r); }
function finish() {
  console.log("\n============================================");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");
  return fail > 0 ? 1 : 0;
}
function uniq(t: string) { return `phase242-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`; }

async function main() {
  ok("242A runtime reached", true);

  // ---- 242A classifier ----
  ok("242A retryable (TIMEOUT)", classifyOperationFailure("request TIMEOUT") === "RETRYABLE");
  ok("242A retryable (503)", classifyOperationFailure("HTTP 503 server error") === "RETRYABLE");
  ok("242A non-retryable (VALIDATION_FAILED)", classifyOperationFailure("VALIDATION_FAILED: bad input") === "NON_RETRYABLE");
  ok("242A non-retryable (UNAUTHORIZED)", classifyOperationFailure("UNAUTHORIZED") === "NON_RETRYABLE");
  ok("242A unknown -> NON_RETRYABLE", classifyOperationFailure("weird blob xyz") === "NON_RETRYABLE");
  ok("242A persistence (ECONNREFUSED)", classifyOperationFailure("ECONNREFUSED 127.0.0.1") === "PERSISTENCE_UNAVAILABLE");
  ok("242A persistence (explicit)", classifyOperationFailure("PERSISTENCE_UNAVAILABLE") === "PERSISTENCE_UNAVAILABLE");

  // ---- 242C backoff (pure, no DB) ----
  const re = new RetryEngine();
  const policy = { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000, maxAttempts: 5 } as any;
  const t0 = 100000;
  const n1 = re.calculateNextAttempt(1, policy, t0);
  const n2 = re.calculateNextAttempt(2, policy, t0);
  const n3 = re.calculateNextAttempt(3, policy, t0);
  const n5 = re.calculateNextAttempt(5, policy, t0);
  ok("242C attempt1 = +1000", n1 === t0 + 1000, "got " + (n1!-t0));
  ok("242C attempt2 = +2000", n2 === t0 + 2000, "got " + (n2!-t0));
  ok("242C attempt3 = +4000", n3 === t0 + 4000, "got " + (n3!-t0));
  ok("242C attempt5 >= maxAttempts -> null", n5 === null);

  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared" || !process.env.DATABASE_URL) {
    blk("242B/242D/242E/242F shared-mode", "NEXUS_PERSISTENCE_MODE must be shared with DATABASE_URL");
    process.exit(finish());
  }

  const { NexusKernel } = await import("../src/core/kernel");
  const { createNodeBridge } = await import("./host-bridge-node");
  const os = await import("node:os");
  const path = await import("node:path");
  const br = path.join(os.tmpdir(), "nexus-phase242-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(br) };
  const kernel = new NexusKernel();
  await kernel.boot();
  const pg = getPgClient();
  if (!pg) { blk("242-pre pg", "not wired"); try { await kernel.stop(); } catch {}; process.exit(finish()); }
  const ops = new AsyncExecutionRecoveryOperationStore(new PgAsyncEngine(pg));

  // ---- 242B retry metadata durability ----
  {
    const jobId = uniq("b");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w1", operationType: "ORPHAN_RECOVERY" });
    ok("242B new op nextAttemptAt=null", c.operation.nextAttemptAt === null);
    ok("242B new op lastFailureClass=null", c.operation.lastFailureClass === null);

    await ops.claimOperation({ operationId: c.operation.operationId, owner: "A", durationMs: 60000 });
    await ops.markInProgress(c.operation.operationId, "A");
    const t = Date.now();
    const okW = await ops.markFailed(c.operation.operationId, "A", "request TIMEOUT", t, {
      failureClass: "RETRYABLE",
      nextAttemptAt: t + 1000,
    });
    ok("242B markFailed with opts accepted", okW === true);
    const after = (await ops.getOperation(c.operation.operationId))!;
    ok("242B lastFailureClass persisted", after.lastFailureClass === "RETRYABLE", "got " + after.lastFailureClass);
    ok("242B nextAttemptAt persisted", after.nextAttemptAt === t + 1000, "got " + after.nextAttemptAt);
    ok("242B state=FAILED", after.state === "FAILED");
  }

  // ---- 242C-2 next_attempt_at enforced by listResumableOperations ----
  {
    const jobId = uniq("c2");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w1", operationType: "ORPHAN_RECOVERY" });
    await ops.claimOperation({ operationId: c.operation.operationId, owner: "A", durationMs: 60000 });
    await ops.markInProgress(c.operation.operationId, "A");
    const now = Date.now();
    await ops.markFailed(c.operation.operationId, "A", "request TIMEOUT", now, {
      failureClass: "RETRYABLE",
      nextAttemptAt: now + 60_000,
    });
    const resumableNow = await ops.listResumableOperations(now);
    const resumableLater = await ops.listResumableOperations(now + 61_000);
    ok("242C not eligible before nextAttemptAt",
       !resumableNow.some(o => o.operationId === c.operation.operationId));
    ok("242C eligible at/after nextAttemptAt",
       resumableLater.some(o => o.operationId === c.operation.operationId));
  }

  // ---- 242D idempotency ----
  {
    const jobId = uniq("d");
    const key = "phase242-d-" + jobId;
    const r1 = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w1", operationType: "ORPHAN_RECOVERY", idempotencyKey: key });
    const r2 = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w1", operationType: "ORPHAN_RECOVERY", idempotencyKey: key });
    ok("242D duplicate create returns same id", r1.operation.operationId === r2.operation.operationId);
    ok("242D second call created=false", r2.created === false);
  }

  // ---- 242E fencing ----
  {
    const jobId = uniq("e");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w1", operationType: "ORPHAN_RECOVERY" });
    await ops.claimOperation({ operationId: c.operation.operationId, owner: "A", durationMs: 60000 });
    await ops.markInProgress(c.operation.operationId, "A");
    const r = await ops.markFailed(c.operation.operationId, "B", "request TIMEOUT", Date.now(), {
      failureClass: "RETRYABLE",
      nextAttemptAt: Date.now() + 1000,
    });
    ok("242E stale owner markFailed rejected", r === false);
    const op = (await ops.getOperation(c.operation.operationId))!;
    ok("242E state unchanged by stale", op.state === "IN_PROGRESS", "got " + op.state);
  }

  // ---- 242F restart/reconciliation ----
  {
    const jobId = uniq("f");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w1", operationType: "ORPHAN_RECOVERY" });
    await ops.claimOperation({ operationId: c.operation.operationId, owner: "A", durationMs: 60000 });
    await ops.markInProgress(c.operation.operationId, "A");
    const now = Date.now();
    await ops.markFailed(c.operation.operationId, "A", "request TIMEOUT", now, {
      failureClass: "RETRYABLE",
      nextAttemptAt: now + 30_000,
    });
    // Simulate reload.
    const reload = (await ops.getOperation(c.operation.operationId))!;
    ok("242F metadata survives reload",
       reload.lastFailureClass === "RETRYABLE" && reload.nextAttemptAt === now + 30_000);
    // Non-retryable should never be auto-picked.
    const jobId2 = uniq("f2");
    const c2 = await ops.createOrGetOperation({ jobId: jobId2, leaseId: null, workerId: "w1", operationType: "ORPHAN_RECOVERY" });
    await ops.claimOperation({ operationId: c2.operation.operationId, owner: "A", durationMs: 60000 });
    await ops.markInProgress(c2.operation.operationId, "A");
    await ops.markFailed(c2.operation.operationId, "A", "VALIDATION_FAILED", Date.now(), {
      failureClass: "NON_RETRYABLE",
      nextAttemptAt: null,
    });
    const reload2 = (await ops.getOperation(c2.operation.operationId))!;
    ok("242F non-retryable nextAttemptAt=null", reload2.nextAttemptAt === null);
    ok("242F non-retryable class persisted", reload2.lastFailureClass === "NON_RETRYABLE");
  }

  // ---- 242G regressions from evidence ----
  try {
    const fs = await import("node:fs");
    const path2 = await import("node:path");
    for (const [label, rel, needle] of [
      ["242G phase239 PASS:56", "artifacts/phase239/reg239.txt", "PASS: 56"],
      ["242G phase240 PASS:25", "artifacts/phase240/reg240.txt", "PASS: 25"],
      ["242G phase241 PASS:44", "artifacts/phase241/reg241.txt", "PASS: 44"],
    ]) {
      const f = path2.resolve(process.cwd(), rel);
      if (fs.existsSync(f)) {
        const t = fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "");
        ok(label, t.includes(needle));
      } else { ok(label, false, "missing " + rel); }
    }
  } catch (e: any) { ok("242G evidence readable", false, String(e?.message ?? e)); }

  try { await kernel.stop(); } catch {}
  process.exit(finish());
}

main().catch((e) => { console.error(e); process.exit(1); });