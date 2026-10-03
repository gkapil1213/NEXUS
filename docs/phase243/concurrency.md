# Phase 243 — Concurrency

## Claiming
claimOperation is a single UPDATE with a CAS predicate. Multiple concurrent
claimants produce exactly one winner (verified A05/A06/A07 with 2/4/8
real child processes).

## Stale owner fencing
A claim that has passed its TTL is reclaimable. The previous owner cannot
markCompleted (CAS rejects). Verifier A08/A09/A10 walks the full sequence:
  A owns (short TTL) -> lease expires -> B claims -> A complete refused -> B complete accepted

## Idempotency
createOrGetOperation is idempotent on (operationType:jobId:leaseId). Verifier
A04 (same process) and A18 (independent processes) both confirm one durable
row for the logical operation.

## No process-local coordination
All claims, counts, and ownership checks go through PostgreSQL. A20 proves
async-store writes are invisible in the SQLite side (no silent fallback).
