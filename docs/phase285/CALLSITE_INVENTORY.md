# Phase 285 — Call-Site Inventory

For each runtime sink the phase inspected: source -> transformation -> sink ->
redaction function -> verification status.

## Traced and verified

### 1. emitServerEvent (server event log)

- Source: Caller-supplied `fields: Record<string, unknown>` — e.g., `scripts/run-server.ts:98, 123` passes `{ error: (e as Error).message }`.
- Transformation: `redactText(v).slice(0, 256)` for strings; `redactMetadata(v)` for non-strings (post-round-43 fix).
- Sink: `process.stdout.write(line + "\n")` — log stream.
- Redaction function: `redactText` (strings) + `redactMetadata` (non-strings).
- Redaction before sink: Yes. Both branches apply redaction before `JSON.stringify`.
- Error/fallback bypass: The try/catch around `process.stdout.write` catches write failures only, not redaction. No bypass.
- Test coverage: `test-phase285` Section 1 (5 assertions).
- Uncertainty: None for nested objects, arrays, and Errors. Primitives (number, boolean) pass through unchanged — correct behavior.

### 2. emitAccessLog (HTTP access log)

- Source: `http.ts:74-88` middleware, per-request.
- Transformation: `clip(fields.path, MAX_PATH)` -> `redactText(String(v ?? ""))` -> `slice(0, 256)` for each field.
- Sink: `process.stdout.write(line + "\n")` — log stream.
- Redaction function: `redactText` (via `clip`).
- Redaction before sink: Yes. `clip` runs `redactText` before serialization.
- Error/fallback bypass: No.
- Test coverage: `test-phase285` Section 2 (5 assertions) + Section 3 (11 assertions through a real HTTP listener with `accessLog: true`).
- Note: Round 53's fix replaced `req.originalUrl || req.url` with `req.path` — the query string is removed before `clip` runs. Defense in depth: even if a query string reached `clip`, `redactText` would catch credential-shaped values >= 12 chars.

### 3. AuditService.record (audit persistence)

- Source: Caller-supplied `metadata?: Record<string, unknown>`.
- Transformation: `redactMetadata(input.metadata ?? {})`.
- Sink: `await this.engine.put("audit", rec.id, rec)`.
- Redaction function: `redactMetadata`.
- Redaction before sink: Yes. Line 170 applies `redactMetadata`; line 172 persists.
- Error/fallback bypass: `redactMetadata` wraps `redactMetadataInternal` in a try/catch that returns `"[unavailable metadata]"` — fail-closed.
- Test coverage: `test-phase273` (33 assertions), `test-phase281` (68), `test-phase282` (83), `test-phase285` Section 4k (3).
- Uncertainty: The four direct string fields (`actor`, `action`, `resource_type`, `resource_id`) are persisted without `redactText` — see FINDINGS.md.

### 4. EventService.record (event persistence)

- Source: Caller-supplied `input.payload`.
- Transformation: `redactSecrets(input.payload)`.
- Sink: `await this.engine.put("events", event.id, event)` (line 52).
- Redaction function: `redactSecrets`.
- Redaction before sink: Yes. Line 50 redacts; line 52 persists.
- Error/fallback bypass: `redactSecrets` handles `null`/`undefined`; catches cycles. Fail-closed on hostile input.
- Test coverage: `test-phase273`, `test-phase277` (shared redactor coverage).

### 5. EvidenceService (evidence persistence)

- Source: Caller-supplied object.
- Transformation: `return redactSecrets(obj)` (line 48).
- Sink: Return value is what the caller persists.
- Redaction function: `redactSecrets`.
- Redaction before sink: Yes — the return value IS the redacted form. Caller cannot accidentally persist unredacted.
- Error/fallback bypass: No.
- Test coverage: `test-phase273` (redactSecrets unit level).

### 6. AsyncIncidentStore (incident payload persistence)

- Source: Caller-supplied `event.payload`.
- Transformation: `JSON.stringify(redactSecrets(event.payload))` (line 318).
- Sink: Persisted as `payloadJson`.
- Redaction function: `redactSecrets`.
- Redaction before sink: Yes — redaction precedes `JSON.stringify`.
- Error/fallback bypass: If `event.payload` is `null`/`undefined`, the ternary produces `null` — no redaction needed.
- Test coverage: `test-phase273`.

### 7. auth-middleware.ts (Authorization header)

