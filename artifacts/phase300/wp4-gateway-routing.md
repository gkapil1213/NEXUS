# WP4 — Worker gateway routing

**Classification: PASS — 7/7 JOB_RESULT gateway tests; synchronous PostgreSQL preflight gap remains OPEN**

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

Test status: The November 12 WP4 gateway-routing regression suite
passed 7/7 tests through the real gateway JOB_RESULT path. This
does not close the separate synchronous preflight gap described
above. That gap remains open and must not be represented as fully
PostgreSQL-authoritative until independently resolved and verified.
