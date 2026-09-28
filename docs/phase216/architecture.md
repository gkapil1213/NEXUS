# Phase 216 - Architecture

Phase 216 adds the production AI provider execution foundation on top of the
Phase 215 planning/architecture contracts. Nothing in Phase 215 was rewritten;
the planning and architecture providers now have a real, provider-neutral
gateway they can call.

## Components

New:
- src/core/ai-provider-contracts.ts           - provider-neutral contracts
- src/core/ai-provider-redaction.ts           - secret redaction + bounded truncation
- src/core/ai-provider-gateway.ts             - HTTP invocation, timeout, bounded retry, error classification
- src/core/ai-provider-openai-compatible.ts   - real fetch()-based adapter
- src/core/ai-planning-provider.ts            - AIPlanningProvider + AIArchitectureProvider

Modified:
- src/core/engineering-capability-registry.ts - added async evaluateAsync + gateway-aware probe
- src/core/types.ts                            - added ai.provider.* and *.generation_* events
- src/core/verification-manifest.ts            - registered PHASE_216

## No duplicate systems

- No new execution engine: the gateway is called from the existing planning
  and architecture orchestrators (Phase 215).
- No new artifact store: ai-planning-provider.ts persists through ArtifactStore.
- No new event system: events flow through engineering_run_events.
- No second capability registry: EngineeringCapabilityRegistry was extended.

## Real provider configuration

Environment variables (never persisted):

    NEXUS_AI_ENABLED=true
    NEXUS_AI_MODEL=<model-id>
    NEXUS_AI_BASE_URL=<base-url>      (default https://api.openai.com/v1)
    NEXUS_AI_API_KEY_ENV=OPENAI_API_KEY
    NEXUS_AI_TIMEOUT_MS=60000
    NEXUS_AI_MAX_RETRIES=2

The API key itself is read only by the adapter via the named env var. It is
never stored on the config object, never logged, never emitted.
