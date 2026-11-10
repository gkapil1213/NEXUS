# WP7 — Kernel initialization and readiness

**Classification: PASS**

## What is verified

| # | Claim | Evidence |
|---|---|---|
| 1 | `boot()` completes persistence init before exposing manager | `kernel.ts:_boot()`: `this.services = { ... }` at line 959, `await audit.record(...)` at line 998, and `this.status = "ready"` at line 1006 occur in that order. Status flips to `"ready"` only after every boot side-effect succeeds, immediately before `return this.services`. If `audit.record()` throws, `status` stays `"booting"` until the catch at line 1007 flips it to `"failed"` — there is no window where `services` is set and `status === "ready"` while boot is still in flight. (The reordering from "status = ready before audit.record" was done in commit 5fd6e36 specifically to close that race.) On failure, `_boot()` catches (line 1007), sets `status = "failed"` (line 1008), records `this.failure` (line 1009), and re-throws. `boot()` (lines 246–251) clears `bootPromise` on failure so a subsequent call retries cleanly. |
| 2 | Ordinary boot does not open TCP listener | `run-kernel-gateway-integration.ts` T4: `PASS: T4 boot() did NOT open a TCP listener`. Structurally: `server.listen()` is only reached via `worker-gateway.ts:start()` (line 92), which is only called via `kernel.startGateway()`, which is never called by `boot()`. |
| 3 | `startGateway()` cannot start before successful boot/readiness | `kernel.ts:startGateway()` guards: `if (!CONFIG.gateway.enabled) return;` then `if (!this.services || this.status !== "ready") throw NOT_BOOTED`. Added in commit `1a90a0f`. Closes two partial-boot windows: (a) failure before line 959 → `services` undefined, `workerGateway` set; (b) failure after line 959 (e.g., `await audit.record()` at line 998 throws) → `services` set, `status` becomes `"failed"` at line 1008 without clearing `services`. The `GATEWAY_NOT_WIRED` check retains its existing meaning for the "never booted at all" case (`workerGateway` undefined). |
| 4 | Recovery runs before listener accepts requests | `worker-gateway.ts:start()` (lines 86–99): `await this.recoverIncompleteMessages()` at line 89 precedes `server.listen()` at line 92 within the same async IIFE. Enabled by commit `9d06552`: before that fix, `handlerTracker` was null (raw `better-sqlite3 Database` passed as `engine` has no `.kind`), so `recoverIncompleteMessages()` early-returned with `UNAVAILABLE_SCHEMA`. After `9d06552`, the recovery pass executes and boot-log order confirms: `phase292b.inspect` + `phase291.recovery` events fire before T6's listener assertion. |
| 5 | Recovery failure prevents listener startup | `test-phase291-worker-gateway-recovery-safety.ts` S5: `PASS: S5 recovery failure propagates (blocks start)`. Structurally: if `recoverIncompleteMessages()` throws, `start()`'s async IIFE rejects, `listeningPromise` rejects, and `server.listen()` at line 92 never runs. |
| 6 | Repeated startup calls safe, no duplicate listeners | `run-kernel-gateway-integration.ts` T7: `PASS: T7 repeated startGateway() does not create a second listener`. Also T16: `PASS: T16 repeated stopGateway() is idempotent`. Guarded at two levels: `worker-gateway.ts:start()` line 87 returns cached `listeningPromise`; `kernel.ts:startGateway()` guards on `this.gatewayStarted`. |
| 7 | Disabled gateway configuration remains disabled | `kernel.ts:startGateway()` first executable line: `if (!CONFIG.gateway.enabled) return;`. `run-kernel-gateway-integration.ts` T5: `PASS: T5 startGateway() when disabled is a no-op`. |

## Evidence prerequisites

- **`9d06552`** — fixed `kernel.ts` to pass `engine` (an `SQLiteEngine` with `readonly kind = "sqlite"`) instead of `rawDb` (a bare `better-sqlite3 Database`) to `WorkerGateway`. Before this fix, `WorkerTransportSecurity.hasHandlerTrackingSchema()` returned `false` (raw `Database` has no `.kind`), `handlerTracker` stayed `undefined`, and `recoverIncompleteMessages()` early-returned with `UNAVAILABLE_SCHEMA`. After `9d06552`, recovery executes and claim 4 becomes observable and meaningful.
- **`1a90a0f`** — added the `!this.services || this.status !== "ready"` guard in `kernel.startGateway()`, closing claim 3's partial-boot windows.

## Test evidence files

- `scripts/run-kernel-gateway-integration.ts`: T1–T16, 38 PASS / 0 FAIL.
- `scripts/test-phase291-worker-gateway-recovery-acceptance.ts`: T1–T13, 34 PASS / 0 FAIL.
- `scripts/test-phase291-worker-gateway-recovery-safety.ts`: S1–S8, 12 PASS / 0 FAIL.

## Known limitations

Claims 1 and 3 are verified by **code inspection plus explicit guards**, not by a failure-path test. Injecting a boot failure mid-flight (e.g., between `this.services = {...}` at line 959 and `this.status = "ready"` at line 997, or at `await audit.record()` at line 998) would require a test seam the kernel does not currently expose. The guards are the explicit assertion that these failure states are rejected by `startGateway()`.

A future improvement would be to expose a test-only seam for `initializeAsync()` failure or `audit.record()` failure, enabling direct verification of the `NOT_BOOTED` path. Until then, the inspection reasoning is:

- `_boot()` catch (line 1007) sets `status = "failed"` (line 1008) but does NOT clear `this.services`.
- `startGateway()` guard rejects `status !== "ready"` regardless of whether `services` is set.
- Therefore any partial-boot failure state is rejected at `startGateway()`.