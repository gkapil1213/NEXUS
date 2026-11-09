# WP6 — DispatchService cancellation and status

**Classification: PASS — 9/9 integration tests (PostgreSQL)**

## What was implemented

`src/core/dispatch-service.ts:getStatus()` re-read (this commit):

- Short-circuits on durable terminal status (COMPLETED | FAILED | BLOCKED | CANCELLED)
- Returns durable state when externalProviderId is absent
- Re-reads after the provider call; terminal durable state wins over stale provider
- Throws `Dispatch <id> not found` when no durable record exists

`cancelDetailed()` (already correct at commit 40b0ef3):

- Terminal short-circuit for COMPLETED/FAILED/BLOCKED
- Honest provider failure — returns cancelled:false with provider_unavailable, durable state unchanged
- Re-reads after provider call; a raced terminal state returns raced_to_terminal
- Idempotent: second call on CANCELLED returns cancelled:true

## Test evidence

scripts/test-phase300-wp6-cancellation-status.ts — 9 cases against isolated PostgreSQL.

| # | Case | Result |
|---|---|---|
| WP6-1 | Successful cancellation persists CANCELLED | PASS |
| WP6-2 | Already-CANCELLED returns true without provider call | PASS |
| WP6-3 | Cancel racing COMPLETED returns raced_to_terminal; COMPLETED preserved | PASS |
| WP6-4 | Cancel racing FAILED returns raced_to_terminal; FAILED preserved | PASS |
| WP6-5 | Provider cancel failure leaves durable state unchanged | PASS |
| WP6-6 | getStatus returns durable DISPATCHED without calling provider | PASS |
| WP6-7 | getStatus on durable COMPLETED returns it without provider call | PASS |
| WP6-8 | Two concurrent cancelDetailed calls are idempotent | PASS |
| WP6-9 | getStatus on missing dispatch throws not-found | PASS |

Summary: PASS: 9 / FAIL: 0 / BLOCKED: 0 / NOT EXECUTED: 0.

Verbatim output: test-results/2026-11-09-phase300-wp6-9-0-pass.txt.

## What is NOT verified

- SQLite-only compatibility for cancelDetailed/getStatus: NOT TESTED directly. The SQLite path is exercised transitively by wp5-sqlite but not the DispatchService methods.
- collectResult existing-durable-result return and terminal-without-result honesty: not tested in this cycle.
