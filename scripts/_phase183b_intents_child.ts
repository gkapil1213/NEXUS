// scripts/_phase183b_intents_child.ts
// Phase 183b child: one release-intent operation against real Postgres.

import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";

function mkInput(prefix: string): any {
  return {
    releaseId: "rel-" + prefix,
    executionId: "exec-" + prefix,
    attemptId: "att-" + prefix,
    artifactId: "art-" + prefix,
    artifactDigest: "sha256:" + prefix,
    commitSha: "c-" + prefix,
    environment: "production",
    projectId: "proj-" + prefix,
    imageRepository: "nexus/" + prefix,
    imageTag: "v1",
    imageId: "sha256-img-" + prefix,
    imageDigest: "sha256:dig-" + prefix,
    containerName: "c-" + prefix,
    containerPort: 8080,
  };
}

async function main(): Promise<void> {
  const [, , cmd, url, ...args] = process.argv;
  if (!cmd || !url) { console.error("usage: <cmd> <url> [args]"); process.exit(2); }

  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const store = new ExecutionStore(syncEngine, asyncDb);
  const service = new ReleaseDeploymentIntentService(store);

  try {
    switch (cmd) {
      case "create-intent": {
        const prefix = args[0];
        const r = await service.getOrCreateAsync(mkInput(prefix));
        console.log(JSON.stringify({
          intentKey: r.intent.intentKey,
          created: r.created,
          status: r.intent.status,
          pid: process.pid,
        }));
        break;
      }
      case "get-intent": {
        const key = args[0];
        const got = await service.getAsync(key);
        console.log(JSON.stringify({
          found: !!got,
          status: got?.status ?? null,
          pid: process.pid,
        }));
        break;
      }
      case "acquire-lease": {
        const key = args[0], workerId = args[1];
        const r = await service.acquireLeaseAsync(key, workerId);
        console.log(JSON.stringify({ acquired: r.acquired, holder: r.holder, pid: process.pid }));
        break;
      }
      case "create-race": {
        const prefix = args[0];
        try {
          const r = await service.getOrCreateAsync(mkInput(prefix));
          console.log(JSON.stringify({
            ok: true,
            intentKey: r.intent.intentKey,
            created: r.created,
            pid: process.pid,
          }));
        } catch (e) {
          console.log(JSON.stringify({ ok: false, err: String(e).slice(0, 150), pid: process.pid }));
        }
        break;
      }
      default:
        console.error("unknown cmd: " + cmd);
        process.exit(2);
    }
  } finally {
    try { await pg.close(); } catch { /* ignore */ }
    try { mem.close(); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error("CHILD_FAIL:", e?.message ?? e); process.exit(1); });