// scripts/run-server.ts
// Phase 179/180: production entrypoint + graceful shutdown.
//
// Phase 179: boot the kernel, wire IdempotencyStore, mount recovery routes.
// Phase 180: bounded graceful shutdown -- stop accepting, wait for in-flight
//   requests up to a grace period, then close kernel + DB. Never marks
//   active recovery work as complete; never silently cancels durable work.

import { NexusKernel } from "../src/core/kernel";
import { createHttpApp } from "../src/server/http";
import { IdempotencyStore } from "../src/server/idempotency";
import { CONFIG } from "../src/core/config";
import { nid } from "../src/core/db";
import { resolvePersistenceMode } from "../src/core/persistence-mode";
import { emitServerEvent } from "../src/server/logging";

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  // Phase 182: stable per-process instance id for observability and
  // multi-process coordination diagnostics. Honours an operator-supplied
  // value so log correlation across a deliberate restart keeps working.
  if (!process.env.NEXUS_INSTANCE_ID) {
    process.env.NEXUS_INSTANCE_ID = nid("inst");
  }

  // Phase 182: truthful coordination mode. Logged at boot, surfaced through
  // /health/ready meta, never auto-upgraded. A shared-mode request fails
  // closed inside kernel.boot().
  const pm = resolvePersistenceMode();
  emitServerEvent("persistence_mode", {
    mode: pm.mode,
    coordination: pm.coordination,
    instance_id: pm.instanceId,
    reason: pm.reason,
  });

  const kernel = new NexusKernel();
  const services = await kernel.boot();

  const store: any = services.executionStore;
  const rawDb: any = store && typeof store === "object" ? (store as any).db : undefined;
  if (!rawDb) {
    throw new Error("run-server: durable execution store is required (sqlite persistence)");
  }

  const idempotency = new IdempotencyStore(rawDb);
  const app = createHttpApp({
    services,
    idempotency,
    accessLog: true,
    rateLimit: { enabled: true },
    requestTimeoutMs: 30_000,
  });

  const port: number = Number(process.env.NEXUS_HTTP_PORT) || ((CONFIG as any).gateway?.port ?? 4000);

  const server = app.listen(port, () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    emitServerEvent("listening", { port: actualPort });
  });

  let inflight = 0;
  server.on("request", (_req, res) => {
    inflight++;
    res.on("finish", () => { inflight--; });
    res.on("close", () => { inflight--; });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    emitServerEvent("shutdown_initiated", { signal, inflight });

    // 1. Stop accepting new connections.
    server.close();

    // 2. Bounded wait for in-flight requests to finish.
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (inflight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // 3. Close kernel (recovery supervisor, workers, DB).
    try {
      await kernel.shutdown({ finalRecoveryPass: false });
    } catch (e) {
      emitServerEvent("shutdown_kernel_error", { error: (e as Error).message });
    }

    emitServerEvent("shutdown_complete", { inflight, forced: inflight > 0 });
    process.exit(inflight > 0 ? 1 : 0);
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

  // Test/embedded usage: stdin-based shutdown trigger, gated by an env var
  // so a real deployment cannot accidentally shut down on stray stdin data.
  // Windows has no POSIX signals; this is the deterministic way to exercise
  // the shutdown path there. On POSIX the SIGINT/SIGTERM handlers above are
  // still the production path.
  if (process.env.NEXUS_ALLOW_STDIN_SHUTDOWN === "1" && process.stdin) {
    process.stdin.on("data", (chunk: Buffer | string) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (/shutdown/.test(s)) void shutdown("stdin");
    });
    process.stdin.resume();
  }
}

main().catch((e) => {
  emitServerEvent("startup_failed", { error: (e as Error).message });
  process.exit(1);
});