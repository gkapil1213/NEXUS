# WP6 — DispatchService cancellation and status

**Classification: CODE COMPLETE — NOT TEST VERIFIED**

src/core/dispatch-service.ts:

- readDispatchRecord(dispatchId) — async-aware read
  (getRemoteDispatchAsync in shared mode; sync in SQLite-only mode).
- writeDispatchRecord(record) — async-aware write
  (upsertRemoteDispatchAsync in shared mode).
- cancelDetailed(dispatchId) — re-reads the dispatch via
  await this.readDispatchRecord(dispatchId) after the external adapter
  cancel, not the sync getRemoteDispatch. Terminal state preserved: if the
  dispatch has become COMPLETED / FAILED / CANCELLED while the external call
  was in flight, the caller receives cancelled:false with
  raced_to_terminal:<status> reason.
- getStatus(dispatchId) — re-reads the dispatch via readDispatchRecord after
  the adapter status call; terminal durable state wins over provider state.

The cancelDetailed re-read fix landed in commit 40b0ef3. The getStatus
re-read was drafted but has not been added to the file; the current
getStatus still returns provider state directly. This gap must be closed
before WP6 can be classified PASS.

No dedicated WP6 test exists against live PostgreSQL for cancellation,
provider-failure propagation, or terminal-state preservation in getStatus.
scripts/test-phase137-cancellation-timeout.ts is the pre-existing SQLite
test and remains valid for SQLite-only mode.
