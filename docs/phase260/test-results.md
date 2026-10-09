# Phase 260 — Test results

All commands run against the shared Postgres backend
(`NEXUS_PERSISTENCE_MODE=shared`,
`DATABASE_URL=postgres://postgres:postgres@localhost:55432/nexus`).
No in-memory fakes were used.

## Commands and results

| Command | Result |
|---|---|
| `npm run typecheck` | PASS (clean) |
| `npm run test:phase260` | PASS 13, FAIL 0, BLOCKED 0, NOT EXECUTED 1 |
| `npm run test:phase259` | PASS 6, FAIL 0, BLOCKED 0, NOT EXECUTED 0 |
| `npm run test:phase258` | PASS 6, FAIL 0, BLOCKED 0, NOT EXECUTED 0 |
| `npm run test:phase218` | PASS 26, FAIL 0, BLOCKED 0, NOT EXECUTED 0 |
| `npm run test:phase257` | PASS 69, FAIL 0, BLOCKED 0, NOT EXECUTED 0 |
| `npm run build` | PASS (vite, 166 modules, 6.56s) |
| `git diff --check` | PASS (silent) |

`test:phase260`'s single `NOT EXECUTED` is 260G
(partial-persistence repair), deliberately excluded from Phase 260
scope — see `known-limitations.md`.

## Phase 260 output

    mode=shared db=set prefix=engrun-260-...
    [PASS] 260A baseline PLANNING BLOCKED (provider absent) -- status=BLOCKED
    [PASS] 260B CAS rejected + durable matches target -> idempotent -- job=BLOCKED, o.status=BLOCKED
    [PASS] 260C upstream FAILED -> ARCHITECTURE BLOCKED -- status=BLOCKED
    [PASS] 260D job FAILED vs request SUCCEEDED -> conflict -- reason=PERSISTENCE_FAILED_AFTER_SUCCEEDED:TERMINAL_CONFLICT:FAILED
    [PASS] 260E job BLOCKED vs request SUCCEEDED -> conflict -- reason=PERSISTENCE_FAILED_AFTER_SUCCEEDED:TERMINAL_CONFLICT:BLOCKED
    [PASS] 260F reconciler detects MISSING_RUN_EVENT -- findings=MISSING_RUN_EVENT
    [N/E ] 260G partial-persistence repair -- Phase 260 scope excludes §4C repair
    [PASS] 260H reconciler idempotent -- findings=CONSISTENT
    [PASS] 260I reconciler on unknown run -- findings=MISSING_JOB
    [PASS] 260J reconciler detects missing stage row -- findings=MISSING_STAGE
    [PASS] 260K reconciler on read failure -- findings=UNREADABLE
    [PASS] 260L concurrent reconciliation consistent -- 3 parallel calls agree
    [PASS] 260M Phase 259 behavior preserved (store throw -> ok:false) -- reason=PERSISTENCE_FAILED_AFTER_BLOCKED:PERSISTENCE_FAILED
    [PASS] 260N Phase 258 behavior preserved (dependency throw -> FAILED) -- reason=PLANNING_EXECUTOR_THREW:simulated throw

    ===== Phase 260 summary =====
    PASS: 13
    FAIL: 0
    BLOCKED: 0
    NOT EXECUTED: 1

## Regression output

### Phase 259 (persistence honesty)

    mode=shared db=set prefix=engrun-259-...
    [PASS] 259A store throws -> ok:false -- reason=PERSISTENCE_FAILED_AFTER_BLOCKED:PERSISTENCE_FAILED
    [PASS] 259B CAS rejected -> ok:false -- reason=PERSISTENCE_FAILED_AFTER_BLOCKED:CAS_REJECTED
    [PASS] 259C transitionStage rejected -> ok:false -- reason=STAGE_TRANSITION_REJECTED:STALE
    [PASS] 259D happy path unchanged -- status=SUCCEEDED job=SUCCEEDED
    [PASS] 259E Phase 258 behavior preserved -- reason=PLANNING_EXECUTOR_THREW:simulated throw
    [PASS] 259F BLOCKED not persisted -> ok:false -- reason=PERSISTENCE_FAILED_AFTER_BLOCKED:PERSISTENCE_FAILED

    ===== Phase 259 summary =====
    PASS: 6
    FAIL: 0
    BLOCKED: 0
    NOT EXECUTED: 0

### Phase 258 (dependency exception boundaries)

    mode=shared db=set prefix=engrun-258-...
    [PASS] 258A PLANNING submitRequest throws -- reason=PLANNING_EXECUTOR_THREW:simulated submitRequest outage
    [PASS] 258B PLANNING runPlanning throws -- reason=PLANNING_EXECUTOR_THREW:simulated runPlanning outage
    [PASS] 258C ARCHITECTURE getLatestPlan throws -- reason=ARCHITECTURE_EXECUTOR_THREW:simulated getLatestPlan outage
    [PASS] 258D ARCHITECTURE runArchitecture throws -- reason=ARCHITECTURE_EXECUTOR_THREW:simulated runArchitecture outage
    [PASS] 258E IMPLEMENTATION getLatestArchitecture throws -- reason=IMPLEMENTATION_EXECUTOR_THREW:simulated getLatestArchitecture outage
    [PASS] 258F IMPLEMENTATION runImplementation throws -- reason=IMPLEMENTATION_EXECUTOR_THREW:simulated runImplementation outage

    ===== Phase 258 summary =====
    PASS: 6
    FAIL: 0
    BLOCKED: 0
    NOT EXECUTED: 0

