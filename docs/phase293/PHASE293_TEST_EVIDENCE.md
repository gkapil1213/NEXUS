# Phase 293 Test Evidence

## Date

2026-11-02

## Branch

`phase-293b-final` (forked from `fb77827`)

## Test Suites

| Suite | Assertions | Result |
|---|---|---|
| `test-phase292b-key-provider.ts` | ALL OK (incl. retired-kid assertion) | PASS |
| `test-phase292b-gateway-quarantine.ts` | 8 | PASS |
| `test-phase292b-inspection.ts` | 25 | PASS |
| `test-phase292b-replay.ts` | 19 | PASS |
| `test-phase292b-aws-provider.ts` | 15 | PASS |
| `test-phase292b-aws-cli.ts` | 19 | PASS |
| `test-phase292-envelope-persistence.ts` | 35 | PASS |
| `test-phase293-log-sanitization.ts` | 8 | PASS |
| `test-phase293-provider-gate.ts` | 13 | PASS |
| `test-phase293-rotation.ts` | 9 | PASS |
| `test-phase293-failure-modes.ts` | 13 | PASS |
| `test-phase285-audit-and-gateway-error-redaction.ts` | 14 | PASS |
| `test-phase285-runtime-redaction-callsite-audit.ts` | 71 | PASS |
| `tsc --noEmit` | (silent) | PASS |

**Total: 230+ assertions across 12 test suites, all green.**

## Specific verifications

### Item 1 — belt-and-suspenders guard

`worker-gateway.ts:385` now has `if (envelopePersistFailed) throw new Error("envelope_persist_failed");`. Covered by `test-phase290b-worker-gateway-failure-modes.ts` T14.

### Item 3 — resolver extraction

`src/core/hmac-provider-resolver.ts` extracted verbatim. Kernel.ts:384-411 replaced with `await resolveHmacProvider(process.env)`. All existing kernel integration tests pass.

### Item 17 — handler_last_error sanitization

`sanitizeHandlerError()` applied at 4 write sites. `test-phase293-failure-modes.ts` F3 verifies path/SQL/secret sentinels are absent from `handler_last_error`.

### Item 13 — evidence

This file plus PHASE293_IMPLEMENTATION_REPORT.md and phase293-verification.json.

## External integrations

**AWS Secrets Manager**: NOT EXECUTED against real AWS. Hermetic provider tests pass (15 assertions). Live integration requires AWS account credentials.
