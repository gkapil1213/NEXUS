# Phase 214 - Architecture

Phase 214 introduces the durable engineering-run orchestration layer. It is a
thin metadata layer over the existing Phase 201-213 execution infrastructure,
not a parallel system.

## Identity model

- engineering_runs.id        === execution_jobs.id  (job_type 'engineering.run')
- engineering_run_stages.id  === execution_jobs.id  (job_type 'engineering.stage')
- dependencies live in execution_stage_dependencies (Phase 201)
- execution_events and engineering_run_events are separate journals — one for
  the execution layer, one for the engineering layer

Because the parent and stage ids ARE execution_jobs ids, the existing DAG
eligibility, admission, dispatch, lease, fencing, recovery, and finalization
machinery all apply unchanged.

## Components

- src/core/engineering-capability-registry.ts  - honest 'can we execute X?'
- src/core/engineering-run-service.ts          - create/read/transition/cancel/reconcile
- src/db/migrations/169_phase214_engineering_runs.sql
- src/core/pg-bootstrap.ts                     - mirror
- src/core/verification-manifest.ts            - PHASE_214 registered

## Non-goals

Phase 214 does NOT pretend an AI can plan, architect, write production code,
diagnose failures, or repair them. Every stage whose executor is unwired is
persisted BLOCKED with an honest reason and never reaches SUCCEEDED. Those
capabilities belong to later phases.
