import { randomUUID } from "node:crypto";
import { PgClient } from "../src/core/pg-client";
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
      "Exactly 17 expected columns exist",
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

    console.log("\n=== WP8 RESULT ===");
    console.log(`PASS: ${7 - failures}`);
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

main().catch(error => {
  console.error("RESULT: FAIL", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
