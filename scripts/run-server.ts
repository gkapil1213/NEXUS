// scripts/run-server.ts
// Phase 179: production entrypoint for the operator HTTP boundary.
//
// Boots the kernel, wires the request-level idempotency store on the same
// SQLite connection, mounts the recovery control router, and listens.
//
// Idempotent: safe to restart. Reads CONFIG.gateway.port; falls back to
// 4000 if unset. Never starts without a durable execution store.

import { NexusKernel } from "../src/core/kernel";
import { createHttpApp } from "../src/server/http";
import { IdempotencyStore } from "../src/server/idempotency";
import { CONFIG } from "../src/core/config";

async function main(): Promise<void> {
  const kernel = new NexusKernel();
  const services = await kernel.boot();

  const store: any = services.executionStore;
  const rawDb: any = store && typeof store === "object" ? (store as any).db : undefined;
  if (!rawDb) {
    throw new Error(
      "run-server: durable execution store is required (sqlite persistence)",
    );
  }

  const idempotency = new IdempotencyStore(rawDb);
  const app = createHttpApp({ services, idempotency });

  const port: number = (CONFIG as any).gateway?.port ?? 4000;
  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log("NEXUS operator API listening on :" + port);
  });

  const shutdown = (): void => {
    server.close(() => {
      void kernel.shutdown({ finalRecoveryPass: false });
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("run-server failed:", e);
  process.exit(1);
});