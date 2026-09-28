# Phase 215 - Security

## Provider output is untrusted

Parsed, schema-checked, semantically validated, hash-verified before any
durable row. Nothing in Phase 215 executes generated commands, code, or
infrastructure.

## Idempotency

- engineering_requests UNIQUE (run_id, request_hash).
- engineering_plans UNIQUE (run_id, version).
- architecture_specifications UNIQUE (run_id, version).
- runPlanning fast-paths existing plan for the same (runId, requestId).

## Tamper detection

contentHash covers all content fields. 215Y proves raw SQL edit of
content_hash is detected on re-validation.

## No secret leakage

No API keys, tokens, DATABASE_URL, or credentials written to any durable
table.
