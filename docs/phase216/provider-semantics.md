# Phase 216 - Provider Semantics

## Gateway responsibilities

- Hold a registry of AIProvider instances.
- Normalize vendor error shapes into AIProviderError.
- Enforce bounded retries (maxRetries capped at 5) on retryable classes only.
- Verify the adapter honored timeoutMs.
- Emit structured lifecycle events (ai.provider.requested/completed/failed/retry/timeout).

## Retryability

Retryable: TIMEOUT, CONNECTION, RATE_LIMIT, SERVER.
Non-retryable: AUTH, CLIENT (4xx other than 429), NOT_CONFIGURED,
INVALID_RESPONSE, SCHEMA_INVALID, POLICY, UNKNOWN.

Backoff is deterministic: min(50 * 2^(attempt-1), 2000) ms. No randomness.

## Structured output

Provider requests use responseFormat = 'json_object'. The gateway verifies
the response is JSON and parses it into structuredOutput. The planning and
architecture providers then pass that object through the Phase 215
validators; invalid output is rejected before any artifact or plan row is
written.

## Capability registry

EngineeringCapabilityRegistry.evaluateAsync(PLANNING) consults the gateway:

| Condition | Status | Reason |
|---|---|---|
| No gateway wired | NOT_IMPLEMENTED | no executor is wired in this phase |
| Gateway but provider not registered | UNAVAILABLE | PROVIDER_NOT_CONFIGURED |
| Provider probe returns AUTH/PROBE_FAIL | UNAVAILABLE | PROVIDER_AUTH_FAILED / PROBE_FAILED:... |
| Provider probe returns PROBE_OK | AVAILABLE | PROBE_OK |
