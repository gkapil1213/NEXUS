# WP5 — RemoteExecutionManager reconciliation

**Classification: CODE COMPLETE — NOT TEST VERIFIED**

src/core/remote-execution-manager.ts:

- Constructor no longer triggers reconciliation (was an unawaited async
  call that raced adapter readiness). Fixed in commit 40b0ef3.
- initializeAsync() is coalesced and retry-safe: initPromise holds
  in-flight work; concurrent callers share it; a failed init clears the
  promise so a subsequent call retries; initialized = true is set only on
  success.
- private async readDispatch(idOrProviderId) — backend-aware read
  (getRemoteDispatchAsync + getRemoteDispatchByExternalProviderIdAsync in
  shared mode, sync path in SQLite-only mode).
- private async writeDispatch(record) — backend-aware write via
  upsertRemoteDispatchAsync in shared mode.
- reconcilePersistedDispatches uses readDispatch / writeDispatch, so both
  read and write go through the selected backend.
- cancel / getStatus / collectResult also route through readDispatch.

src/core/kernel.ts:387 awaits remoteExecutionManager.initializeAsync()
before constructing JobDispatcher and DispatchService. If initialization
throws, _boot() rejects and boot() clears its bootPromise so a subsequent
boot() retries cleanly.

No dedicated WP5 test exists for restart reconciliation, initializeAsync
retry, or terminal-state preservation. A WP5 integration test is required
before WP5 can be classified PASS.
