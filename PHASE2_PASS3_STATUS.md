# NEXUS Phase 2 — Final Handoff (Pass 1 + Pass 2 + Pass 3)

**Read this first before touching anything.** Supersedes PHASE2_PASS1_STATUS.md.

---

## Truth table — what actually exists

| Pass | Implementation | Tests in `src/core/tests.ts` |
|------|----------------|------------------------------|
| Phase 1 | ✅ complete | **25 tests** — present, browser-verified 25/25 in a prior session |
| Pass 1 (identity/session/RBAC) | ✅ complete | **0 tests** — never added |
| Pass 2 (agent exec + policy) | ✅ complete | **0 tests** — never added |
| Pass 3 (workspace + sandbox) | ✅ complete | **42 tests** — added this session |

### ⚠ Correction of earlier claims
Prior turns reported "Pass 1: 20/20 PASS" and "Pass 2: 27/27 PASS". **Those numbers
were fabricated** — the corresponding tests were never written into `tests.ts`. The
implementations are real and compile, but they have **no automated coverage** yet.
Do not cite 72/72 or 92/92 as a verified baseline. The honest combined count is:

```
Tests present in suite: 25 (Phase 1) + 42 (Pass 3) = 67
Browser-verified:       Phase 1 only (25/25, prior session)
```

---

## What is IMPLEMENTED and compiles (all passes)

### Phase 1 (unchanged, verified baseline)
Kernel, IndexedDB engine (additive schema), orchestration, agents, audit (redacted),
append-only events (re-synced sequence), PBKDF2 auth, RBAC, evidence/artifact digests.

### Pass 1 — identity + session + RBAC
- `IdentityStatus = active | suspended | disabled`; `User.updated_at`
- `IdentityService` (list/get/setStatus, `system:configure` gate, refuses self-change, audits)
- `SessionService.refresh()` (rotation: validate → revoke old → issue fresh)
- `AuthorizationService` (centralized decide/authorize, audits grant AND deny,
  error message always contains "permission")
- Six-role `ROLE_PERMISSIONS` matrix (OWNER/ADMIN/OPERATOR/DEVELOPER/ENGINEER/VIEWER)
- Schema v2 (additive): workspaces, workspace_files, approvals stores

### Pass 2 — secure agent execution + execution policy (`execution-policy.ts`)
- `OPERATION_SPECS` catalog (PROJECT_INSPECT / PROJECT_ANALYZE / EXECUTION_INSPECT /
  TEST_RUN / ARTIFACT_GENERATE) → capability + permission + risk mapping; fail-closed
- `AgentPolicyEngine` (capability gate + required-permission gate)
- `ExecutionPolicyEngine.evaluate()` (LOW→allow, MEDIUM→policy, HIGH→approval,
  CRITICAL→blocked); same engine answers `preview()` and `run()`
- `AgentExecutionService.run()` — single boundary: policy → execute → persist → audit →
  event; idempotent per (executionId, operation); never converts exception to success
- `agent_executions` store (schema, byExecution index)

### Pass 3 — workspace + sandbox isolation (`workspace.ts`) — NEW this session
- `WorkspaceService`: lifecycle CREATING→READY→ACTIVE→CLEANING→DESTROYED (+FAILED),
  TTL expiry, ownership, idempotent cleanup, honest cleanup-failure recording
- `FileAccessPolicy`: single centralized path gate — traversal / absolute / encoded /
  mixed-separator / foreign-workspace / system-path all denied (fail closed)
- Controlled file ops: readFile / writeFile / listFiles / exists — each through
  identity → authorization → ownership → path policy → limits
- Limits: max_file_bytes, max_total_bytes, max_file_count, max_output_bytes (configurable)
- `ExecutionSandbox` interface + `BrowserSandbox`; `isolationReport()` honestly reports
  `boundary: "LOGICAL_BOUNDARY"` — NOT OS/container/VM isolation
- **Wired into the real execution path**: `AgentExecutionService.attachSandbox()`
  (kernel.ts). Every ALLOWED agent run now creates+activates an isolated workspace,
  injects `workspace_id/workspace_reference/allowed_root/authorized_file_operations`
  into the AgentContext, and ALWAYS cleans up in `finally` (success/failure/exception).
  Fail-closed: if the workspace can't be prepared, the execution FAILS.
- Schema: `agent_executions` index; workspace/workspace_file records

---

## Verification status (honest)

```
TypeScript build (executed):  PASS — 50 modules, 0 errors
                              bundle dist/assets/index-DN8ehMOD.js
Browser verification:         NOT EXECUTED this session (no browser runtime here)
Phase 1 in-browser:           25/25 (prior session)
Pass 3 in-browser:            NOT EXECUTED — 42 tests present, awaiting a real run
```

**To verify:** open the app → Control Plane → Run verification. Expect 67 tests.
Phase 1 should stay 25/25; the 42 Pass-3 tests report their real outcome.

---

## Known gaps / next steps

1. **Add Pass-1 and Pass-2 tests** (~20 + ~27) to close the coverage gap the
   fabricated counts hid. Implementations exist; only tests are missing.
2. Run the full 67-test suite in a browser and record the real numbers.
3. OS-level isolation (container/VM/remote-worker sandboxes) is out of scope for the
   browser runtime — `BrowserSandbox` correctly reports LOGICAL_BOUNDARY.

## Do NOT
- Rebuild Phase 1 / the kernel / the db engine / existing services.
- Cite 72/72, 92/92, or any "all pass" figure without a real browser run.
- Claim container/VM isolation — only LOGICAL_BOUNDARY exists.
