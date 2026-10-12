import assert from "node:assert/strict";
import { NexusKernel } from "../src/core/kernel";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function verifyPoolWaitsFor(
  label: string,
  promiseField: "distributedSchedulerPromise" | "executionReconcilePromise",
): Promise<void> {
  const kernel = new NexusKernel();
  const internals = kernel as any;
  const gate = deferred<void>();
  let closeCalls = 0;

  // Isolate shutdown ordering from unrelated lifecycle infrastructure.
  internals.stopCicdReconciliationScheduler = async () => {};
  internals.stopDriftObserver = async () => {};
  internals.stopRecoverySupervisor = async () => {};
  internals.awaitInFlightOutboxDrains = async () => {};
  internals.stopGateway = async () => {};

  internals.executionEngine = {
    markShuttingDown() {},
  };

  // The close marker represents the boundary at which PostgreSQL becomes
  // unavailable. No real database connection is created.
  internals.pgClient = {
    async close() {
      closeCalls++;
    },
  };

  internals[promiseField] = gate.promise;

  let shutdownFinished = false;
  const shutdown = kernel.shutdown().then(() => {
    shutdownFinished = true;
  });

  try {
    // Allow shutdown to reach the deliberately blocked operation.
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(
      closeCalls,
      0,
      `${label}: PostgreSQL pool closed before in-flight work settled`,
    );
    assert.equal(
      shutdownFinished,
      false,
      `${label}: shutdown finished while in-flight work was pending`,
    );
  } finally {
    // Always release the gate, even if an assertion fails.
    gate.resolve();
  }

  await shutdown;

  assert.equal(closeCalls, 1, `${label}: expected exactly one pool close`);
  console.log(`PASS ${label}: pool close waits for tracked work`);
}

async function main(): Promise<void> {
  await verifyPoolWaitsFor(
    "Distributed scheduler",
    "distributedSchedulerPromise",
  );

  await verifyPoolWaitsFor(
    "Execution reconciliation",
    "executionReconcilePromise",
  );

  console.log("Phase 263e kernel shutdown drain: ALL TESTS PASSED");
}

main().catch((error) => {
  console.error("Phase 263e kernel shutdown drain: FAILED");
  console.error(error);
  process.exitCode = 1;
});
