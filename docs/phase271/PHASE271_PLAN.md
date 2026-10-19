# NEXUS Phase 271 - Event Redaction and Emission Integrity

## Objective

Close the key-based redaction gap in the event emission path. The `events`
store has no redaction contract today, unlike the audit ledger
(`AuditRecord.metadata` is documented as "always secret-redacted before
storage"). This phase applies `redactSecrets()` inside `EventService.emit` so
payload fields with sensitive keys (password, token, authorization, api_key,
connectionstring, etc.) are replaced with `[REDACTED]` before persistence.

Scope boundary: this is key-based redaction, not pattern-based. A raw
connection string under a non-sensitive key (e.g., `{ error: "postgres://..." }`)
still passes through. Closing that wider gap - pattern-based scrubbing of
URLs, tokens, and PEM blocks in string values - is a separate phase.

Note: `release-recovery-executor.ts:206` emits error messages under the key
`error`, which is NOT in SENSITIVE_KEYS. This phase therefore documents that
path as a known residual risk; it does not claim to fix it. The fix for that
path is to either rename the key to `connectionstring` (if the error message
is expected to carry a URL) or to add pattern-based redaction (separate phase).

This phase is additive and hardening-only. Do not redesign NEXUS, do not weaken
existing event payload semantics (non-secret fields must pass through untouched),
and do not introduce new failure modes into the event hot path.

## Baseline

- Phase start commit: 36addee (tag: phase270-postgres-crash-restart)
- Working tree at phase start: clean
- Phase 269/270 recovery test suite: 596 assertions, all passing
- Audit ledger redaction already proven via worker-*-audit.ts (25 modules) and
  test-phase166-audit-provenance-integrity.ts

## Gap confirmed by inspection

1. `src/core/events.ts:emit()` writes `payload: input.payload ?? {}` directly
   to the events store with no processing.
2. `src/core/types.ts:399` — `NexusEvent.payload: Record<string, unknown>` has
   no documented redaction contract (compare to `AuditRecord.metadata:414`
   which explicitly says "always secret-redacted before storage").
3. `src/core/release-recovery-executor.ts:206` — `events.emit({ payload: {
   intentKey, error: "reconciliation failed: " + e.message } })` is the
   confirmed raw-error-message leak path.
4. `src/core/secret-redaction.ts` — `redactSecrets<T>()` exists, covers 20+
   sensitive keys (password, token, authorization, connectionstring, databaseurl,
   bearer, etc.), recurses into objects and arrays, and is already used by the
   audit family.

## Coverage

### Section 1: Redaction in EventService.emit

Apply `redactSecrets()` to `input.payload` inside `EventService.emit` before
the `engine.put()` call. The event is persisted with redacted payload; the
in-memory `event.payload` field reflects what was persisted.

### Section 2: Explicit redaction contract on NexusEvent.payload

Add a comment on `NexusEvent.payload` in `types.ts` documenting the redaction
guarantee (mirroring the existing comment on `AuditRecord.metadata`).

### Section 3: Direct tests

`scripts/test-phase271-event-redaction.ts`:
  - 271-1: emit() scrubs secret-shaped string values under sensitive keys
    (top-level object with `{ password: "..." }`)
  - 271-2: emit() recurses into nested objects (`{ outer: { token: "..." } }`)
  - 271-3: emit() recurses into arrays (`{ tokens: ["...", "..."] }`)
  - 271-4: emit() preserves non-secret fields byte-for-byte
    (`{ reason: "timeout", intentKey: "abc" }` survives unchanged)
  - 271-5: emit() handles null and undefined payloads safely
  - 271-6: the persisted row in the events store contains no secret-shaped
    substrings for a payload that was emitted with one
  - 271-7: the executor's `release.recovery.error` path (line 206) has its
    error.message scrubbed if it looks like a connection string
  - 271-8: hot-path safety - 1000 emits complete in under 2 seconds
    (guards against pathological performance)

### Section 4: Regression coverage

All existing Phase 144-270 assertions continue to pass:
  - 596 assertions across the 16-step harness
  - phase269a (B1-B4 failure injection), phase269b (A1-A3 observability)
  - phase270a (crash-restart), phase270b (shutdown), phase270c (server restart)

## Invariants that must remain true

- Non-secret event payload fields are preserved byte-for-byte (no accidental
  redaction of legitimate values)
- The events store is append-only; no update or delete path is introduced
- Event ordering (`seq`) is preserved
- Event listeners still receive the (already-redacted) event with the same
  shape they expect
- Emit remains serialized through `globalChain` (concurrent emits do not
  interleave)
- No performance regression on the hot path (Section 3 test 271-8 enforces
  the bound)

## Safety and scope

- No production code change outside `events.ts`, `types.ts` (comment only),
  and the new test file
- No modification to `redactSecrets()` itself (it's already proven by 25
  audit modules)
- Do not retroactively scrub existing events rows (out of scope)
- Do not broaden the sensitive-key list beyond what `redactSecrets` already
  covers (that's a separate decision)

## Completion criteria

- All 8 Phase 271 tests pass
- All 596 prior assertions continue to pass unchanged
- Harness (scripts/phase266-verify.ps1) extended with phase271 step, runs
  green at 17 steps
- `NexusEvent.payload` has an explicit redaction comment
- `docs/phase271/PHASE271_REPORT.md` documents: baseline, coverage matrix,
  performance verification, and confirmation that the
  release-recovery-executor.ts:206 leak path is now scrubbed
- Tag `phase271-event-redaction` created and pushed on the final commit
- No regression in any prior phase

## What is not covered

- Retroactive scrubbing of events rows written before Phase 271
- Expansion of the sensitive-key list (goes beyond current contract)
- Redaction of `AuditRecord.metadata` (already covered by other modules)
- Detection of secret-shaped substrings in string values (only key-based
  redaction is applied; a raw `"ghp_..."` string under a non-sensitive key
  passes through by design, matching current audit behavior)
- `release-recovery-executor.ts:206` (`{ error: "..." }` payload) — the key
  `error` is not in SENSITIVE_KEYS, so error messages remain unredacted. This
  is documented as a known residual risk. Closing it requires either renaming
  the key or adding pattern-based redaction (separate phase).