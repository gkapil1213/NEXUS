# Phase 285 — Runtime Redaction Call-Site Audit: Phase Report

## Status: PASS (scoped)

Phase 285 fixed and tested four redaction defects at real runtime boundaries
and verified four persistence/logging paths. It did not complete a full
logging-security review of the NEXUS codebase. Coverage gaps and untraced
paths are documented in `CALLSITE_INVENTORY.md` and `FINDINGS.md`.

## Baseline

- Branch: `master`
- HEAD commit: `5c6acd5` — "fix(audit): harden metadata redaction against Map key leaks, getter invocation, and hostile metadata"
- Working tree at phase start: 13 pre-existing modified files (Phase 268, 279, 283), 14 pre-existing untracked files. Preserved throughout.

## Defects fixed

### Finding 1 — `emitServerEvent` nested-value bypass

**File:** `src/server/logging.ts:48-65`

**Source:** `emitServerEvent(kind, fields: Record<string, unknown>)` accepted arbitrary field values.

**Transformation (pre-fix):** `typeof v === "string" ? redactText(v).slice(0, 256) : v` — non-string values (objects, arrays, Errors) passed through unredacted.

**Sink:** `JSON.stringify(line)` → `process.stdout.write` → log stream.

**Demonstrated:** Round 42 regression test constructed a nested `{ password: <sentinel> }` object; the sentinel reached stdout.

**Fix:** Replaced the `else` branch with `redactMetadata(v) as unknown` for non-string values. `redactMetadata` walks objects/arrays/Maps/Sets/Errors via descriptor-safe traversal, drops sensitive keys, and never invokes getters.

