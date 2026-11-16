# Phase 304c - Dependency and Reference Verification

Generated: 2026-11-16 10:19:20
READ-ONLY. No scripts executed. No files modified. No state files accessed.

## Summary

| Status | Count |
|---|---:|
| PASS | 1273 |
| FAIL | 0 |
| BLOCKED | 6 |
| NOT EXECUTED | 0 |
| **Total checks** | **1279** |

Files reviewed: 172
Import checks: 1139
Spawn checks: 6
PowerShell reference checks: 5
package.json chains verified: 129

## Check 1: TypeScript imports

| Status | Count |
|---|---:|
| PASS | 1139 |
| FAIL | 0 |
| BLOCKED | 0 |
| NOT_EXECUTED | 0 |


## Check 2: PowerShell invocations

| Status | Count |
|---|---:|
| PASS | 5 |
| FAIL | 0 |

## Check 3: package.json script chains

Verified 129 references in package.json scripts.
- PASS (file exists): 129
- FAIL (file missing): 0

## Check 4: Child-process execution paths

| Status | Count |
|---|---:|
| PASS | 0 |
| FAIL | 0 |
| BLOCKED | 6 |

BLOCKED items are external binaries (npx, node, docker, git) that cannot be verified statically.

## Check 5: Suspected duplicate tests (by content hash)

No byte-identical duplicate test files found.

## Check 6: Protected-state access

| File | State files referenced |
|---|---|
| `scripts/run-safe-regression.ts.before-v3-20261115085329` | approval-state.json, release-manifest.json, release-state.json, rollback-state.json |

## Check 7: Reconciliation

- Files reviewed: 172
- Total checks: 1279
- PASS + FAIL + BLOCKED + NOT_EXECUTED = 1279
- All checks accounted for: True
