# Phase 167 - Production Execution Audit & Provenance Control Plane

Read-only service boundary over the Phase 165/166 durable outcome
provenance data. Exposed through `KernelServices.auditProvenance`.

## Entry point

`ExecutionAuditProvenanceService`
(`src/core/execution-audit-provenance-service.ts`)

Constructed by `NexusKernel.boot()` and published on
`services.auditProvenance` when the durable `executionStore` is
available, otherwise `undefined`.

## Operations

- getProvenanceById(actor, provenanceId)   -> ProvenanceView
- getProvenanceByAttempt(actor, attemptId) -> ProvenanceView
- getProvenanceByRecoveryOperation(actor, opId) -> ProvenanceView
- getProvenanceByJob(actor, jobId, {limit?, cursor?}) -> PageView<ProvenanceView>
- getRetryLineage(actor, jobId) -> RetryLineageView
- verifyByAttempt(actor, attemptId) -> VerificationView
- verifyById(actor, provenanceId) -> VerificationView

All methods are async and read-only. None accept a caller-supplied
owner, tenant, or project parameter.

## Authorization boundary

Single permission gate: `audit:read`.

Roles that hold `audit:read` per `src/core/security.ts`
`ROLE_PERMISSIONS`: OWNER, ADMIN, OPERATOR. Roles that do not:
DEVELOPER, ENGINEER, VIEWER. Suspended actors are denied by the
`can()` status gate.

The service does not enforce per-resource or per-project ownership.

SCOPE LIMITATION (unimplemented). Phase 167 sections 4 and 5 call
for cross-project isolation. NEXUS today has no `project_memberships`
table, no `owner_id` on `Project`, and `can()` ignores its `_resource`
parameter (global role-to-permission matrix). Cross-project isolation
is therefore NOT implemented. Building it requires a membership schema
and a resource-scoped `can()` variant - a separate phase. This is
documented, not silently skipped.

## Resource resolution

Every method resolves the target resource from persisted state via
`ExecutionStore`. The DTO surface (ProvenanceView, RetryLineageView,
PageView) exposes only camelCase domain fields - no snake_case
columns, no raw SQL, no store internals.

## Pagination

- Default page size: 25 (AUDIT_PAGE_DEFAULT)
- Hard maximum: 100 (AUDIT_PAGE_MAX)
- Oversized / zero / negative limits: INVALID_LIMIT
- Cursor: opaque base64url of {terminalizedAt, provenanceId}.
  Malformed cursors: INVALID_CURSOR
- Ordering: terminalized_at ASC, provenance_id ASC (deterministic,
  total order)
- hasMore detected by fetching one extra row (no second query)
- Indexed via idx_eop_job_terminalized (job_id, terminalized_at)
  (migration 157)

## Integrity verification

Verification reads the stored provenance row and reconstructs the
exact Phase 165 canonical hash payload (JSON.stringify on the same
object literal, same key order). Uses the same sha256 implementation
(`src/core/sha256.ts`) that Phase 165 used to write the hash. No
second hashing path.

VerificationView.status is one of:

- verified       - hash matches
- hash_mismatch  - hash does not match (evidence, timestamp, or
                   metadata tampered)
- not_found      - no provenance row exists

Verification never mutates the record. Repeated verifications return
the same result.

## Error semantics

All errors are NexusError with a machine-readable code and category.

| Code                          | Category          | Meaning                                  |
|-------------------------------|-------------------|------------------------------------------|
| INVALID_IDENTIFIER            | validation        | id fails format/length check             |
| INVALID_LIMIT                 | validation        | limit out of range                       |
| INVALID_CURSOR                | validation        | cursor malformed                         |
| AUDIT_READ_DENIED             | authorization     | actor lacks audit:read                   |
| PROVENANCE_NOT_FOUND          | not_found         | no row matches                           |
| PROVENANCE_INTEGRITY_FAILURE  | integrity_failure | cross-record consistency check failed    |

No stack traces, SQL text, filesystem paths, or worker internals are
returned to the caller. ErrorCategory gained integrity_failure in
Phase 167 so integrity failures are distinguishable from generic
conflicts.

## Audit-access behavior

Every read (allowed or denied) writes a durable entry via
AuditService into nexus_records[store='audit']:

- Allowed: action = "audit:<operation>", result = "allow",
  metadata = {role, outcome, ...}
- Denied:  action = "audit:denied:<operation>", result = "deny",
  metadata = {role, reason}

Reads of the audit store itself do not recurse. No request bodies,
credentials, tokens, or evidence payloads are stored in the audit
entry.

## Tests

`scripts/test-phase167-audit-provenance-control-plane.ts` - 52
assertions across groups A (auth gate), B (authorization),
C (resource resolution), D (queries), E (integrity), F (pagination),
G (input validation), H (isolation - limited, see above),
I (lifecycle), J (no-mutation), K (audit access), L (regression
runner).