**Test evidence:** `test-phase285` Section 1 — 5 assertions. Red round 42, green round 43. No current caller regression (traced `scripts/run-server.ts`'s six call sites — all pass strings or primitives).

### Finding 2 — `emitAccessLog` query-string leak

**File:** `src/server/http.ts:74-88`

**Source:** HTTP request to `createHttpApp` with `accessLog: true`.

**Transformation (pre-fix):** Access-log middleware passed `req.originalUrl || req.url` — the full URL including query string.

**Sink:** `emitAccessLog({ path, ... })` → `clip(fields.path)` → `redactText` → `JSON.stringify` → `process.stdout.write`.

**Demonstrated:** Round 52 probe hit `/health?token=TEST_SECRET&api_key=TEST_KEY`; the access log line contained the query string verbatim. `redactText`'s embedded-credential pattern requires a 12-char minimum, so `TEST_SECRET` (11 chars) and `TEST_KEY` (8 chars) passed through.

**Fix:** Replaced `req.originalUrl || req.url` with `req.path` (Express pathname, no query string). If `req.path` is unavailable, fallback is `/` — never `req.originalUrl` or `req.url`.

**Test evidence:** `test-phase285` Sections 2 and 3 — 16 assertions (5 direct + 11 through real HTTP listener). Red round 52, green round 53.

### Finding 3 — `redactText` short-credential floor

**File:** `src/core/secret-redaction.ts:85` (embedded-credential pattern)

**Source:** Any diagnostic text containing a credential assignment (`token=ABC123`, `password=PW123`, `api_key=KEYSHORT`).

**Transformation (pre-fix):** Pattern `[/(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}["']?/gi, "[REDACTED:embedded_credential]"]` — required 12+ chars.

**Sink:** Any path that passes strings through `redactText` (audit metadata, server event errors, HTTP access log, evidence service, etc.).

**Demonstrated:** Round 57 probe showed `redactText("token=ABC123")` returns `"token=ABC123"` — no redaction.

**Fix:** Replaced with a lookbehind-anchored pattern that matches any value length ≥ 1, with:
- `(?<![A-Za-z0-9_])` — start-of-word boundary (rejects `xtoken=`, `my_token=`)
- Extended alternation including `access_token`, `refresh_token`, `id_token`, `auth_token`, `session_token`, `client_secret`, `passwd`, `pwd`
- `(?![A-Za-z0-9_]|_(?:at|ms|count|level|type|status|name|length|bytes|duration|index|size))` — SAFE_SUFFIXES exemption (preserves `token_count=42`)
- `(?:["']([^"']{1,})["']|(?!\[REDACTED:)(...))` — quoted values; negative lookahead `(?!\[REDACTED:)` preserves already-redacted markers (the 273-1 regression fix)

**Test evidence:** `test-phase285` Section 4a — 8 assertions. Red round 57, green round 60. Regression across `test-phase273`, `test-phase277`, `test-phase278`, `test-phase284` all green.

**Interim regression (round 58):** The first pattern revision consumed `[REDACTED:github_token]` as a value, producing `[REDACTED:embedded_credential]` for the 273-1 case. Round 59's negative lookahead `(?!\[REDACTED:)` fixed it. Round 60 verified all suites green.

### Finding 4 — `redactText` punctuation consumption

**File:** `src/core/secret-redaction.ts:85` (embedded-credential pattern value sub-pattern)

**Source:** Any diagnostic text where a credential assignment is adjacent to punctuation.

**Transformation (pre-fix):** Value sub-pattern `[^\s"',;]{1,}` consumed `)`, `]`, `}`, `.` as part of the value. `error: (token=ABC123)` produced `error: ([REDACTED:embedded credential]` — the closing `)` was lost.

**Sink:** Same as Finding 3.

**Demonstrated:** Round 62 probe showed all six punctuation cases losing their trailing characters.

**Fix (round 64):** Exclusion class extended to `[^\s"',;)\]}>]` — `)`, `]`, `}`, `>` stop the value. Trailing `)` / `]` / `}` preserved.

**Fix (round 72):** Trailing period support — the value sub-pattern became lazy `{1,}?` with a lookahead `(?=[\s"',;)\]}>]|\.(?=\s|$)|$)` so a `.` followed by whitespace/end-of-string stops the value and is preserved. A `.` followed by non-whitespace stays in the value (`token=a.b.c` fully consumed).

**Test evidence:** `test-phase285` Sections 4f (paired brackets) and 4f2 (trailing punctuation) — 17 assertions total. Red round 62, green rounds 64 + 72.

**Known limitation:** The lone `]` case (`error: token=ABC123]`) produces `error: [REDACTED:embedded credential]]` — two closing brackets. The pattern preserves the input's `]` as surrounding punctuation; the marker itself ends with `]`. This is a documented inconsistency with the round-74 directive's example (which expected a single `]`), reconciled in the test's inline comment. See FINDINGS.md.

## Persistence and logging paths verified

| Path | Verification |
|---|---|
| `audit.ts:170` — `redactMetadata` before `engine.put("audit")` | Source inspection, round 65 |
| `events.ts:50` — `redactSecrets` before `engine.put("events")` | Source inspection, round 41 |
| `auth-middleware.ts:30-38` — Authorization header extracted, validated, discarded | Source inspection, round 63 |
| `http.ts:74-88` — Access log uses `req.path` only; error envelopes fixed-message | Source inspection rounds 49, 63; tested by Sections 2 and 3 |

## Verification results (this phase's final run)

| Check | Command | Exit | Count |
|---|---|---|---|
| Focused Phase 285 | `npm run test:phase285` | 0 | 71 / 71 |
| Phase 273 regression | `npm run test:phase273` | 0 | 35 / 35 |
| Phase 277 regression | `npm run test:phase277` | 0 | 50 / 50 |
| Phase 278 regression | `npm run test:phase278` | 0 | 68 / 68 |
| Phase 284 regression | `npm run test:phase284` | 0 | 116 / 116 |
| Phase 180 regression | `npm run test:phase180` | 0 | 60 / 60 |
| TypeScript | `npx tsc --noEmit` | 0 | — |
| Whitespace | `git diff --check` | 0 | — (pre-existing CRLF warnings only) |

**Total: 400 assertions, all green across the six listed test suites.**

## Files changed

| File | Change |
|---|---|
| `src/server/logging.ts` | `emitServerEvent` non-string branch → `redactMetadata(v)` |
| `src/server/http.ts` | Access log `path: req.originalUrl \|\| req.url` → `path` (from `req.path`) |
| `src/core/secret-redaction.ts` | Embedded-credential pattern: 12-char floor removed, lookbehind/lookahead, `[REDACTED:` negative lookahead, punctuation exclusion, trailing-period lookahead |
| `scripts/test-phase285-runtime-redaction-callsite-audit.ts` | New file — 71 assertions across 5 sections |
| `package.json` | `test:phase285` registration |

## Repair backups preserved

Every edit created a `.bak` file alongside the source. All preserved:

- `src/server/logging.ts.phase285-prepatch-20261025-095643.txt`
- `src/server/http.ts.phase285-httpfix-*.bak`
- `src/core/secret-redaction.ts.phase285-shortcred-*.bak`, `.phase285-shortcred-fix-*.bak`, `.phase285-punctfix-*.bak`, `.phase285-periodfix-*.bak`
- `scripts/test-phase285-runtime-redaction-callsite-audit.ts.phase285-countfix-*.bak`, `.phase285-counterfix2-*.bak`, `.phase285-periodtest-*.bak`, `.phase285-bracketexpect-*.bak`
- `package.json.phase285-*.bak`

None deleted, overwritten, or moved.

## Residual risk and scope limitations

**Confirmed defects fixed:** 4 (Findings 1–4).

**Coverage gaps (identified, not tested):**
- `worker-gateway.ts:88` — `e.message` reaches the 400 response body without `redactText`. No credential-bearing error case is currently constructed in tests.
- `AuditService.record` direct string fields (`actor`, `action`, `resource_type`, `resource_id`) — persisted without `redactText`. No current caller passes credential-bearing data, but the contract isn't enforced or tested.

**Persistence paths inventoried but not traced:**
- `orchestration.ts` — 4 `engine.put` sites (lines 111, 139, 156, 168)
- `cicd.ts` — 5 sites (1112, 1149, 1164, 1267, 1414)
- `devops.ts` — 4 sites (460, 477, 500, 590)
- `services.ts` — 5 sites (180, 220, 251, 326, 411)
- `security-services.ts` — 10 sites (47, 63, 83, 120, 177, 220, 267, 339, 446, 473)

23 `engine.put` sites across 5 files. **Status: NOT EXECUTED.**

**Punctuation limitation:** The lone `]` case produces two closing brackets. Documented in FINDINGS.md.

## What Phase 285 does not establish

- That the entire runtime logging surface is secure
- That all persistence paths redact before write
- That every credential format is detected
- Production deployment readiness

**Phase 285 is a scoped verification of four specific defects and four specific paths. It is not a complete security audit of the NEXUS codebase.**
