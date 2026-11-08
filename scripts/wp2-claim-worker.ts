import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { ExecutionStore } from "../src/core/execution-store";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const workerId = process.env.WP2_WORKER_ID;
  if (!url || !workerId) {
    console.error(JSON.stringify({ error: "missing DATABASE_URL or WP2_WORKER_ID" }));
    process.exit(1);
  }
  const client = new PgClient();
  await client.connect(url);
  const engine = new PgAsyncEngine(client);
  const store = new (ExecutionStore as any)({} as any, engine);
  const claimed: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const rec = await store.claimNextDispatchForWorkerAsync(workerId);
    if (!rec) break;
    claimed.push(rec.dispatchId);
  }
  await client.close();
  console.log(JSON.stringify({ workerId, claimed }));
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(JSON.stringify({ error: String(e) }));
  process.exit(1);
});
