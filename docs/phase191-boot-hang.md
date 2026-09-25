# Phase 191 — Kernel boot does not return KernelServices

## Symptom

`NexusKernel.boot()` returns `undefined` in the shared-persistence
environment when no Node host bridge is installed on
`globalThis.window.__NEXUS_HOST__`. It does not throw. It does not hang.
The instrumented trace runs the reconciler sweep to completion and then
prints `[P191] BOOT RETURNED undefined`.

## What this rules out

The earlier committed hypothesis — "boot hangs in the post-loop
reconciler pass" — is falsified. The reconciler sweep completes. Every
`[RECON] ENTER / EXIT` pair returns. Boot then returns.

## What this narrows to

`boot()` has exactly one success `return`:

    return this.services;

The only way it can return `undefined` is if `this.services` is
`undefined` at the point of return, or if a code path exits the
try-block early via a `return` with no value. The failure `catch` block
throws, so a thrown error would surface, not silently return.

The candidates, in order:

1. `this.services = { ... }` assignment is somehow skipped — e.g. an
   `await` above it resolves to a shape that bypasses the assignment.
2. A `return` statement inside the try-block that returns nothing.
3. The probe is printing `result.status` where the probe's helper
   returns `undefined` for a non-thrown success.

Candidate 3 is not a kernel bug — it would be a probe artifact. It needs
to be eliminated before any fix to `kernel.ts`.

## Does NOT block Phase 191

`CanonicalDeploymentOrchestrator` is constructible without the kernel.
`scripts/test-phase191-deployment-execution.ts` exercises the canonical
path against real Docker: 11/0/0, committed at 2704022.

## Recommended next step (dedicated session)

Print the raw `result` value, not `result.status`, from a clean boot
probe. If it is `{}` or a services object, the "hang" never existed and
the finding is that `kernel.boot()` returns services while a downstream
consumer expected a different shape. If it is literally `undefined`,
instrument the last three lines of `boot()` before the return.

Separate session. Do not interleave with Phase 191.
