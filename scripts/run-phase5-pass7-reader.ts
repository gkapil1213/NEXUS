import { openEngine } from "../src/core/db";

async function main() {
  const engine = await openEngine();
  if (engine.kind !== "sqlite") {
    console.error("Expected SQLite engine");
    process.exit(1);
  }
  const metric = await engine.get<{ value: number }>("kv", "metric:pass7");
  if (!metric || metric.value !== 42) {
    console.error("Metric not found or wrong value");
    process.exit(1);
  }
  console.log(`METRIC_OK:${metric.value}`);
  process.exit(0);
}

main();