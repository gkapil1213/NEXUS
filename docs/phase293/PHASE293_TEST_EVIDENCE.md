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

This file and PHASE293_IMPLEMENTATION_REPORT.md are the available canonical evidence documents. The expected phase293-verification.json artifact was NOT FOUND during the November 4, 2026 verification.

## External integrations

**AWS Secrets Manager**: NOT EXECUTED against real AWS. Hermetic provider tests pass (15 assertions). Live integration requires AWS account credentials.


---

## Addendum — Phase 132 re-run against final Phase 293c worktree

Per Phase 293c closure procedure, the Phase 132 durable CI reconciliation suite
was re-executed against the worktree containing the final Phase 293c changes
(`error-sanitizer.ts` closed allowlist, `cicd-reconciliation.service.ts` eight
sanitized sinks, `health-agent.ts` sanitized `failure_reason`).

This run is a **confirmation**, not a first observation. An earlier run in the
same worktree state had already produced 34/34 with preserved classifications
recorded above. The addendum documents the re-verification so the final state
is provable from a single isolated invocation.

| | |
|---|---|
| Command | `npx tsx scripts/test-phase132-ci-reconciliation.ts` |
| Exit code | `0` |
| Assertions | 34 |
| Passed | 34 |
| Failed | 0 |
| Result | **PASS** |

T09–T16 preserved classification confirmation:

- T09 `missing artifact -> BLOCKED`
- T10 `ambiguous artifacts -> BLOCKED`
- T11 `ARTIFACT_VALIDATION_FAILED:EXECUTION_ID_MISMATCH`
- T12 `ARTIFACT_VALIDATION_FAILED:COMMIT_SHA_MISMATCH`
- T13 `ARTIFACT_VALIDATION_FAILED:EXTERNAL_RUN_ID_MISMATCH`
- T14 `ARTIFACT_VALIDATION_FAILED:MALFORMED_IMAGE_DIGEST`
- T15 `ARTIFACT_VALIDATION_FAILED:IMMUTABLE_REFERENCE_MISMATCH`
- T16 `ARTIFACT_VALIDATION_FAILED:REPOSITORY_MISMATCH`

No `handler_error` collapse. No regression. Worktree preserved: no reset,
clean, stage, or commit performed; unrelated user modifications
(`.semgrepignore`, `scripts/run-security-scan.ts`, `src/core/security-policy.ts`,
`src/core/worker-transport-security.ts`) untouched.
---

## Addendum — Phase 293c persistent sanitization verification

| Field | Result |
|---|---|
| Test suite | scripts/test-phase293c-persistent-sanitization.ts |
| Assertions | 818 |
| Passed | 818 |
| Failed | 0 |
| Not tested | 0 |
| Exit code | 0 |
| Result | PASS |

The persistent sanitization regression suite completed successfully.
This verifies the tested behavior, not production deployment or live
external integrations.

## Phase 132 CI reconciliation confirmation

| Field | Result |
|---|---|
| Command | `npx tsx scripts/test-phase132-ci-reconciliation.ts` |
| Assertions | 34 |
| Passed | 34 |
| Failed | 0 |
| Exit code | 0 |
| Result | PASS |

T09–T16 retained their expected artifact validation classifications.
## Addendum — Final Phase 293c real-persistence verification

Date: November 4, 2026

The persistent sanitization regression suite was re-executed after replacing
the mocked HealthAgent test with a real HealthAgent and ObservabilityService
persistence check.

| Check | Result |
|---|---:|
| Assertions | 834 |
| Passed | 834 |
| Failed | 0 |
| Not tested | 0 |
| Exit status | 0 |

The real T4 test verified:
- A health record was persisted through ObservabilityService.
- The health status was BLOCKED for the deliberately unreachable test target.
- The stored target contained the URL origin, including its non-default port,
  but excluded the URL path and query.
- The persisted record and engine readback contained none of the test sentinel
  values.

Phase 132 CI reconciliation regression suite: 34/34 passed.
TypeScript (`npx tsc --noEmit`): passed.

These results establish local regression-test and typecheck outcomes only.
They do not establish production deployment, live external integration,
or authorization for external security testing.