### Phase 218 (stage execution and dispatch wiring)

    mode=shared db=set prefix=engrun-218-...
    [PASS] 218A executor construction -- Phase 218 stages remain wired
    [PASS] 218B registry reflects wiring -- Phase 218 stages AVAILABLE
    [PASS] 218C PLANNING dispatch -- submitRequest+runPlanning reached; BLOCKED
    [PASS] 218D ARCHITECTURE dispatch -- runArchitecture reached; BLOCKED
    [PASS] 218E IMPLEMENTATION dispatch -- runImplementation reached; BLOCKED
    [PASS] 218F ARCH gated by PLAN -- BLOCKED; orchestrator not invoked
    [PASS] 218G IMPL gated by ARCH -- BLOCKED; orchestrator not invoked
    [PASS] 218H unknown stage rejected -- 4 malformed payloads rejected
    [PASS] 218I run ownership -- RUN_NOT_FOUND; orchestrator untouched
    [PASS] 218J transitions durable -- capability=AVAILABLE, artifactRef set, job=SUCCEEDED
    [PASS] 218K events persisted -- 11 events
    [PASS] 218L retry idempotency -- second dispatch CAS-idempotent; 1 transition->AVAILABLE
    [PASS] 218M provider absence -- real orchestrator: BLOCKED; job=BLOCKED
    [PASS] 218N failure -> FAIL -- orchestrator FAILED -> job FAILED
    [PASS] 218O no secrets -- 11 events scanned
    [PASS] 218P DAG unchanged -- 9 stages intact
    [PASS] 218Q DispatchService routes engineering.stage -- executor=1 jd=0 rem=0 record.status=BLOCKED
    [PASS] 218R non-engineering job skips executor -- pipeline.stage -> JobDispatcher=1; executor=0
    [PASS] 218S engineering skips JobDispatcher+RemoteManager -- executor invoked; both remote layers bypassed
    [PASS] 218T collectResult returns persisted result -- stable across calls; evidence.status=BLOCKED
    [PASS] 218U retry idempotency via dispatch boundary -- second dispatch returned same dispatchId; executor calls=1
    [PASS] 218V BLOCKED preserved through production path -- result.success=false evidence.status=BLOCKED record.status=BLOCKED
    [PASS] 218W FAILED propagates through production path -- result.success=false evidence.status=FAILED record.status=FAILED
    [PASS] 218X run ownership rejected at dispatch boundary -- success=false; evidence={"status":"REJECTED","reason":"RUN_NOT_FOUND"}
    [PASS] 218Y no secrets in dispatch evidence -- record clean; 11 events scanned
    [PASS] 218Z DAG unchanged through dispatch boundary -- 9-stage canonical DAG preserved

    ===== Phase 218 summary =====
    PASS: 26
    FAIL: 0
    BLOCKED: 0
    NOT EXECUTED: 0

### Phase 257 (recovery handoff convergence)

    PASS: 69
    FAIL: 0
    BLOCKED: 0
    NOT EXECUTED: 0

    (full 69-test log available in artifacts/phase260/test-run.txt)

## Production build

    vite v6.4.3 building for production...
    ✓ 166 modules transformed.
    dist/index.html                                           1.30 kB │ gzip:   0.70 kB
    dist/assets/index-D5xTWyad.css                           45.13 kB │ gzip:   8.55 kB
    dist/assets/engineering-D48D1cvI.js                      43.97 kB │ gzip:  13.83 kB
    dist/assets/index-Brd50Xmd.js                           887.86 kB │ gzip: 209.58 kB
    ✓ built in 6.56s

Two informational warnings from Vite (pre-existing, not Phase 260
related): dynamic-import-vs-static-import notes on `pg-async-engine.ts`
and `incident-lifecycle.ts`, plus a chunk-size warning on the main
bundle. Neither affects correctness.

## Distinguishing test results from production verification

These results are **automated test results** run against a local
Postgres instance at `localhost:55432`. They are not production-
environment verification. Two specific limitations:

1. The shared Postgres is a containerized dev instance, not a
   production-grade managed database. Behaviors under network
   partitions, replication lag, or connection-pool exhaustion are not
   exercised by these tests.
2. Concurrency test 260L exercises three parallel read-only
   reconciliation calls in-process, not across multiple processes.
   Multi-process concurrent reconciliation has not been verified.

These limitations are recorded in `known-limitations.md`.