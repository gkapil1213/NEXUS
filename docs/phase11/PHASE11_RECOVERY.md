# Phase 11: Recovery System

## Overview
Phase 11 introduces an automated recovery system that evaluates incidents, decides on recovery actions (automatic vs. human approval), and executes them safely.

## Key Components

- **RecoveryPolicyEngine** (`src/core/recovery-policy-engine.ts`)  
  Evaluates recovery actions based on environment and attempt count, returning a `RecoveryDecision`.

- **RecoveryAgent** (`src/core/recovery-agent.ts`)  
  Orchestrates recovery attempts, calls the policy engine, and (if automatic) executes the action.

- **RecoveryStore** (`src/core/recovery-store.ts`)  
  Persists recovery policies and job records in SQLite.

- **RecoveryExecutor** (`src/core/recovery-executor.ts`)  
  Performs the actual recovery action (currently simulated).

- **Models** (`src/core/recovery-models.ts`, `incident-analysis.ts`)  
  Define the data structures for policies, jobs, actions, and incident analysis.

## Database Migration
File: `019_phase11_recovery.sql`  
Creates `recovery_policies` and `recovery_jobs` tables.

## Testing
Run the verification script:
```bash
npx tsx scripts/run-phase11-pass1.ts