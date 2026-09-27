# Phase 209 - Verification

## CLI

    npx tsx scripts/verify-phase.ts 207
    npx tsx scripts/verify-phase.ts 208
    npx tsx scripts/verify-phase.ts 209

Exit codes: 0 PASS / 1 FAIL / 2 BLOCKED / 3 UNVERIFIED / 4 MANIFEST_ERROR

## Artifacts written per run

    artifacts/phase<N>/verification-run.json
    artifacts/phase<N>/verification-results.json
    artifacts/phase<N>/verification-summary.json

## Phase 209 scenarios (all verified)

| ID | Scenario |
|---|---|
| 209A | manifest validation |
| 209B | actual-result aggregation |
| 209C | missing test detection |
| 209D | unexpected test detection |
| 209E | result hashing determinism |
| 209F | evidence hashing determinism |
| 209G | commit mismatch detection |
| 209H | tamper detection (PASS count edit) |
| 209I | result digest tamper |
| 209J | duplicate result detection |
| 209K | non-zero exit code handling |
| 209L | BLOCKED handling |
| 209M | NOT_EXECUTED handling |
| 209N | canonical + sha256 correctness |
| 209O | concurrent verification determinism |
