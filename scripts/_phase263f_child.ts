// scripts/_phase263f_child.ts
// Child worker for the phase 263f event-sequence atomicity test.
// Allocates N sequence values from the given SQLite store via the real
// SQLiteEngine, then prints them as a JSON array on stdout.
//
// Usage: tsx _phase263f_child.ts <dbPath> <store> <count>

import { SQLiteEngine } from "../src/core/sqlite-engine";

async function main(): Promise<void> {
  const [dbPath, store, countRaw] = process.argv.slice(2);
  if (!dbPath || !store || !countRaw) {
    console.error("usage: _phase263f_child.ts <dbPath> <store> <count>");
    process.exit(2);
  }
  const count = Number(countRaw);
  if (!Number.isFinite(count) || count <= 0) {
    console.error("invalid count");
    process.exit(2);
  }

  const engine = await SQLiteEngine.open(dbPath);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(await engine.nextSeq(store));
  }
  console.log(JSON.stringify(out));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});