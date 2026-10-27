# NEXUS Phase 285 — Resolve Square-Bracket Punctuation Correctly

Fix the remaining square-bracket punctuation issue in the existing NEXUS repository. Do not restart Phase 285, redesign the system, commit, push, or use destructive Git commands.

## Inspect first
- src/core/secret-redaction.ts
- scripts/test-phase285-runtime-redaction-callsite-audit.ts
- docs/phase285/PHASE_REPORT.md
- docs/phase285/FINDINGS.md
- artifacts/phase285/test-output.txt

Before modifying an existing file, create a timestamped backup. Preserve the current working tree and all phase artifacts.

## Required exact behavior

1. Lone trailing bracket:
Input: error: token=ABC123]
Expected: error: [REDACTED:embedded_credential]

2. Paired brackets:
Input: [token=ABC123]
Expected: [[REDACTED:embedded_credential]]

3. Preserve other punctuation:
- error: token=ABC123. -> error: [REDACTED:embedded_credential].
- error: token=ABC123, -> error: [REDACTED:embedded_credential],
- error: token=ABC123; -> error: [REDACTED:embedded_credential];
- error: (token=ABC123) -> error: ([REDACTED:embedded_credential])

4. Short credentials must be redacted:
- token=ABC123
- password=PW123
- api_key=KEYSHORT

Inspect the actual regex and replacement logic. If regex-only replacement cannot safely distinguish the bracket cases, use a narrowly scoped context-aware replacement. Never globally strip closing brackets or weaken secret matching. Keep the public API stable.

## Regression tests and evidence

Add exact-string regression assertions to the existing runtime test, exercising the real redactText implementation. Keep assertion counts dynamically derived from actual checks.

Update docs/phase285/PHASE_REPORT.md and docs/phase285/FINDINGS.md to document the contract and actual results. Update artifacts/phase285/test-output.txt only with results from real test executions; do not fabricate results.

## Run and record actual verification

- npm run test:phase285
- npm run test:phase273
- npm run test:phase277
- npm run test:phase278
- npm run test:phase284
- npm run test:phase180
- npx tsc --noEmit
- git diff --check

Capture each actual exit code. Inspect the final diff and status. Do not commit or push.

Report changed files, backup paths, actual test results, assertion counts, and final Git status. Claim full completion only if the bracket tests and all required checks pass. Report failures or unexecuted checks honestly.
