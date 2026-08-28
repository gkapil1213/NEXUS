import { openEngine, resetEngineForTesting } from "../src/core/db";
import { CONFIG } from "../src/core/config";

async function main() {
  console.log("=== Graceful Shutdown Test ===\n");

  resetEngineForTesting();
  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = "./test-graceful.sqlite";

  const engine = await openEngine();
  await engine.put("kv", "shutdown-key", { value: "persisted" });

  // Gracefully close
  (engine as any).close?.();
  console.log("✅ Engine closed gracefully");

  // Reopen to verify persistence
  resetEngineForTesting();
  const engine2 = await openEngine();
  const value = await engine2.get<{ value: string }>("kv", "shutdown-key");

  if (value?.value !== "persisted") {
    console.error("❌ Data lost after graceful shutdown");
    process.exit(1);
  }

  console.log("✅ Data persisted and reloaded");
  (engine2 as any).close?.();
  console.log("\n✅ Graceful shutdown test PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});