# Phase 216 - Security

## Secret handling

- API keys are read only by the provider adapter from an environment variable.
- The configuration object stores only the env var NAME (apiKeyEnvVar).
- Keys are never written to: engineering_run_events, engineering_plans,
  architecture_specifications, execution_artifacts, error messages, or logs.
- ai-provider-redaction.ts provides redactSecrets / redactDeep / bounded,
  applied to any string bound for an event, artifact, or error message.

## Bounded inputs

- Request prompt: capped at 512 KiB.
- Response body: capped at 2 MiB.
- Timeout: required, min 1000 ms, max = 4 * configured timeoutMs.
- Retries: bounded at 1 + maxRetries (maxRetries capped at 5).

## AI output is DATA

Provider output is never used to: execute commands, modify execution state,
change release state, deploy code, or access secrets. It flows through the
existing Phase 215 planning/architecture validators and the durable artifact
pipeline. Phase 216 does not give the AI execution authority.
