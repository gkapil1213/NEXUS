// Child process for test-phase300-wp3-cross-process.ts.
// Exercises the production DispatchService.cancelDetailed() path.

import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { RemoteExecutionManager } from "../src/core/remote-execution-manager";
import { DispatchService } from "../src/core/dispatch-service";
import { JobDispatcher } from "../src/core/job-dispatcher";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const payloadRaw = process.env.WP3_CANCEL_PAYLOAD;

  if (!url || !payloadRaw) {
    console.error(JSON.stringify({ error: "missing DATABASE_URL or WP3_CANCEL_PAYLOAD" }));
    process.exit(1);
  }

  const payload = JSON.parse(payloadRaw) as { dispatchId: string };
  const client = new PgClient();
  await client.connect(url);

  let cancelCalls = 0;

  try {
    const engine = new PgAsyncEngine(client);
    const store = new (ExecutionStore as any)({} as any, engine);

    const adapter: any = {
      async connect(): Promise<void> {},
      async disconnect(): Promise<void> {},
      async dispatch(): Promise<{ dispatchId: string }> {
        return { dispatchId: "unused" };
      },
      async cancel(_providerId: string): Promise<void> {
        cancelCalls++;
      },
      async getStatus(): Promise<{ status: string }> {
        return { status: "RUNNING" };
      },
      async collectResult(): Promise<{ success: boolean; exitCode: number }> {
        return { success: true, exitCode: 0 };
      },
      async *streamLogs(): AsyncIterable<{ sequence: number; type: string; data: string }> {},
    };

    const manager = new RemoteExecutionManager(adapter, store);
    const registry: any = { register: () => {}, getWorker: () => undefined };
    const leaseManager: any = {};
    const jobDispatcher = new JobDispatcher(registry, manager, store, leaseManager);
    const service = new DispatchService(jobDispatcher, manager, store);

    const outcome = await service.cancelDetailed(payload.dispatchId);

    console.log(JSON.stringify({ outcome, cancelCalls }));
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
