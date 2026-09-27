# Phase 211 - Security

## Protections verified by the 211 test matrix

- Release substitution: candidate.commitSha is bound through Phase 210 gate
  and matched against the verification run. 211C/211D.
- Artifact substitution: candidate.artifactDigest is matched against the run. 211E.
- Replay: authorization consumption is bound to a specific attemptId. 211X.
- Concurrent execution: fenced CAS on intent status + distributed lease. 211G/211H/211Z.
- Unauthorized transitions: transitionIfOwnedAsync rejects non-lease-holders. 211T.
- Secret leakage: intent rows and keys contain no secret tokens. 211AD.

## What Phase 211 does NOT do

- It does not weaken Phase 210's gate; evaluateReleaseSafety is called first
  and any non-ALLOWED result short-circuits the entire execution path.
- It does not introduce a force/skip/ignore bypass.
- It does not invent provider credentials or substitute environment config.

## Trust boundaries

- The provider implementation (ReleaseExecutionProvider) is supplied by the
  caller. Production callers pass a real provider; Phase 211 tests pass a
  test double confined to scripts/test-phase211-release-execution.ts.
- No shell commands are constructed from release metadata; the provider API
  is a typed TypeScript interface.
