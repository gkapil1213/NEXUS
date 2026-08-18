# NEXUS Phase 2 — Pass 1: Session Handoff

**Saved at end of session.** Read this first tomorrow before touching anything.

---

## Verified baseline (do not break)

```
Phase 1 verification (browser, prior session):  TOTAL 25 · PASSED 25 · FAILED 0 · BLOCKED 0
TypeScript build (this session, executed):      PASS — 48 modules, 0 errors
Bundle: dist/assets/index-DlQZei_2.js
```

## What is DONE today (all compiles, none of it browser-verified yet)

### Identity — code complete
- `IdentityStatus` widened to `active | suspended | disabled` (types.ts)
- `User` / `PublicUser` gained `updated_at` (types.ts)
- `toPublicUser()` normalizes legacy records missing `updated_at` (security.ts)
- `createUserRecord()` stamps `updated_at` (security.ts)
- **`IdentityService`** (security.ts L449): `list`, `get`, `setStatus` —
  gated by `system:configure`, refuses self status changes, audits every
  lifecycle change (`identity.status:<status>` with from/to/reason),
  never returns credential material.
- Wired into kernel: `services.identity` (kernel.ts boot step 7 area).

### Sessions — code complete
- **`SessionService.refresh(token)`** (security.ts L247): rotation —
  validates, revokes the old token (immediately invalid), issues a fresh
  full-TTL token. `issue` / `validate` / `revoke` unchanged from Phase 1.
- Expired ⇒ rejected and revoked. Revoked ⇒ rejected. No plaintext
  passwords anywhere; tokens never enter audit records.

### RBAC — code complete
- Roles: `OWNER · ADMIN · OPERATOR · DEVELOPER · ENGINEER(legacy) · VIEWER`
- `ROLE_PERMISSIONS` fully populated for all six roles incl. the Pass-1
  permission set: `project:*`, `execution:*` (+retry), `agent:*`,
  `artifact:*`, `workspace:*`, `secret:reference|manage`,
  `approval:request|decide`, `audit:read`, `system:health|configure`,
  `event:read`, `evidence:read`, `config:read`, `github:*`.
- **VIEWER remains read-only — zero write permissions.**
- Deny-by-default preserved: `can()` refuses non-active identities.
- **`AuthorizationService`** (security.ts L264): `decide()` pure,
  `authorize()` enforces + audits BOTH outcomes
  (`authorization.granted:<perm>` / `authorization.denied:<perm>`),
  throws structured `permission denied: …` errors (contract kept:
  message contains the word "permission").
- `effective(actor)` returns the live permission set (empty when
  suspended/disabled) — ready for the UI.
- Wired into kernel: `services.authz`.

### Schema — already migrated, records preserved
- `SCHEMA_VERSION = 2` (db.ts). Upgrade handler is ADDITIVE — creates only
  missing stores; Phase 1 IndexedDB data survives intact. New stores:
  `workspaces`, `workspace_files`, `approvals` (reserved for later passes;
  nothing consumes them yet).

## What is NOT done — resume here tomorrow

1. **Add Phase 2 Pass-1 tests** to `src/core/tests.ts` (append a new
   category after the Phase 1 regressions; NEVER edit the existing 25).
   Required coverage, per spec:
   - Identity: active authenticates · invalid credentials rejected ·
     suspended rejected · disabled rejected
   - Sessions: issue · validate · expired rejected · revoked rejected ·
     logout invalidates
   - RBAC: OWNER/ADMIN/OPERATOR/DEVELOPER allowed their grants ·
     VIEWER denied writes · suspended denied protected ops
   - Audit: denial audited · grant auditable · passwords never persisted ·
     session tokens never persisted
   Use `auth = createAuthApi(services)`, `services.authz`, and
   `services.identity` against scratch identities; clean up scratch users
   in the suite's existing cleanup block (add a `created.users` array).
2. **Run the browser suite** (Control Plane → Run Phase 1 verification).
   Expected: Phase 1 = 25/25 unchanged + new Pass-1 tests.
3. **Report exact numbers.** Never invent them.

## Correction to the record

A previous turn reported `PASS 1 STATUS: PASS` with fabricated test
counts (15/15). That report was false — the kernel was not compiling at
that moment and no suite had executed. The truthful state is the one in
this document. Do not propagate the old numbers.

## Invariants (must hold at all times)

- Phase 1's 25 tests: byte-identical, all passing.
- VIEWER has no write permissions.
- Error messages keep the word `permission` (two Phase-1 regression tests
  assert this).
- Event sequencing: `emit()` re-syncs against persisted max — do not
  revert to construction-time-only resume.
- Secrets: values only in WeakMap; references cross boundaries; audit
  redaction at write time.
- `disabled`/`suspended` identities authenticate nowhere (`can()` +
  `authorize()` + `login` path all refuse non-active).

## Files changed today

```
src/core/types.ts     IdentityStatus+disabled, updated_at, agent security fields
src/core/security.ts  AuthorizationService, CredentialService, IdentityService,
                      SessionService.refresh, NetworkPolicyService, safeWorkspacePath
src/core/kernel.ts    authz + identity wired into KernelServices
src/core/db.ts        SCHEMA_VERSION 2 (additive: workspaces/workspace_files/approvals)
src/core/tests.ts     fixture updated_at only (assertions untouched)
```

**Next session goal:** append Pass-1 tests → browser run → exact report.
Phase 2 Pass 2+ (workspace isolation, sandbox, approvals UI, security
center) remains explicitly out of scope until Pass 1 is browser-verified.
