# NEXUS Phase 70 – Persistence Architecture Audit

## Classification Legend
- **A Must migrate**: production domain store that can operate through NexusEngine.
- **B Must isolate**: Node-only infrastructure that genuinely requires native SQLite.
- **C Test-only**: acceptable only when explicitly isolated.
- **D Dead/legacy**: remove only if proven unused.

## Current better-sqlite3 Usage

| File | Symbol | Current Mechanism | Reason | Classification | Migration Decision | Target Architecture | Verification Status |
|------|--------|-------------------|--------|----------------|--------------------|---------------------|---------------------|
| src/core/sqlite-engine.ts | SQLiteEngine | native etter-sqlite3 (Database.Database) | Node-only adapter implementing NexusEngine; requires synchronous transactions, parameterized SQL, close | B Must isolate | Keep as native adapter; it is the only allowed Node-only implementation | NexusEngine (adapter) | Verified by
px tsc --noEmit and build |
| src/core/db.ts | (no direct import) | none | Central engine interface; uses openEngine() to select runtime | A Must migrate (already migrated) | No direct SQLite; depends on NexusEngine | NexusEngine | Verified |
| src/core/db.ts.backup | backup file | contains old engine code | Historical backup, not compiled | D Dead/legacy | Not used in production; can be removed or ignored | Not relevant | N/A (not in build) |
| src/core/worker-control-engine.ts | (unused import removed) | no longer imports | was accidental import | D Dead/legacy | Removed unused import | NexusEngine (through dependencies) | Verified (tsc passed) |
| src/core/worker-cost-reliability-control.ts | (unused import removed) | no longer imports | was accidental import | D Dead/legacy | Removed unused import | NexusEngine (through dependencies) | Verified (tsc passed) |

## Remaining .prepare() / .exec() / .transaction() usage in src/core

All occurrences are now through NexusEngine (interface) or in sqlite-engine.ts (native adapter). No domain store owns a raw Database connection except SQLiteEngine.

## Browser/Native Boundary

- src/core/db.ts does not import etter-sqlite3.
- SQLiteEngine is only imported dynamically by openEngine() when CONFIG.persistence.engine === "sqlite".
- Browser build should not include etter-sqlite3 unless config explicitly selects it; Vite configuration may need to externalize it.

## Configuration

- NEXUS_PERSISTENCE_ENGINE environment variable controls engine selection.
- CONFIG.persistence.engine defaults to "memory" unless overridden.
- Invalid engine values throw Err.persistence("INVALID_ENGINE").
- Database path is provided through CONFIG.persistence.dbName.

## Verification

-
px tsc --noEmit passes.
- Phase 13–16 regression tests pass.
-
pm run build will be run to ensure no native SQLite leaks into browser bundle.
