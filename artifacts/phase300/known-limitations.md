# Phase 300 — Known limitations

This file lists everything Phase 300 does NOT claim as verified. It is
deliberately conservative: anything without direct test evidence is listed
here rather than glossed over.

## Not test-verified

- WP1 (dispatch creation + retrieval): code-complete; no dedicated test.
- WP2 (atomic worker claiming): code-complete; no dedicated test.
- WP4 (worker gateway routing): code-complete; partially exercised by the
  WP3 test suite. JOB_RESULT preflight at worker-gateway.ts:282-316 still
  performs sync dispatch and existing-result reads in shared mode.
- WP5 (RemoteExecutionManager reconciliation): code-complete; no dedicated
  test for restart reconciliation, initializeAsync retry, or terminal-state
  preservation.
- WP6 (DispatchService cancellation + status): code-complete; no dedicated
  test against live PostgreSQL. getStatus re-read after provider call is
  drafted but not applied to the file.
- WP7 (kernel init + readiness): PARTIAL. Persistence-side init is correct;
  startGateway() listener boundary not inspected.
- WP8 (schema): PARTIAL. pg-bootstrap DDL for remote_execution_results
  added; matches live indexes. Column-type parity (success INTEGER vs live
  type; verified_at INTEGER vs BIGINT) not verified.

## Cross-instance behaviour

Section 5.C of the specification requires cross-instance tests: two
independent store instances against the same PostgreSQL, verifying that a
dispatch cannot be claimed twice, that results committed by one instance
are visible to another, and that cancellation and result races preserve
consistent durable state. Only test-phase268-remote-result-integrity.ts
test E (concurrent submissions) exercises a form of cross-instance behaviour
(two concurrent calls to the same async method), and it does so within a
single Node process (Promise.all). No true two-process cross-instance test
was run.

## Schema-drift risk

pg-bootstrap.ts is not the source of truth for the live PG schema. The live
DB has been built by a mix of migrations run manually and by bootstrap code.
Column-type parity between the two is not verified. This is a pre-existing
condition, not introduced by Phase 300, but Phase 300 does not resolve it.

## Commit-message BOM

Commit 977ed86's subject line carries a UTF-8 BOM at the start, introduced
by Out-File -Encoding utf8 on Windows PowerShell 5. This is cosmetic and
does not affect code or test content. No amend was performed.
