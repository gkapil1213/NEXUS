# Phase 304 — Scripts Directory Inventory (preliminary)

**Status:** Captured 2026-11-15 from session verification. Not yet formally classified.

## Finding

`scripts/` contains ~400 files. Approximately:
- ~115 `test-phase*` scripts in `package.json`
- ~115 `test-phase*` scripts in `scripts/` only (DORMANT — never run via `npm test`)
- ~150 `run-phaseNN.ts` one-off runners (many dead after their phase completed)
- ~20 `_phaseNNN_child.ts` child-process helpers (called by tests)
- ~10 `.bak` / `.backup` files (delete candidates)
- Several scratch files (`debug-*`, `diagnose-*`, `apply-phase*.ps1`)

## Implication

- `tsc --noEmit` typechecks dormant files even if `npm test` never runs them
- Adding Phase 304+ scripts compounds the pile
- Full audit + staged cleanup warranted

## Next steps (Phase 304a–d)

- **304a**: Full classification in `artifacts/phase304/scripts-inventory.md`
- **304b**: Delete confirmed-dead files (`.bak`, one-off `run-phaseNN`, scratch) — all recoverable via git
- **304c**: Wire up dormant tests that pass; delete dormant tests that don't
- **304d**: Move `phaseNNN-evidence.*` out of `scripts/`

## Not started

This artifact records the finding, not the work.