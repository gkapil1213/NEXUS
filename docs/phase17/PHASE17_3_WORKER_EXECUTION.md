# Phase 17.3: Worker Execution Sandbox & Execution Boundary

## Overview
Phase 17.3 introduces a real worker execution sandbox that performs actual OS process execution through a controlled boundary. It integrates with the existing WorkerSecurity and WorkerAgent without replacing the Phase 13/14 execution architecture.

## Architecture
- `worker-sandbox.ts` – Real process execution using `spawn` with `shell: false`.
- `worker-agent.ts` – Extended to use the sandbox when available, while preserving backward-compatible simulated behavior for older tests.
- `worker-config.ts` – Extended with execution root, environment allowlist, and allowed operations/executables.

## Execution Lifecycle
1. Worker receives a job through the secure transport.
2. WorkerSecurity validates operation, executable, arguments, and working directory.
3. WorkerSandbox executes the allowlisted command in a controlled cwd with restricted environment variables.
4. stdout/stderr are captured with size limits.
5. Timeout and cancellation terminate the process.
6. Actual exit code and duration are reported.

## Security Model
- `shell: false` prevents arbitrary shell execution.
- Executable and operation allowlists are enforced.
- Arguments are rejected if they contain shell metacharacters (`;`, `&`, `|`, backticks).
- Working directory traversal (`..`) is prevented.
- Environment variables are filtered through an allowlist.
- Secrets are never exposed in output or errors.

## Timeout and Cancellation
- Configurable timeout kills the process (`SIGTERM` then `SIGKILL`).
- Cancellation marks the process as cancelled and kills it.
- Results after timeout/cancellation are never reported as successful.

## Workspace Behavior
- Execution uses a configurable `executionRoot`; workspace creation and cleanup are currently basic but can be extended.
- Path escape prevention is enforced through `WorkerSecurity`.

## Artifact Handling
- No new artifact transfer logic was added; existing Phase 13/16 artifact abstractions remain authoritative.

## Observability
- Execution evidence includes timestamps, duration, timeout, and cancellation state.
- No secrets are logged.

## Test Results
- Phase 17.3 tests: `26/26 PASS`
- Phase 15 regression: `21/21 PASS`
- Phase 16 regression: `41/41 PASS`
- Phase 17.1 regression: `23/23 PASS`
- Phase 17.2 regression: `34/34 PASS`
- TypeScript: PASS
- Production build: PASS
- git diff --check: PASS

## Environment Limitations
- No live GitHub/Jenkins/remote worker external integration was executed.
- TLS/network transport remains not implemented; local loopback transport used for verification.
- Workspace cleanup is minimal and not yet fully isolated per job.

