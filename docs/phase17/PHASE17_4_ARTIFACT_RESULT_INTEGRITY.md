# Phase 17.4: Worker Artifact, Log & Result Integrity

## Overview
Phase 17.4 introduces a production-grade integrity layer for worker-produced artifacts, stdout/stderr logs, execution results, and evidence. It provides cryptographic hashing, deterministic canonicalization, size limits, storage reference security, secret redaction, and correlation validation without replacing existing Phase 11–17.3 systems.

## Architecture
- `integrity.ts` – SHA-256 hashing, canonicalization, result digest, size limits, storage reference safety, secret redaction, checksum verification.
- `result-integrity.ts` – Result identity and digest validation.
- `worker-agent.ts` – Extended to attach stdout/stderr SHA-256 and result digest to real sandbox execution results.

## Hashing
- Uses Node's `crypto.createHash('sha256')`.
- Supports Buffer, Uint8Array, and string inputs.
- Known SHA-256 test vectors are verified in tests.

## Canonicalization
- Deterministic JSON canonicalization with sorted object keys.
- Result digest is computed over the canonical representation.

## Size Limits
- `MAX_ARTIFACT_SIZE` = 10 MB
- `MAX_STDOUT_SIZE` = 5 MB
- `MAX_STDERR_SIZE` = 5 MB
- `MAX_METADATA_SIZE` = 1 MB
- Oversized payloads are rejected.

## Storage Security
- Opaque storage references are validated.
- Path traversal (`..`), absolute paths, and unsafe URI schemes are rejected.

## Secret Handling
- Recursive redaction for sensitive keys (token, password, credential, secret, authorization, privateKey).
- Raw credentials are never stored in metadata, evidence, or audit events.

## Result Integrity
- `computeResultDigest()` computes a deterministic SHA-256 over canonical result.
- `verifyResultDigest()` verifies digest.
- `ResultIntegrityValidator.validateIdentity()` checks worker/job/attempt/dispatch/lease/session binding.

## Test Coverage
- 66/66 tests pass, including real process execution with stdout/stderr capture.

## Environment Limitations
- No live external GitHub/Jenkins/remote worker integration was executed.
- Integrity verification is local and deterministic.
