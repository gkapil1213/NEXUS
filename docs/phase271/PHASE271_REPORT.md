# Phase 271 - Event Redaction and Emission Integrity

## Baseline

- Phase start commit: 36addee (tag: phase270-postgres-crash-restart)
- Working tree at phase start: clean
- Pre-fix `secret-redaction.ts`: string values passed through unchanged;
  `isSensitive` used reverse-substring matching.

## Gaps confirmed by inspection

1. `EventService.emit` in `src/core/events.ts` passed `input.payload` directly
   to persistence and listeners with no redaction.
2. `redactSecrets` had a reverse-substring clause (`sk.includes(lowerKey)`)
   that redacted any key whose name appeared inside a sensitive key name.
   This caused false positives for single-character and short field names
   (`a`, `b`, `ok`) whose names happen to appear inside `"password"`,
   `"bearer"`, `"cookie"`.
3. String values were passed through unchanged, meaning URL credentials
   embedded in free-text error strings (e.g., `error: "Connection failed:
   postgres://u:secret@h/db"`) leaked into the durable events store.
   This was the exact path flagged by `release-recovery-executor.ts:206`.

## Implementation

### src/core/secret-redaction.ts

Two changes:

1. Reverse-substring matching removed from the sensitive-key matcher:
       (sk) => lowerKey === sk || lowerKey.includes(sk)
   (was: `... || sk.includes(lowerKey)`)

2. String values are scanned for embedded URL credentials:
       if (typeof input === 'string') {
         return input.replace(
           /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi,
           '$1[REDACTED]@'
         ) as T;
       }
   URL authority (`user:pass@`) is replaced with `[REDACTED]@`. Scheme and
   surrounding text is preserved. This reduces URL-credential
   exposure in free-text error messages; other secret formats may remain undetected.

### src/core/events.ts

    import { redactSecrets } from "./secret-redaction";
    ...
    payload: (input.payload ? redactSecrets(input.payload) : {}) as Record<string, unknown>,

Redaction applied before `engine.put("events", ...)` and before listener
notification. Both the persisted event and the listener-visible event carry
the redacted payload.

### src/core/types.ts

    payload: Record<string, unknown>; // always secret-redacted before storage

Documents the redaction contract.

### scripts/test-phase271-event-redaction.ts (new)

20 assertions across 8 tests:
- 271-1: top-level sensitive key redaction, non-secret preserved
- 271-2: nested object recursion
- 271-3: array under sensitive key redacted whole
- 271-4: non-secret fields preserved byte-for-byte (5 assertions)
- 271-5: null / undefined payload safety
- 271-6: persisted row scan finds no raw secret
- 271-7a: `connectionstring` key redacted (whole-value)
- 271-7b: URL credentials redacted inside free-text strings (3 assertions)
  - credentials must not remain in stored error text
  - URL authority visibly redacted (`postgres://[REDACTED]@h/db`)
  - surrounding error context preserved
- 271-8: 1000 emits < 2000ms

## Verification evidence

Command: npx tsx scripts/test-phase271-event-redaction.ts
Result: PASS: 20 / FAIL: 0 / BLOCKED: 0 / exit 0

Observed assertion values:
  271-1: password="[REDACTED]", user="alice"
  271-2: outer.token="[REDACTED]", name="svc"
  271-3: tokens="[REDACTED]" (whole value), label="x"
  271-4: reason="timeout", code=42, ok=true, nested.a=1, nested.b=[1,2,3]
  271-5: undefined payload becomes empty object
  271-6: serialized payload contains no raw secret value
  271-7a: connectionstring="[REDACTED]", note="x"
  271-7b: got="Connection failed: postgres://[REDACTED]@h/db (retry later)"
  271-8: full harness run 827ms; bound 2000ms (earlier targeted runs: 364ms and 531ms)

Command: npx tsc --noEmit
Result: exit 0

Command: git diff --check
Result: exit 0

Command: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/phase266-verify.ps1
Result: 16/16 steps exit 0, FAILURE GATE: all registered steps returned exit 0.
Steps passed: tsc, phase144, phase157, phase178, phase197, phase198,
phase199, phase264, phase265, phase269a, phase269b, phase266, phase270a,
phase270b, phase270c, diffcheck.

Regression coverage: 596 assertions from phases 144-270 unchanged.

## Security posture

Event payload redaction is applied before event persistence and listener
notification.

1. **Sensitive-key redaction:** values under recognized sensitive keys are
   replaced with `[REDACTED]`. Arrays under sensitive keys are redacted as
   whole values, as covered by test 271-3.

2. **URL-credential redaction:** URL-shaped user-info credentials in string
   values are replaced with `[REDACTED]`. Test 271-7b verifies a
   PostgreSQL-style URL and confirms that surrounding error context remains.

3. **Residual coverage limits:** this is not universal secret detection.
   Secrets in unrecognized formats, strings, or fields may remain undetected.
   The `release-recovery-executor.ts:206` call site still emits
   `error.message` under the `error` key; the shared event-boundary redactor
   handles URL-shaped credentials but does not guarantee that all secrets
   in the message are removed.

4. **Potential false positives:** sensitive-key matching may redact legitimate
   fields whose names match configured sensitive-key patterns. Review this
   trade-off if the key-matching strategy changes.

These checks validate the implemented behavior covered by the tests. They
do not constitute a comprehensive production security audit or prove that
every possible secret format is detected.

## Blocked checks

None. All verification steps executed successfully.

## Current Git status

Uncommitted changes ready for review (per plan instructions):

    M src/core/events.ts
    M src/core/secret-redaction.ts
    M src/core/types.ts
    ?? scripts/test-phase271-event-redaction.ts
    ?? docs/phase271/PHASE271_REPORT.md

No commit, tag, push, or history rewrite performed.

## Sign-off

Targeted Phase 271 tests: 20 passed, 0 failed, 0 blocked.
TypeScript compilation: exit 0.
`git diff --check`: previously reported exit 0, with a line-ending warning.
Full regression harness: all 16 registered steps exited successfully after
the source redaction change.

These results support the tested implementation and recorded regression
checks. They are not a comprehensive production security audit. Review the
residual limitations above before treating event redaction as complete.
