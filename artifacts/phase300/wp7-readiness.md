# WP7 — Kernel initialization and readiness

**Classification: PARTIAL**

src/core/kernel.ts:

- boot() — public entry point. On _boot() failure, clears bootPromise and
  re-throws, so a subsequent boot() retries cleanly.
- _boot() — constructs RemoteExecutionManager, then awaits
  remoteExecutionManager.initializeAsync() before constructing
  JobDispatcher and DispatchService. If initialization throws, the whole
  _boot() rejects; no partially-initialized manager is exposed.
- this.remoteExecutionManager = remoteExecutionManager at line 440 occurs
  only after the awaited initialization has completed successfully.

What is NOT verified:

The specification WP7 requires readiness to gate gateway listener startup:

  "Preserve intentional gateway lifecycle separation: Ordinary kernel boot
  must not unexpectedly open a TCP port. startGateway() remains explicitly
  controlled. Gateway listener startup must not be confused with persistence
  readiness. Do not silently start background recovery or external services
  without existing configuration and authorization."

startGateway() and the boundary between persistence readiness and gateway
listener startup have not been inspected in this session. Without inspecting
that boundary, WP7 cannot be classified PASS or FAIL — it is genuinely
PARTIAL until the code path is read.

The persistence-side init sequence is correct. Whether the listener-start
path gates on the same readiness, and whether any background recovery does,
is unverified.
