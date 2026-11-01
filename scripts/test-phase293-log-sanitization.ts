import Database from "better-sqlite3";
import { join } from "path";
import { readFileSync, readdirSync } from "fs";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { WorkerEnvelopeStore, ENVELOPE_VERSION } from "../src/core/worker-envelope-store";
import { EnvHmacKeyProvider } from "../src/core/envelope-hmac-key-provider";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log("PASS:", label);
  } else {
    failed++;
    console.error("FAIL:", label, detail ?? "");
  }
}

function openFreshDb(): Database.Database {
  const db = new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((file: string) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

async function main(): Promise<void> {
  console.log("Phase 293 log sanitization regression\n");

  const raw = openFreshDb();
  const engine = SQLiteEngine.fromDatabase(raw);
  const provider = new EnvHmacKeyProvider({
    NEXUS_ENVELOPE_HMAC_KID: "phase293-test",
    NEXUS_ENVELOPE_HMAC_KEY_HEX: "cd".repeat(32),
  } as any);
  const store = new WorkerEnvelopeStore(engine, provider);

  const pathSentinel = "C:\\private\\PH293_DB_PATH.db";
  const sqlSentinel = "SELECT PH293_PRIVATE_SQL_SENTINEL";
  const secretSentinel = "PH293_SECRET_SENTINEL_7f19";

  raw.exec(`
    CREATE TRIGGER phase293_force_persist_error
    BEFORE INSERT ON worker_message_envelopes
    BEGIN
      SELECT RAISE(
        ABORT,
        '${pathSentinel} ${sqlSentinel} token=${secretSentinel}'
      );
    END;
  `);

  const captured: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => captured.push(args);

  let result;
  try {
    result = store.persist({
      messageId: "phase293-message",
      messageType: "HEARTBEAT",
      workerId: "phase293-worker",
      sessionId: "phase293-session",
      envelopeVersion: ENVELOPE_VERSION,
      acceptedAt: Date.now(),
      payload: { currentJobId: null },
    });
  } finally {
    console.error = originalError;
  }

  const logText = JSON.stringify(captured);
  check("DB failure returns persistence_error",
    result?.persisted === false && result.reason === "persistence_error");
  check("One fixed persistence event is logged", captured.length === 1);
  check("Log contains stable reason",
    logText.includes("worker_envelope_persist_failed") &&
    logText.includes("persistence_error"));
  check("Log excludes database path", !logText.includes(pathSentinel));
  check("Log excludes SQL diagnostic", !logText.includes(sqlSentinel));
  check("Log excludes secret sentinel", !logText.includes(secretSentinel));

  const gatewaySource = readFileSync(
    join(process.cwd(), "src", "core", "worker-gateway.ts"),
    "utf8"
  );
  const initStart = gatewaySource.indexOf('status: "INSPECTION_INIT_FAILED"');
  const initEnd = gatewaySource.indexOf("\n      }", initStart);
  const initBlock = initStart >= 0 && initEnd > initStart
    ? gatewaySource.slice(initStart, initEnd)
    : "";

  check("Gateway initialization log has stable reason",
    initBlock.includes('reason: "recovery_inspection_unavailable"'));
  check("Gateway initialization log omits raw error serialization",
    !initBlock.includes("String((e as any)") &&
    !initBlock.includes("error:"));

  raw.close();

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Phase 293 test harness failed:", error);
  process.exitCode = 1;
});
