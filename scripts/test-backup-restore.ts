import { openEngine, resetEngineForTesting } from "../src/core/db";
import { CONFIG } from "../src/core/config";
import { promises as fs } from "node:fs";
import path from "node:path";

async function main() {
  console.log("=== Backup / Restore Test ===\n");

  const dbPath = path.join(process.cwd(), "test-backup.sqlite");
  const backupPath = path.join(process.cwd(), "test-backup.sqlite.bak");

  // Cleanup previous test artifacts
  await fs.rm(dbPath, { force: true });
  await fs.rm(backupPath, { force: true });

  // Configure SQLite for this test
  resetEngineForTesting();
  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = dbPath;

  const engine = await openEngine();

  // Insert a known record
  await engine.put("kv", "backup-key", { value: "original" });

  // Close engine and copy DB file to backup
  (engine as any).close?.();
  await fs.copyFile(dbPath, backupPath);
  console.log("✅ Backup created");

  // Reopen engine and modify data
  resetEngineForTesting();
  const engine2 = await openEngine();
  await engine2.put("kv", "backup-key", { value: "modified" });
  (engine2 as any).close?.();

  // Restore backup
  await fs.copyFile(backupPath, dbPath);
  resetEngineForTesting();
  const engine3 = await openEngine();
  const restored = await engine3.get<{ value: string }>("kv", "backup-key");

  if (restored?.value !== "original") {
    console.error("❌ Restore failed: expected 'original', got", restored?.value);
    process.exit(1);
  }

  console.log("✅ Restore verified: data matches backup");
  (engine3 as any).close?.();

  // Cleanup
  await fs.rm(dbPath, { force: true });
  await fs.rm(backupPath, { force: true });

  console.log("\n✅ Backup / restore test PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});