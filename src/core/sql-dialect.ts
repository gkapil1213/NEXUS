// src/core/sql-dialect.ts
// Phase 183b: minimal, deterministic placeholder translation.
//
// Async persistence methods write SQL with `?` placeholders -- the shape
// better-sqlite3 natively accepts. node-postgres requires `$1, $2, ...`.
// This function converts one to the other in order of appearance, skipping
// any `?` inside single-quoted string literals (none exist in the current
// queries, but the guard costs nothing and prevents a future footgun).
//
// Not a generic SQL rewriter. No dialect branching beyond placeholder
// numbering. No DDL translation. No type coercion. Callers must already be
// writing portable SQL (no AUTOINCREMENT, no INSERT OR IGNORE, no SQLite-
// specific functions); that discipline lives in the async methods.

export function toPostgresPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) {
      out += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === "?") {
      n += 1;
      out += "$" + n;
      continue;
    }
    out += ch;
  }
  return out;
}