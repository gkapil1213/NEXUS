# Phase 214 - Security

## Protections

- Idempotency: UNIQUE(idempotency_key) on engineering_runs. Two racing
  creators cannot both insert (214C/214D prove it).
- Ownership: stage transitions CAS on (id, run_id, expected_capability_status);
  stale-expected writers lose (214H/214T).
- Worker fencing: worker-actor transitions require a valid ACTIVE lease
  (214S). Reuses the Phase 206/213 fence.
- Terminal immutability: parent execution_jobs terminal states are read-only
  at the metadata layer (214R).
- Cancellation: first cancel sets a durable terminal marker; second cancel is
  rejected (214X/214Y).
- Event journal: engineering_run_events is append-only; no secrets are written
  (payloads carry ids, reasons, artifact refs only).

## What Phase 214 does NOT weaken

- Phase 201-213 execution invariants (admission, dispatch, lease, fencing,
  finalization) are untouched.
- Phase 210 release safety gate is untouched.
- Phase 211/212/213 release execution and recovery are untouched.
