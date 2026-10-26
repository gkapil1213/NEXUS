# Phase 285 â€” Findings

Classified per the Phase 285 prompt's Section 7 categories: `Confirmed defect`,
`Coverage gap`, `Not applicable`, `Blocked / not executed`.

## Confirmed defects â€” FIXED

### F-1. emitServerEvent non-string value bypass

- Classification: Confirmed defect (fixed)
- File: `src/server/logging.ts:48-65`
- Defect: Non-string field values (objects, arrays, Errors) reached `process.stdout.write` unredacted.
- Fix round: 43
- Regression test: `test-phase285` Section 1
- Evidence: Round 42 (pre-fix): nested `{ password: <sentinel> }` reached stdout. Round 43 (post-fix): sentinel absent.

### F-2. emitAccessLog query-string leak

- Classification: Confirmed defect (fixed)
- File: `src/server/http.ts:74-88`
- Defect: Access-log `path` field recorded `req.originalUrl || req.url` â€” including query strings with potential credentials.
- Fix round: 53
- Regression test: `test-phase285` Sections 2 and 3
- Evidence: Round 52 (pre-fix) probe: `path: "/health?token=TEST_SECRET&api_key=TEST_KEY"`. Round 53 (post-fix): `path: "/health"`.

### F-3. redactText short-credential floor

- Classification: Confirmed defect (fixed)
- File: `src/core/secret-redaction.ts:85`
- Defect: Embedded-credential pattern required a 12-character minimum value. Short credentials (`token=ABC123`, `password=PW123`, `api_key=KEYSHORT`) were not redacted.
- Fix rounds: 59 (initial), 72 (trailing period), 74 (lone-] reconciliation)
- Regression test: `test-phase285` Sections 4a, 4b, 4c, 4d, 4e, 4f, 4f2
- Evidence: Round 57 (pre-fix) probe: `redactText("token=ABC123")` returned `"token=ABC123"`. Round 60 (post-fix): `"[REDACTED:embedded credential]"`.
- Interim regression: Round 58 exposed that the first pattern revision consumed `[REDACTED:github_token]` as a value, breaking `test-phase273:273-1`. Round 59 added negative lookahead `(?!\[REDACTED:)`. Round 60 confirmed 273-1 green.

### F-4. redactText punctuation consumption

- Classification: Confirmed defect (fixed)
- File: `src/core/secret-redaction.ts:85`
- Defect: Value sub-pattern consumed trailing `)`, `]`, `}`, `.` as part of the credential value. `error: (token=ABC123)` produced `error: ([REDACTED:embedded credential]` â€” losing the closing paren.
- Fix rounds: 64 (brackets), 72 (period)
- Regression test: `test-phase285` Sections 4f, 4f2
- Evidence: Round 62 (pre-fix) probe showed all six cases losing trailing chars. Round 64 (post-fix for brackets): `error: ([REDACTED:embedded credential])`. Round 72 (post-fix for period): `error: [REDACTED:embedded credential].`

## Coverage gaps â€” NOT EXECUTED

### G-1. worker-gateway.ts:88 â€” error response body

- Classification: Coverage gap
- File: `src/core/worker-gateway.ts:88`
- Observation: `this.send(res, 400, { error: e.message || "gateway_error" })` â€” the raw `e.message` reaches the 400 response body. If `handleMessage` throws a credential-bearing message, it leaks to the HTTP client.
- Why not a confirmed defect: No test constructs a credential-bearing `handleMessage` exception. The shape exists but the leak isn't demonstrated.
- Status: NOT EXECUTED â€” coverage gap, not defect.

### G-2. AuditService.record direct string fields

- Classification: Coverage gap
- File: `src/core/audit.ts:154-173`
- Observation: `actor`, `action`, `resource_type`, `resource_id` are assigned verbatim to the record without `redactText`.
- Why not a confirmed defect: Typical callers pass user email (`actor`), fixed action names (`action`), fixed resource types (`resource_type`), and IDs (`resource_id`) â€” not user-controlled credential text. `test-phase180` exercises `AuditService.record` indirectly; no assertion checks these fields for credential absence.
- Status: NOT EXECUTED â€” coverage gap.

### G-3. Lone `]` punctuation case — OPEN

- Classification: Observed output inconsistency; not resolved.
- File: `src/core/secret-redaction.ts`, `redactTextWith` and `SECRET_TEXT_PATTERNS`.
- Current implementation: `redactTextWith` applies the configured patterns and returns the result. There is no post-pattern cleanup that removes a closing bracket.
- Cause: The original input's `]` is preserved as punctuation, while the redaction marker also ends with `]`.
- Verified expected behavior in the current Phase 285 audit:
  - `redactText("error: token=ABC123]")` -> `"error: [REDACTED:embedded credential]]"`
  - `redactSecrets("error: token=ABC123]")` -> `"error: [REDACTED:embedded_credential]]"`
  - Paired-bracket inputs must continue to follow the explicit regression-test expectations.
- Regression coverage: `scripts/test-phase273-end-to-end-redaction.ts` and `scripts/test-phase285-runtime-redaction-callsite-audit.ts`.
- Status: OPEN — the duplicate closing bracket is documented, not fixed. Do not claim a cleanup regex resolves this behavior. The separate G-2 audit-field coverage gap remains unresolved.
### G-4. Trailing period after embedded credential â€” RESOLVED

- Classification: Resolved limitation
- File: `src/core/secret-redaction.ts:85`
- Original observation: `redactText("error: token=ABC123.")` returned `"error: [REDACTED:embedded credential]"` â€” the trailing `.` was consumed.
- Resolution (round 91): The credential-value sub-pattern was changed from `([^\s"',;)\]}>]{1,})` to `([^\s"',;)\]}>]*[^\s"',;.)\]}>])`. The final character is guaranteed non-period, so a trailing `.` is preserved. Internal periods (`token=AB.C123`) remain consumed as part of the value.
- Verification: `test-phase285` Section 4f2 and the round-91 probe. `error: token=ABC123.` -> `error: [REDACTED:embedded credential].`; `error: token=AB.C123` -> `error: [REDACTED:embedded credential]`.
- Status: RESOLVED â€” verified in round 93 (`test:phase285` 70/70).

## Not applicable â€” inspected and dismissed

### N-1. Authorization header logging

- Classification: Not applicable
- File: `src/server/auth-middleware.ts:30-38`
- Inspection: The `Authorization` header is extracted, validated via `sessions.validate`, and discarded. No `console.*`, `emitAccessLog`, `emitServerEvent`, or `engine.put` reference to the token. Error paths use fixed strings.
- Status: PASS (verified round 63).

### N-2. Non-credential headers

- Classification: Not applicable
- Files: `http.ts:55` (`x-request-id`), `http.ts:104` (`content-length`), `http.ts:106` (`content-type`), `worker-gateway.ts:63` (`content-type`)
- Inspection: Each is either a bounded validation (request ID regex) or a boolean check (content-type, content-length). None is a credential; none is stored or logged.
- Status: PASS.

## Persistence paths â€” NOT EXECUTED

23 `engine.put` sites across 5 files were inventoried but not traced. See `CALLSITE_INVENTORY.md` for the exact file:line list. All `NOT EXECUTED`.
