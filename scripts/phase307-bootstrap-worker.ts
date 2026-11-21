// scripts/phase307-bootstrap-worker.ts
// Phase 307: independent-process HTTP bootstrap worker.
// Uses the real NexusKernel, SQLite engine, and HTTP bootstrap route.

import { NexusKernel } from "../src/core/kernel";
import { createHttpApp } from "../src/server/http";
import { IdempotencyStore } from "../src/server/idempotency";
import type { Server } from "node:http";

async function main(): Promise<void> {
  if (process.env.NEXUS_PERSISTENCE_ENGINE !== "sqlite" || !process.env.NEXUS_DB_PATH) {
    throw new Error("Worker requires an isolated SQLite database path");
  }

  const kernel = new NexusKernel();
  const services = await kernel.boot();

  const store: any = (services as any).executionStore;
  const rawDb: any = store && typeof store === "object" ? store.db : undefined;
  if (!rawDb) throw new Error("SQLite executionStore.db unavailable");

  if (process.env.P307_INIT_ONLY === "1") {
    try {
      await kernel.shutdown({ finalRecoveryPass: false } as any);
    } finally {
      try { (services.engine as any).close?.(); } catch { /* test cleanup */ }
    }
    process.exit(0);
  }

  const app = createHttpApp({
    services,
    idempotency: new IdempotencyStore(rawDb),
    accessLog: false,
    requestTimeoutMs: 5000,
  });

  const server: Server = app.listen(0, "127.0.0.1");

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Worker could not determine its HTTP port");
  }

  console.log(`P307_WORKER_READY:${address.port}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await kernel.shutdown({ finalRecoveryPass: false } as any);
    } catch {
      // Continue to close the test-owned SQLite connection.
    }
    try {
      (services.engine as any).close?.();
    } catch {
      // Best-effort test cleanup.
    }
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    if (chunk.includes("shutdown")) {
      void shutdown().then(() => process.exit(0));
    }
  });
}

main().catch((error) => {
  console.error("P307_WORKER_ERROR:", error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
