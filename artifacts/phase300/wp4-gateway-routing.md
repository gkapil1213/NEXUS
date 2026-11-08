# WP4 — Worker gateway routing

**Classification: CODE COMPLETE — PARTIALLY EXERCISED**

Both JOB_RESULT handlers route via hasAsyncBackend():
  - handler-registry.ts:jobResultHandler
  - worker-gateway.ts inline JOB_RESULT handler
JOB_OFFER routes via hasAsyncBackend() at handler-registry.ts:jobOfferHandler.
JOB_CANCEL delegates to dispatchService.cancelDetailed (backend-aware, see WP6).

Remaining gap: the JOB_RESULT preflight at worker-gateway.ts lines 282-316
still performs sync getRemoteDispatch and getRemoteExecutionResultByDispatchId
reads. These are read-only checks, do not persist anything, but do not
follow the "shared-mode lifecycle uses PostgreSQL" invariant. This is a
Phase 300 v2 concern and remains open.

Test status: test-phase268-remote-result-integrity.ts exercises the async
persistence method directly, not through the gateway. WP4 cannot be
classified PASS until the preflight gap is closed and end-to-end routing
is tested.
