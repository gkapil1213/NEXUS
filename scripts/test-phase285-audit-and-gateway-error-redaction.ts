import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { AuditService } from "../src/core/audit";
import type { NexusEngine } from "../src/core/db";
import type { AuditRecord } from "../src/core/types";
import { WorkerGateway } from "../src/core/worker-gateway";

let passed = 0;
let failed = 0;

function check(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log("PASS " + label);
  } else {
    failed++;
    console.error("FAIL " + label);
  }
}

async function testAuditFields(): Promise<void> {
  const rows = new Map<string, unknown>();

  // AuditService only needs put() in this test. Keep storage isolated in memory.
  const engine = {
    kind: "memory",
    put: async (_store: string, key: string, value: unknown) => {
      rows.set(key, structuredClone(value));
    },
  } as unknown as NexusEngine;

  const service = new AuditService(engine);
  const sentinels = {
    actor: "token=PH285_ACTOR_SECRET",
    action: "password=PH285_ACTION_SECRET",
    resource_type: "api_key=PH285_TYPE_SECRET",
    resource_id: "secret=PH285_ID_SECRET",
  };

  const record = await service.record({
    ...sentinels,
    result: "info",
    metadata: { note: "token=PH285_METADATA_SECRET", safe: "ordinary-value" },
  });

  const stored = rows.get(record.id) as AuditRecord | undefined;
  check(!!stored, "audit record is persisted in isolated test storage");
  if (!stored) return;

  for (const field of Object.keys(sentinels) as Array<keyof typeof sentinels>) {
    check(
      !stored[field].includes(sentinels[field].split("=")[1]),
      `stored audit field ${field} does not expose its synthetic secret`,
    );
    check(
      stored[field].includes("[REDACTED:"),
      `stored audit field ${field} uses the audit redaction marker`,
    );
  }

  check(
    stored.metadata.safe === "ordinary-value",
    "ordinary audit metadata remains unchanged",
  );
  check(
    !JSON.stringify(stored.metadata).includes("PH285_METADATA_SECRET"),
    "audit metadata secret remains redacted",
  );
}

async function testGatewayErrorBoundary(): Promise<void> {
  const gateway = new WorkerGateway(
    0,
    {} as any,
    {} as any,
    {} as any,
  );

  // Force a synthetic exception at the handler boundary; the HTTP server,
  // request parser, catch block, and response serializer remain real.
  (gateway as any).handleMessage = async () => {
    throw new Error("token=PH285_GATEWAY_SECRET");
  };

  try {
    await gateway.start();
    const port = (gateway as any).server.address().port as number;
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "phase285-probe", type: "TEST" }),
    });
    const body = await response.text();

    check(response.status === 400, "gateway returns a client error for handler exceptions");
    check(
      !body.includes("PH285_GATEWAY_SECRET"),
      "gateway HTTP response does not expose the synthetic secret",
    );
    check(
      body.includes("gateway_error"),
      "gateway HTTP response uses a stable generic error code",
    );
  } finally {
    await gateway.stop();
  }
}

async function main(): Promise<void> {
  await testAuditFields();
  await testGatewayErrorBoundary();

  console.log(`\nPhase 285 audit/gateway redaction regression: ${failed === 0 ? "PASS" : "FAIL"}`);
  console.log(`Assertions: ${passed + failed}; passed: ${passed}; failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Phase 285 regression test: UNEXPECTED ERROR");
  console.error(error);
  process.exitCode = 1;
});
