# Phase 215 - Architecture

Phase 215 adds the real Planning and Architecture execution foundation on
top of the durable engineering-run orchestration from Phase 214.

## Components

New:
- src/core/engineering-planning-contracts.ts
- src/core/engineering-plan-validator.ts
- src/core/engineering-planning-orchestrator.ts
- src/db/migrations/170_phase215_planning_architecture.sql

Reused:
- src/core/artifact-store.ts (extended with registerArtifactAsync for shared mode)
- src/core/engineering-run-service.ts (Phase 214)
- src/core/engineering-capability-registry.ts (Phase 214)
- execution_jobs / engineering_run_events / execution_artifacts
- worker-recovery-dependency.ts detectCycle

## No AI shipped

No concrete planning or architecture provider is wired. Orchestrator
returns BLOCKED/PROVIDER_NOT_CONFIGURED without a provider. Test-only
doubles exercise the contract but are never registered as production
capabilities.
