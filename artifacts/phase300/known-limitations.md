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
- WP7 (kernel init + readiness): Verified. Claims 1 and 3 rely on code
  inspection plus the `!services || status !== "ready"` guard in
  startGateway() (commit 1a90a0f); direct failure-path test would require
  a boot-failure injection seam not currently exposed.
- WP8 (schema): PASS. Verified by two complementary tests.
  (a) Live PostgreSQL inspection on 2026-11-10 confirmed all 17
      column definitions, both foreign keys, and all three expected
      indexes match pg-bootstrap. The async writer passed native
      BOOLEAN false-persistence (Phase 268: 8/8).
  (b) Fresh independent PostgreSQL bootstrap on 2026-11-11
      (test-phase300-wp8-fresh-bootstrap.ts, 12/12 PASS):
      isolated DB created, bootstrap idempotent, all 17 columns
      with correct types, PK on result_id, both FKs (job_id
      NO ACTION; dispatch_id ON DELETE CASCADE), all 3 indexes,
      actual async writer persists success=false (BOOLEAN round-trip),
      DROP DATABASE verified.

## Cross-instance behaviour

Section 5.C of the specification requires cross-instance tests: two
independent store instances against the same PostgreSQL. Verified on
2026-11-11 against an isolated PostgreSQL 16 database with real child
processes:

- Claim exclusivity: `test-phase300-wp2-atomic-claiming.ts` WP2-5
  (20 dispatches, two processes; every dispatch claimed exactly once,
  no cross-process overlap).

- Result visibility + duplicate + conflict across processes:
  `test-phase300-wp3-cross-process.ts` WP3-X1 through WP3-X4
  (process A writes, process B reads; concurrent identical submits
  produce exactly one row; conflicting submits produce exactly one
  RESULT_CONFLICT; sequential retries yield idempotent duplicate).

- Cancel-vs-result race across processes:
  `test-phase300-wp3-cross-process.ts` WP3-X5
  (deterministic final state: either {dispatch=COMPLETED, result row=1}
  or {dispatch=CANCELLED, result row=0}; no torn state).

All three §5.C properties are covered by two-process tests with real
child-process isolation.

## Schema-drift risk

The live PostgreSQL `remote_execution_results` schema was inspected on
2026-11-10. Its 17 column definitions, foreign keys, and three expected
indexes match the current `pg-bootstrap.ts` definition.

A fresh, independently initialized PostgreSQL database was also
bootstrap-tested on 2026-11-11 (test-phase300-wp8-fresh-bootstrap.ts,
12/12 PASS). The clean-room bootstrap produces the expected schema
and the actual async writer persists successfully against the fresh DB.

Other tables remain unverified against a fresh bootstrap; this file
documents Phase 300's scope only.

## Commit-message BOM

Commit 977ed86's subject line carries a UTF-8 BOM at the start, introduced
by Out-File -Encoding utf8 on Windows PowerShell 5. This is cosmetic and
does not affect code or test content. No amend was performed.