- Source: `req.headers.authorization` (line 30).
- Transformation: `raw` -> `header` (normalized) -> `token` (extracted) -> `sessions.validate(token)`.
- Sink: Session validation. No log or persistence sink.
- Redaction function: Not applicable — no sink.
- Redaction before sink: N/A.
- Error/fallback bypass: Error paths (`UNAUTHENTICATED`, `INVALID_SESSION`, `IDENTITY_DISABLED`) use fixed message strings, not the token.
- Test coverage: `test-phase180` B10 (bearer token absent from response body), B11 (auth error no credential material).
- Verified by source inspection (round 63).

### 8. http.ts access log middleware

- Source: `req.requestId`, `req.method`, `req.originalUrl` (pre-fix) / `req.path` (post-fix), `res.statusCode`, timing, `req.actor?.email`.
- Transformation: Per-field `clip`.
- Sink: `emitAccessLog` -> `process.stdout.write`.
- Redaction function: `redactText` (via `clip`).
- Redaction before sink: Yes.
- Error/fallback bypass: No.

## Not traced in Phase 285

23 `engine.put` call sites across 5 files were inventoried but not traced
to determine whether redaction is applied upstream. Status: NOT EXECUTED.

### src/core/orchestration.ts (4 sites)

- Line 111: `engine.put("agent_runs", agentRun.id, agentRun)`
- Line 139: `engine.put("agent_runs", agentRun.id, agentRun)`
- Line 156: `engine.put("agent_runs", agentRun.id, agentRun)`
- Line 168: `engine.put("agent_runs", agentRun.id, agentRun)`

### src/core/cicd.ts (5 sites)

- Line 1112: `engine.put("git_operations", op.id, op)`
- Line 1149: `engine.put("ci_pipeline_runs", run.id, run)`
- Line 1164: `engine.put("ci_pipeline_runs", run.id, run)`
- Line 1267: `engine.put("ci_pipeline_runs", run.id, run)`
- Line 1414: `engine.put("change_requests", cr.id, cr)`

### src/core/devops.ts (4 sites)

- Line 460: `engine.put("pipeline_runs", run.id, run)`
- Line 477: `engine.put("pipeline_stages", rec.id, rec)`
- Line 500: `engine.put("pipeline_stages", fresh.id, fresh)`
- Line 590: `engine.put("pipeline_runs", run.id, run)`

### src/core/services.ts (5 sites)

- Line 180: `engine.put("projects", project.id, project)`
- Line 220: `engine.put("executions", execution.id, execution)`
- Line 251: `engine.put("executions", execution.id, execution)`
- Line 326: `engine.put("evidence", id, { ...evidence, __content: input.content })`
- Line 411: `engine.put("artifacts", id, { ...ref, __content: input.content })`

### src/core/security-services.ts (10 sites)

- Line 47: `engine.put("security_executions", record.id, record)`
- Line 63: `engine.put("security_executions", id, updated)`
- Line 83: `engine.put("security_executions", id, updated)`
- Line 120: `engine.put("security_evidence", record.id, record)`
- Line 177: `engine.put("security_finding_observations", obs.id, obs)`
- Line 220: `engine.put("security_findings", existing.finding_id, updated)`
- Line 267: `engine.put("security_findings", finding.finding_id, finding)`
- Line 339: `engine.put("security_findings", findingId, updated)`
- Line 446: `engine.put("security_risk_assessments", assessment.id, assessment)`
- Line 473: `engine.put("security_decisions", record.id, record)`

### Why these are out of Phase 285 scope

- Phase 285's §B explicitly named 7 files; 2 (audit.ts, events.ts) were traced, 5 remain.
- Tracing 23 engine.put sites requires reading each function body (or a 15-line window around each site) and determining whether redactMetadata/redactSecrets/redactText is applied upstream.
- Some sites may be structurally safe (e.g., projects.id is a UUID, not user text); others may not (e.g., ci_pipeline_runs may carry error messages or environment variables).
- Determining which is a per-site inspection that Phase 285 did not perform.

## Coverage gaps

### worker-gateway.ts:88 — error response body

The raw `e.message` reaches the response body: `this.send(res, 400, { error: e.message || "gateway_error" })`. If `handleMessage` ever throws a credential-bearing message, it leaks to the HTTP client. `test-phase180` B10 and B11 cover the `createHttpApp` error path, but not the `worker-gateway`'s independent error handler. Status: Coverage gap — not tested.

### AuditService.record direct string fields

`actor`, `action`, `resource_type`, `resource_id` are assigned verbatim to the record before `engine.put`. No `redactText`. Current callers pass controlled strings (user email, fixed action names, IDs). Status: Coverage gap — no caller passes credential-bearing data, but the contract isn't enforced.
