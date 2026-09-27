# Phase 209 - Architecture

Phase 209 adds a verification-integrity layer on top of Phase 201-208. It does
not modify the scheduler, ExecutionStore, lease manager, or completion APIs.
It enforces that a phase verdict derives from real test execution, not from
hand-authored JSON.

## Components

- src/core/verification-integrity.ts   - pure verdict + digest functions
- src/core/verification-manifest.ts    - required-test manifests for 207/208/209
- src/core/verification-evidence.ts    - integrity verifier (fail-closed)
- scripts/verify-phase.ts              - CLI: runs phase suite, persists run
- scripts/verify-phase208-evidence.ts  - legacy Phase 208 artifact check
- scripts/phase209-evidence.ts         - evidence generator (no hardcoded counts)

## Data flow

    npx tsx scripts/verify-phase.ts <phase>
      | loads Manifest
      | execSync scripts/test-phase<N>-*.ts
      | captures exit code + stdout
      | parseTestOutput -> [PASS]/[FAIL]/[BLK ]/[N/E ] lines
      | computeVerdict: required ids, unexpected ids, duplicates, exit code
      | digestResults  -> resultDigest
      | evidenceDigest -> evidenceDigest
      | writes artifacts/phase<N>/verification-{run,results,summary}.json
      | exit 0=PASS 1=FAIL 2=BLOCKED 3=UNVERIFIED 4=MANIFEST_ERROR

## Fail-closed rules

PASS requires ALL:

- test process exit code == 0
- every manifest-required id present in stdout
- no unexpected id
- no duplicate id
- PASS == required count, FAIL == 0, BLOCKED == 0,
  NOT_EXECUTED == 0, UNVERIFIED == 0
