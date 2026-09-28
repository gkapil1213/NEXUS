Env contract (all required for real provider to be considered present):
- NEXUS_AI_ENABLED=true
- NEXUS_AI_MODEL=<model>
- NEXUS_AI_ENDPOINT=<https endpoint>
- API key via NEXUS_AI_API_KEY | OPENAI_API_KEY | ANTHROPIC_API_KEY

Partial config = absent. Absent config = BLOCKED, never PASS.