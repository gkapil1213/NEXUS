// scripts/wp3-cancel-worker.ts
// Child process for test-phase300-wp3-cross-process.ts (WP3-X5).
// Reads a JSON payload from WP3_CANCEL_PAYLOAD env var. Calls
// cancelRemoteDispatchIfNotTerminalAsync once for the given dispatch.
// Emits the outcome as JSON on stdout.
//
// This is the same atomic primitive DispatchService.tryCancelDispatchRecord
// calls for the durable-state write. The provider-call behavior of
// cancelDetailed is covered by test-phase300-wp6-cancellation-status.ts.

import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { ExecutionStore } from "../src/core/execution-store";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const payloadRaw = process.env.WP3_CANCEL_PAYLOAD;
  if (!url || !payloadRaw) {
    console.error(JSON.stringify({ error: "missing DATABASE_URL or WP3_CANCEL_PAYLOAD" }));
    process.exit(1);
  }
  const p = JSON.parse(payloadRaw) as { dispatchId: string };

  const client = new PgClient();
  await client.connect(url);
  const engine = new PgAsyncEngine(client);
  const store = new (ExecutionStore as any)({} as any, engine);

  let outcome: any;
  try {
    outcome = await (store as any).cancelRemoteDispatchIfNotTerminalAsync(p.dispatchId);
  } catch (e) {
    console.error(JSON.stringify({ error: String(e) }));
    await client.close();
    process.exit(1);
    return;
  }

  await client.close();
  console.log(JSON.stringify({ outcome }));
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(JSON.stringify({ error: String(e) }));
  process.exit(1);
});