# Phase 270 - PostgreSQL Crash/Restart, Durable Recovery, and Shutdown Integrity

## Baseline

- Phase start commit: e43ddc5 (tag: phase269-recovery-observability)
- Test container: nexus-pg (postgres:16, port 55432, RestartPolicy: unless-stopped)

## Coverage

Section 2 - Crash/restart (test-phase270-crash-restart-recovery.ts):
  9 scenarios, 32 assertions. Real child-process kills against PG.
  Child helper: _phase270_pg_child.ts

Section 3 - PG server restart (test-phase270-server-restart.ts):
  5 phases, 10 assertions. Real docker restart nexus-pg.
  Durable state survives container restart.

Section 4 - Shutdown/reconciliation (test-phase270-postgres-shutdown-reconciliation.ts):
  8 scenarios, 18 assertions. Safety-gated (loopback + allowlist).
  Sc270B-3 is the control: pre-shutdown reconcile DOES execute.

Total Phase 270 assertions: 60, all passing.

## Regressions checked

phase144 (113), phase157 (111), phase178 (96), phase197 (31)
phase198 (28), phase199 (24), phase264 (32), phase265 (41)
phase266 (27), phase269a (17), phase269b (16)
tsc exit 0, git diff --check clean, graceful shutdown passed

Total regressions: 536 assertions, all passing.

## Harness integration

scripts/phase266-verify.ps1 runs 16 steps. Phase 270 steps added after
phase266, before diffcheck. phase270c (server restart) is the last
DB-touching step.

Strict-mode invocation requires BOTH:
  NEXUS_VERIFY_REQUIRE_PG=1
  NEXUS_PHASE270_ALLOW_PG_TESTS=1

## Not covered

- Real network partition between app and PG (out of scope)
- Actual PG failover to standby (single-container setup)
- Multi-instance PG cluster restart (out of scope)

## Sign-off

Phase 270 is committed, tested, and harness-integrated. No regressions.