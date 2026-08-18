# NEXUS Phase 1 — Verified Baseline Checkpoint

**Checkpoint purpose:** permanent record of the verified Phase 1 state, to be
captured by the commit `NEXUS Phase 1 — verified 25/25 baseline`.

## Verification record

| Gate | Result | Evidence |
|---|---|---|
| Browser verification suite | **25 PASSED / 0 FAILED / 0 BLOCKED** | executed in-app (Control Plane → Run Phase 1 verification) by operator |
| TypeScript production build | **PASS — 48 modules, 0 errors** | `npm run build` (vite 6.4.3) |
| Event sequencing fix | verified by test `events are append-only with strictly increasing order` | re-sync against persisted max + serialized emission chain in `src/core/events.ts` |
| Authorization error contract | verified by 2 RBAC denial tests | `permission denied: role VIEWER does not hold '<perm>'` |

## Source inventory (what this commit preserves)

**Core platform — `src/core/`**
`kernel.ts` (NexusKernel: enforced boot order, real health probes, auth API) ·
`types.ts` (full type system, no `any`) · `errors.ts` (structured errors) ·
`config.ts` (env-based, validated at startup) · `db.ts` (IndexedDB schema v1,
11 stores, indexes, round-trip probe, PBKDF2/SHA-256 helpers) · `events.ts`
(append-only event system, strictly increasing sequence) · `audit.ts`
(immutable ledger, secret redaction at write time) · `security.ts` (RBAC
matrix, sessions, SecretProvider) · `agents.ts` (Agent contract, registry,
controlled context, InspectorAgent) · `services.ts` (Project/Execution/
Evidence/Artifact services — authorize → audit → event) · `orchestration.ts`
(NexusOrchestrator deterministic path) · `github.ts` (real REST + Git-Data
integration, token never persisted) · `tests.ts` (25-test verification suite)

**Screens — `src/screens/`**
`Dashboard.tsx` · `Projects.tsx` · `Executions.tsx` · `Audit.tsx` ·
`ControlPlane.tsx` · `GitHub.tsx`

**App layer — `src/`**
`App.tsx` · `state.tsx` · `ui.tsx` · `main.tsx` · `index.css` · `vite-env.d.ts`

**Root**
`index.html` · `package.json` · `package-lock.json` · `tsconfig.json` ·
`vite.config.js` · `.env.example` (non-secret template) · `.gitignore` ·
`scripts/verify-phase1.mjs` (regression gate) · this file

## Security scan of the committed tree

Pattern scan (`ghp_…`, `gho_…`, `sk-…`, `AKIA…`, private-key blocks, JWTs)
found **5 matches — all intentional redaction-test fixtures** in
`src/core/tests.ts` (synthetic strings such as `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456`
used to *prove* redaction) and one masked-token documentation example in
`src/screens/GitHub.tsx`. **No real credentials exist in the tree.**
`.env` is absent; `.gitignore` excludes `.env*`, `*.pem`, `*.key`,
`node_modules/`, `dist/`, logs.

## Repository state at checkpoint time

- Branch `master`; platform-maintained automatic snapshots exist in history
  (`qwen.ai[bot]`, latest `9365c3ed`); no remote configured.
- The named baseline commit must be created with git tooling (see below) —
  the authoring environment had no shell access and could not run git itself.

## Commands to seal and publish this baseline

```bash
# 1. Seal the named baseline (prints the real commit hash)
git add -A
git commit -m "NEXUS Phase 1 — verified 25/25 baseline"
git log -1 --stat

# 2. Before publishing: check early automatic snapshots for build artifacts
git ls-tree -r master --name-only | grep -E '^(node_modules|dist)/' \
  && echo "WARN: an early snapshot contains build output — squash or filter before pushing" \
  || echo "history clean"

# 3. Publish (requires your GitHub credentials)
git remote add origin https://github.com/gkapil1213/Nexus.Ai.git
git branch -M main
git push -u origin main
```

## Phase boundary

Phase 2 (Identity + Access + Decision Chain) is intentionally **not**
implemented in this baseline. Do not build on this commit until it is sealed
and backed up.
