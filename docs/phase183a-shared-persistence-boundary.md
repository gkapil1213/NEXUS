# Phase 183a - Shared PostgreSQL Persistence Boundary

Checkpoint: nexus-phase183a-complete

Phase 183a introduces the first real shared-database backend for NEXUS.
Scope is deliberately narrow: HTTP request idempotency is now shared across
instances via PostgreSQL, with fail-closed kernel boot and truthful readiness.

ExecutionStore (leases, recovery, release/deployment state, terminal
transitions, rollback) remains local SQLite. Those surfaces require an async
refactor of 109 synchronous prepare() call sites and 15+ dependent services.
That is Phase 183b+ and is not faked.

## Delivered

| Surface | Backend | Verified |
|---|---|---|
| HTTP request idempotency (nexus_idempotency_keys) | PostgreSQL (shared) | cross-process child tests |
| Postgres schema bootstrap | pg_advisory_xact_lock in a transaction | concurrent bootstrap children |
| Connection pool | PgClient (max=10, 5s connect) | probe latency ~2ms |
| Kernel boot | shared mode connects before SQLite engine; fail-closed | yes |
| Readiness | shared_backend in /health/ready meta (redacted URL, family, latency) | yes |
| Config validation | missing/malformed DATABASE_URL fails closed | yes |

## Configuration

    # default
    NEXUS_PERSISTENCE_MODE unset        -> SQLite
    NEXUS_PERSISTENCE_MODE=sqlite       -> SQLite

    # shared
    NEXUS_PERSISTENCE_MODE=shared
    DATABASE_URL=postgres://user:pass@host:5432/db

Missing/invalid URL -> SHARED_PERSISTENCE_UNAVAILABLE.
Unreachable backend -> SHARED_PERSISTENCE_UNREACHABLE.
No silent fallback to SQLite.

## Truth matrix

| Capability | Status | Evidence |
|---|---|---|
| SQLite single-process | VERIFIED | Phase 181 |
| SQLite multi-process (shared filesystem) | VERIFIED | Phase 182 |
| PostgreSQL connectivity | VERIFIED | 183a A1-A2 |
| Postgres bootstrap idempotency | VERIFIED | 183a B1-B2 |
| Postgres advisory-lock coordination | VERIFIED | 183a C1 |
| Cross-process idempotency | VERIFIED | 183a D1-D3, E1-E5 |
| Transaction rollback (Postgres) | VERIFIED | 183a F1-F2 |
| Shared-mode config fail-closed | VERIFIED | 183a G1-G3 |
| Truthful persistence-mode reporting | VERIFIED | 183a H1-H3 |
| Shared lease/recovery/release state | BLOCKED | ExecutionStore still SQLite-only |
| Multi-host coordination | NOT VERIFIED | Same-host Docker only |
| Distributed rate limiting | BLOCKED | Process-local by design |

## Roadmap

- 183b - AsyncNexusEngine interface extraction. No behavior change.
- 183c - Port lease + intent transition subset.
- 183d - Port recovery decision journal + reconciliation evidence.
- 183e - Port terminal/deployment/rollback transitions.
- 183f - Port remaining surface; retire sync stub.
- 183 final - Full regression + cross-host tests, tag nexus-phase183-complete.