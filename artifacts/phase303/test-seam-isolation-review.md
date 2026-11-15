# Phase 303 — Test Seam Isolation Review

**Status:** Reviewed — deferred, no action taken. Evidence gathered from the
build configuration, source tree, and git history confirms the seam is
production-safe by construction. Neither Option A (env guard) nor Option B
(extracted module) is worth the cost.

## Current state (commit 8f4ba35)

- `KernelBootHooks` interface + `__testSetBootHooks()` exported from `src/core/kernel.ts:200-210`
- Single call site at `src/core/kernel.ts:1025`:
  `if (__testBootHooks?.afterServicesWired) __testBootHooks.afterServicesWired();`
- Module-level variable `__testBootHooks` defaults to `null`
- `git grep __testSetBootHooks HEAD` → 7 references, all in `kernel.ts`
  (definition + call comment) or `scripts/test-phase303-kernel-boot-failure.ts`
  (import + set + 2× clear + doc comment)
- **No production code imports or calls `__testSetBootHooks`**

## Phase 303 verification (test:phase303, 8/8 PASS)

- WP7-T1 through T4b: failure injection, kernel state, NOT_BOOTED guard, retry
- WP7-T5: `startGateway()` succeeds after successful boot (`CONFIG.gateway.enabled = true`)
- WP7-T6: gateway listener actually bound to an ephemeral port (real socket assertion)
- T5/T6 exercise the full success path end-to-end.

## Build context (decisive)

- `package.json`: `"type": "module"`, `"private": true`, **no `exports` map**
- `vite.config.js` externalizes Node built-ins (`fs`, `path`, `crypto`,
  `better-sqlite3`, `pg`, etc.)
- `src/main.tsx` → `App.tsx` → `state.tsx` → `NexusKernel`
- `kernel.ts` imports Node-only modules externalized by Vite
- **Implication: the SPA build cannot successfully bundle `kernel.ts`'s
  dependency tree**
- `test:phase303` runs under `tsx` (Node + esbuild), bypassing Vite entirely
- **Therefore: `__testSetBootHooks` is not part of any browser-served artifact**

## Options evaluated

### Option A — NODE_ENV runtime guard
Add `if (NODE_ENV !== "test" && NEXUS_ALLOW_TEST_HOOKS !== "1") throw`.
- Requires NODE_ENV discipline not currently in place
- Escape hatch makes it advisory
- Protects against a failure mode requiring bypass of 4 existing layers
- **Decision: not adopted**

### Option B — Extracted module
The codebase precedent is `src/core/hmac-provider-resolver.ts` (extracted from
`kernel.ts` for pure-function testability). But the boot-failure seam lives
inside `_boot()`'s stateful critical section — cannot be extracted without
either passing live kernel state, or extracting the entire critical section
(a large refactor). Additionally, `NexusKernel` has no constructor, so
constructor-option injection would require adding a constructor that doesn't
exist. No `package.json` `exports` map exists for build-level exclusion.
- **Decision: not adopted**

### Option C — Do nothing (current state)
- **Decision: adopted**

## Rationale

The seam is safe by four structural layers:

1. `__` prefix marks it as internal
2. No production imports (verified by `git grep HEAD`)
3. Module variable defaults to `null` — call site is a no-op unless set
4. Single call site guarded by optional-chaining

Adding runtime enforcement protects against a failure mode requiring bypass of
all four. Adding structural enforcement requires build-level changes not
present in this repo.

## Revisit if:

- A production caller imports `__testSetBootHooks` (detectable by `git grep`)
- A build-time exclusion mechanism is added (`exports` map, `define` based stripping)
- `NODE_ENV` is confirmed set consistently across deployment targets
- `NexusKernel` gains a constructor (enables DI-based injection)

## Related

- `artifacts/phase300/wp7-readiness.md` — original inspection-only gap
- `scripts/test-phase303-kernel-boot-failure.ts` — test consuming the seam
- Commit `8f4ba35` — Phase 303 landing