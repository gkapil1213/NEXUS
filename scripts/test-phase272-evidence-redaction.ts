import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvidenceService } from "../src/core/evidence-service";

async function main(): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "nexus-phase272-evidence-")
  );
  const evidencePath = path.join(tempDir, "evidence.json");

  const secrets = [
    "P272_PASSWORD_SENTINEL",
    "P272_TOKEN_SENTINEL",
    "P272_DB_CREDENTIAL_SENTINEL",
    "P272_URL_PASSWORD_SENTINEL",
  ];

  try {
    const service = new EvidenceService(evidencePath);

    const record = {
      generated_at: "2026-10-19T00:00:00.000Z",
      metadata: {
        execution_id: "phase272-regression",
        status: "PASS",
        duration_ms: 123,
      },
      configuration_checks: [
        {
          name: "database configuration",
          password: secrets[0],
          nested: {
            access_token: secrets[1],
            note: "ordinary metadata preserved",
          },
          connectionString:
            `postgres://user:${secrets[2]}@localhost:5432/nexus`,
        },
      ],
      scanner_executions: [
        {
          execution_id: "phase272-regression",
          scanner: "regression-test",
          scanner_version: "1.0",
          status: "ERROR" as const,
          started_at: "2026-10-19T00:00:00.000Z",
          completed_at: "2026-10-19T00:00:01.000Z",
          duration_ms: 1000,
          command_identity: "safe-test-command",
          target: null,
          findings: [],
          error_reason:
            `Connection failed: postgres://user:${secrets[3]}@db.example.test/nexus`,
        },
      ],
    };

    await service.writeEvidence(record);

    const raw = await fs.readFile(evidencePath, "utf8");
    const persisted = JSON.parse(raw);

    for (const secret of secrets) {
      assert.equal(
        raw.includes(secret),
        false,
        `Persisted evidence must not contain raw secret: ${secret}`
      );
    }

    assert.equal(
      persisted.configuration_checks[0].password,
      "[REDACTED]"
    );
    assert.equal(
      persisted.configuration_checks[0].nested.access_token,
      "[REDACTED]"
    );
    assert.equal(
      persisted.configuration_checks[0].connectionString,
      "[REDACTED]"
    );
    assert.equal(
      persisted.configuration_checks[0].nested.note,
      "ordinary metadata preserved"
    );
    assert.equal(persisted.metadata.execution_id, "phase272-regression");
    assert.equal(persisted.metadata.duration_ms, 123);

    assert.match(
      persisted.scanner_executions[0].error_reason,
      /postgres:\/\/\[REDACTED\]@db\.example\.test\/nexus/
    );

    const readBack = await service.readEvidence();
    assert.ok(readBack, "Evidence should be readable after persistence");
    assert.equal(
      (readBack as any).configuration_checks[0].password,
      "[REDACTED]"
    );

    console.log("PASS 272-1 nested password redacted in persisted file");
    console.log("PASS 272-2 nested token redacted in persisted file");
    console.log("PASS 272-3 connection string value redacted");
    console.log("PASS 272-4 URL credentials redacted in error text");
    console.log("PASS 272-5 no raw sentinel secrets in persisted JSON");
    console.log("PASS 272-6 ordinary metadata preserved");
    console.log("PASS 272-7 evidence read-back succeeds");
    console.log("\nPASS: 7");
    console.log("FAIL: 0");
    console.log("BLOCKED: 0");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAIL: Phase 272 evidence redaction regression");
  console.error(error);
  process.exitCode = 1;
});