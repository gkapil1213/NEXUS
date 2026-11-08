# WP1 — Dispatch persistence

**Classification: CODE COMPLETE — NOT TEST VERIFIED**

Async PostgreSQL siblings on ExecutionStore: getRemoteDispatchAsync,
getRemoteDispatchByExternalProviderIdAsync, getRemoteDispatchByJobIdempotencyKeyAsync,
upsertRemoteDispatchAsync (atomic INSERT ... ON CONFLICT (dispatch_id) DO UPDATE),
createRemoteDispatchIfAbsentAsync (23505 catch + recovery), listAllRemoteDispatchesAsync.

All call requireAsyncDb() and refuse SQLite fallback. Sync siblings unchanged.

No dedicated WP1 test exists. The dispatch reads are exercised indirectly via
seedLeaseAndDispatch in test-phase268-remote-result-integrity.ts, but that test
does not exercise createRemoteDispatchIfAbsentAsync or upsertRemoteDispatchAsync
through their async methods.

Semantic decision still open: remote_dispatches.idempotency_key is globally
UNIQUE (migration 172). Documented in known-limitations.md.
