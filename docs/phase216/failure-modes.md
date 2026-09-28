# Phase 216 - Failure Modes

| Condition | Class | Retry? | Orchestrator state |
|---|---|---|---|
| Missing env var | NOT_CONFIGURED | no | FAILED (planning) / BLOCKED (registry) |
| Provider disabled | NOT_CONFIGURED | no | FAILED (planning) / BLOCKED (registry) |
| 401/403 from provider | AUTH | no | FAILED |
| 429 from provider | RATE_LIMIT | yes | FAILED after retries |
| 5xx from provider | SERVER | yes | FAILED after retries |
| Connection refused | CONNECTION | yes | FAILED after retries |
| Timeout | TIMEOUT | yes | FAILED after retries |
| Non-JSON response | INVALID_RESPONSE | no | FAILED |
| No content in response | INVALID_RESPONSE | no | FAILED |
| JSON parse fails on structured output | SCHEMA_INVALID | no | FAILED |
| Structured output fails validator | (validation) | no | INVALID (plan/arch row persisted as INVALID) |

## Never fabricated

- Provider ok:true alone is never authoritative success.
- A plan becomes VALID only after parse + schema + semantic validation +
  content hash + durable persistence.
- The capability registry never reports AVAILABLE without a successful probe.
