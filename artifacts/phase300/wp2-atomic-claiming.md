# WP2 — Atomic worker claiming

**Classification: CODE COMPLETE — NOT TEST VERIFIED**

ExecutionStore.claimNextDispatchForWorkerAsync(workerId):

  UPDATE remote_dispatches SET status = 'DELIVERED', updated_at = ?
  WHERE dispatch_id = (
    SELECT dispatch_id FROM remote_dispatches
    WHERE worker_id = ? AND status = 'DISPATCHED'
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED LIMIT 1
  ) RETURNING *

Two concurrent claimers cannot win: FOR UPDATE locks the candidate row,
SKIP LOCKED moves the second to the next row or returns nothing.
DISPATCHED -> DELIVERED transition matches sync version.

Caller: handler-registry.ts:jobOfferHandler uses hasAsyncBackend() to route.

No dedicated WP2 test exists. A dedicated concurrent-claim test against
live PostgreSQL is required before WP2 can be classified PASS.
