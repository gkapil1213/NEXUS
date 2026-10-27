import { PgClient } from "../src/core/pg-client";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("BLOCKED: DATABASE_URL is not set.");
    process.exitCode = 2;
    return;
  }

  const pg = new PgClient();

  try {
    await pg.connect(url);
    console.log("PASS: PostgreSQL connection established.");

    await bootstrapPgSchema(pg);
    console.log("PASS: First bootstrap completed.");

    await bootstrapPgSchema(pg);
    console.log("PASS: Second bootstrap completed (repeatability check).");

    const tables = await pg.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'implementation_specifications',
          'engineering_requests',
          'engineering_plans',
          'architecture_specifications',
          'remote_dispatches',
          'engineering_run_event_outbox',
          'nexus_sequences'
        )
      ORDER BY table_name
    `);

    const expectedTables = [
      "architecture_specifications",
      "engineering_plans",
      "engineering_requests",
      "engineering_run_event_outbox",
      "implementation_specifications",
      "nexus_sequences",
      "remote_dispatches"
    ];

    const actualTables = tables.rows.map(r => r.table_name);
    const missing = expectedTables.filter(t => !actualTables.includes(t));

    if (missing.length > 0) {
      console.error("FAIL: Missing tables:", missing.join(", "));
      process.exitCode = 1;
      return;
    }

    console.log(`PASS: All ${expectedTables.length} required tables exist.`);

    const indexes = await pg.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'implementation_specifications'
    `);

    const expectedIndexes = [
      "idx_impl_specs_run",
      "idx_impl_specs_plan",
      "idx_impl_specs_hash",
      "idx_impl_specs_run_hash"
    ];

    const actualIndexes = indexes.rows.map(r => r.indexname);
    const missingIndexes = expectedIndexes.filter(i => !actualIndexes.includes(i));

    if (missingIndexes.length > 0) {
      console.error("FAIL: Missing indexes:", missingIndexes.join(", "));
      process.exitCode = 1;
      return;
    }

    console.log(`PASS: All ${expectedIndexes.length} implementation indexes exist.`);
    console.log("RESULT: PASS — bootstrap ran twice and schema checks passed.");
  } catch (error) {
    console.error(
      "RESULT: FAIL — bootstrap verification failed:",
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  } finally {
    try {
      await pg.close();
    } catch (error) {
      console.error(
        "Connection close warning:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

main().catch(error => {
  console.error("RESULT: FAIL — unexpected error:", error);
  process.exitCode = 1;
});
