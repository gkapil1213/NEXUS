import { randomUUID } from "node:crypto";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("BLOCKED: DATABASE_URL is not set.");

  const dbName = "nexus_p300wp8_" + randomUUID().replace(/-/g, "").slice(0, 12);
  assert(
    /^nexus_p300wp8_[a-f0-9]{12}$/.test(dbName) && dbName !== "nexus",
    "Safety guard rejected isolated database name."
  );

  const admin = new PgClient();
  let isolated: PgClient | null = null;
  let created = false;
  let failures = 0;

  const check = (name: string, condition: boolean, detail = "") => {
    if (condition) console.log(`[PASS] ${name}`);
    else {
      failures++;
      console.error(`[FAIL] ${name}${detail ? ": " + detail : ""}`);
    }
  };

  try {
    await admin.connect(baseUrl);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    created = true;
    console.log(`[setup] Created isolated database ${dbName}`);

    const isolatedUrl = new URL(baseUrl);
    isolatedUrl.pathname = "/" + dbName;

    isolated = new PgClient();
    await isolated.connect(isolatedUrl.toString());

    await bootstrapPgSchema(isolated);
    console.log("[PASS] First production bootstrap completed.");

    await bootstrapPgSchema(isolated);
    console.log("[PASS] Second production bootstrap completed.");

    const columns = await isolated.query<{
      column_name: string;
      data_type: string;
    }>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'remote_execution_results'
      ORDER BY ordinal_position
    `);

    const expected: Record<string, string> = {
      result_id: "text",
      job_id: "text",
      attempt_id: "text",
      worker_id: "text",
      dispatch_id: "text",
      lease_id: "text",
      success: "boolean",
      exit_code: "integer",
      stdout_ref: "text",
      stderr_ref: "text",
      evidence: "text",
      created_at: "bigint",
      stdout_sha256: "text",
      stderr_sha256: "text",
      result_sha256: "text",
      verification_status: "text",
      verified_at: "bigint"
    };

    const actual = new Map(columns.rows.map(c => [c.column_name, c.data_type]));
    const missing = Object.keys(expected).filter(k => !actual.has(k));
    const wrongTypes = Object.entries(expected)
      .filter(([k, type]) => actual.has(k) && actual.get(k) !== type)
      .map(([k, type]) => `${k}: expected ${type}, got ${actual.get(k)}`);

    check(
      "Exactly 17 expected columns exist with expected types",
      columns.rows.length === 17 &&
        missing.length === 0 &&
        wrongTypes.length === 0,
      `count=${columns.rows.length}; missing=${missing.join(",")}; types=${wrongTypes.join(";")}`
    );

    const fks = await isolated.query<{
      column_name: string;
      referenced_table: string;
      referenced_column: string;
      delete_rule: string;
    }>(`
      SELECT
        a.attname AS column_name,
        fc.relname AS referenced_table,
        af.attname AS referenced_column,
        CASE c.confdeltype
          WHEN 'c' THEN 'CASCADE'
          WHEN 'a' THEN 'NO ACTION'
          WHEN 'r' THEN 'RESTRICT'
          WHEN 'n' THEN 'SET NULL'
          WHEN 'd' THEN 'SET DEFAULT'
          ELSE 'UNKNOWN'
        END AS delete_rule
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      JOIN pg_class fc ON fc.oid = c.confrelid
      JOIN LATERAL unnest(c.confkey) WITH ORDINALITY fk(attnum, ord)
        ON fk.ord = k.ord
      JOIN pg_attribute af ON af.attrelid = fc.oid AND af.attnum = fk.attnum
      WHERE c.contype = 'f'
        AND ns.nspname = 'public'
        AND t.relname = 'remote_execution_results'
    `);

    const jobFk = fks.rows.find(
      f => f.column_name === "job_id" &&
           f.referenced_table === "execution_jobs" &&
           f.referenced_column === "id"
    );
    const dispatchFk = fks.rows.find(
      f => f.column_name === "dispatch_id" &&
           f.referenced_table === "remote_dispatches" &&
           f.referenced_column === "dispatch_id"
    );

    check("job_id foreign key exists", !!jobFk);
    check(
      "job_id delete rule matches bootstrap (NO ACTION)",
      jobFk?.delete_rule === "NO ACTION",
      `actual=${jobFk?.delete_rule ?? "missing"}`
    );
    check(
      "dispatch_id foreign key exists with CASCADE",
      dispatchFk?.delete_rule === "CASCADE",
      `actual=${dispatchFk?.delete_rule ?? "missing"}`
    );

    const indexes = await isolated.query<{
      indexname: string;
      indisunique: boolean;
      indexdef: string;
    }>(`
      SELECT
        i.relname AS indexname,
        ix.indisunique,
        pg_get_indexdef(i.oid) AS indexdef
      FROM pg_class t
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      JOIN pg_index ix ON ix.indrelid = t.oid
      JOIN pg_class i ON i.oid = ix.indexrelid
      WHERE ns.nspname = 'public'
        AND t.relname = 'remote_execution_results'
    `);

    const byName = new Map(indexes.rows.map(i => [i.indexname, i]));

    check(
      "idx_remote_results_job exists",
      !!byName.get("idx_remote_results_job") &&
        byName.get("idx_remote_results_job")!.indexdef.includes("(job_id)")
    );

    check(
      "idx_remote_results_dispatch exists and is UNIQUE",
      byName.get("idx_remote_results_dispatch")?.indisunique === true &&
        byName.get("idx_remote_results_dispatch")!.indexdef.includes("(dispatch_id)")
    );

    const workerIndex = byName.get("idx_remote_results_worker");
    check(
      "idx_remote_results_worker has worker_id, created_at DESC",
      !!workerIndex &&
        /worker_id.*created_at DESC/i.test(workerIndex.indexdef),
      workerIndex?.indexdef ?? "missing"
    );

    // Check: primary key on result_id
    const pk = await isolated.query<{ attname: string }>(`
      SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'remote_execution_results'::regclass
        AND i.indisprimary
    `);
    check(
      "result_id is the PRIMARY KEY",
      pk.rows.length === 1 && pk.rows[0].attname === "result_id",
      `columns=${JSON.stringify(pk.rows)}`
    );

    // Check: actual async writer persists a result in the fresh DB
    const wd = "wp8-writer-" + randomUUID();
    const wj = "wp8-writer-job-" + randomUUID();
    const wl = "wp8-writer-lease-" + randomUUID();
    const ww = "worker-A";
    const wnow = Date.now();

    await isolated.query(
      "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, retry_policy, timeout_ms, created_at, updated_at, last_attempt_at, next_attempt_at, current_lease_id, cancellation_requested, cancellation_acknowledged, priority) VALUES ($1, $2, 'remote.exec', '{}', 'RUNNING', NULL, NULL, $3, $3, NULL, NULL, NULL, 0, 0, 0)",
      [wj, "idem-job-" + wj, wnow]
    );
    await isolated.query(
      "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, renewed_at, released_at, status) VALUES ($1, $2, $3, $4, $5, NULL, NULL, 'ACTIVE')",
      [wl, wj, ww, wnow, wnow + 3600_000]
    );
    await isolated.query(
      "INSERT INTO remote_dispatches (dispatch_id, job_id, worker_id, attempt_id, lease_id, status, created_at, updated_at, idempotency_key) VALUES ($1, $2, $3, NULL, $4, 'DISPATCHED', $5, $5, $6)",
      [wd, wj, ww, wl, wnow, "idem-" + wd]
    );

    const asyncEngine = new PgAsyncEngine(isolated);
    const store = new (ExecutionStore as any)({} as any, asyncEngine);

    const persistOut = await store.persistRemoteExecutionResultAndDispatchAsOwnerAsync(
      {
        resultId: "res-" + wd,
        jobId: wj,
        attemptId: undefined,
        workerId: ww,
        dispatchId: wd,
        leaseId: wl,
        success: false,
        exitCode: 1,
        stdoutRef: "out",
        stderrRef: "",
        evidence: { test: true },
        createdAt: wnow,
        stdoutSha256: "a".repeat(64),
        stderrSha256: "b".repeat(64),
        resultSha256: "c".repeat(64),
        verificationStatus: "VERIFIED",
        verifiedAt: wnow,
      },
      {
        dispatchId: wd,
        jobId: wj,
        workerId: ww,
        leaseId: wl,
        attemptId: undefined,
        idempotencyKey: "idem-" + wd,
        status: "COMPLETED",
        createdAt: 0,
        updatedAt: Date.now(),
        result: { success: false, exitCode: 1, stdout: "out", stderr: "" },
      },
      wl, ww
    );

    check(
      "actual async writer persists in fresh DB",
      persistOut.persisted === true,
      `outcome=${JSON.stringify(persistOut)}`
    );

    const verifyRow = await isolated.query<{ success: boolean }>(
      "SELECT success FROM remote_execution_results WHERE dispatch_id = $1",
      [wd]
    );
    check(
      "persisted row has success=false (BOOLEAN round-trip)",
      verifyRow.rows.length === 1 && verifyRow.rows[0].success === false,
      `rows=${JSON.stringify(verifyRow.rows)}`
    );

    console.log("\n=== WP8 RESULT ===");
    console.log(`PASS: ${12 - failures}`);
    console.log(`FAIL: ${failures}`);
    if (failures > 0) throw new Error("WP8 fresh-bootstrap verification failed.");
  } finally {
    if (isolated) {
      await isolated.close();
      isolated = null;
    }

    if (created) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      console.log(`[cleanup] Dropped isolated database ${dbName}`);
    }

    await admin.close();
  }
}

main().catch((error) => {
  console.error(
    "RESULT: FAIL \u2014",
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});