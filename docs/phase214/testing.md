# Phase 214 - Testing

## Run

    NEXUS_PERSISTENCE_MODE=shared \
      DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus \
      npx tsx scripts/test-phase214-engineering-run.ts

## Conventions

- Each test reports exactly one of [PASS] / [FAIL] / [BLK ] / [N/E ].
- All tests use a unique 'engrun-214-<timestamp>-' prefix.
- Cleanup in finish() deletes only rows created by this run.
- No mocked gate, no hardcoded counts.

## Regression

Run all prior phases through the canonical verifier:

    for P in 207 208 209 210 211 212 213 214; do npx tsx scripts/verify-phase.ts \src\core\engineering-run-service.ts; done
