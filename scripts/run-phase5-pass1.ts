import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { openEngine, resetEngineForTesting, nid } from "../src/core/db";
import { CONFIG } from "../src/core/config";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";
import { ObservabilityService } from "../src/core/observability-service";
import { IncidentService } from "../src/core/incident-service";
import { AlertEngine } from "../src/core/alert-engine";
import { MetricsAgent } from "../src/core/metrics-agent";
import { HealthAgent } from "../src/core/health-agent";

const DB_PATH = path.join(process.cwd(), "data", "nexus-pass1.sqlite");

async function ensureCleanDb() {
  await fs.rm(DB_PATH, { force: true });
  await fs.rm(DB_PATH + "-wal", { force: true });
  await fs.rm(DB_PATH + "-shm", { force: true });
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
}

async function runChildRead(dbPath: string, key: string): Promise<boolean> {
  const code = `
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(dbPath)});
    const row = db.prepare('SELECT value FROM nexus_records WHERE store = ? AND key = ?').get('kv', ${JSON.stringify(`incident:${key}`)});
    console.log(row ? row.value : 'NOT_FOUND');
    db.close();
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => resolve(code === 0 && out.includes("OPEN") && out.includes("incident-pass1")));
  });
}

async function main() {
  console.log("=== NEXUS Phase 5 Pass 1: Persistent Runtime Foundation ===\n");

  await ensureCleanDb();
  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = DB_PATH;
  resetEngineForTesting();

  const engine = await openEngine();
  console.log(`Persistence engine: ${engine.kind}`);

  const observability = new ObservabilityService(engine);
  const metrics = new MetricsAgent(observability);
  const health = new HealthAgent(observability);
  const alerts = new AlertEngine(observability);
  const incidents = new IncidentService(observability);
  const events = new EventService(engine);
  const audits = new AuditService(engine);
  await events.init();

  // 1. Real persistent write – incident
  const incidentId = nid("incident-pass1");
  await observability.createIncident({
    id: incidentId,
    tenant_id: "test",
    environment: "local",
    service: "nexus",
    severity: "HIGH",
    title: "Persistent incident test",
    description: "Created in Pass 1",
    trigger_alert_id: null,
    status: "OPEN",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as any);

  // 2. Event
  await events.emit({ type: "security.started", source: "pass1", execution_id: "exec-pass1" });

  // 3. Audit
  await audits.record({ actor: "system", action: "pass1.write", resource_type: "test", resource_id: "r1", result: "ALLOWED" });

  // 4. Metric
  await metrics.collectProcessMetrics("nexus-pass1", "local");

  // 5. Health check
  await health.checkProcessHealth();

  // 6. Alert rule + observation
  await observability.createAlertRule({ id: "rule-pass1", metric: "test_metric", operator: ">", threshold: 0, severity: "LOW", environment: "local", service: "nexus-pass1", window_seconds: 60 } as any);
  await observability.recordObservation({ id: nid("obs-pass1"), source: "pass1", environment: "local", service: "nexus-pass1", metric: "test_metric", value: 1, unit: "count", status: "OBSERVED" });
  await alerts.evaluateRules();

  // Close and reset
  if ((engine as any).close) (engine as any).close();
  resetEngineForTesting();

  // 7. Independent read via child process
  const independentRead = await runChildRead(DB_PATH, incidentId);
  console.log(`Independent read: ${independentRead ? "PASS" : "FAIL"}`);

  // 8. Restart persistence – reopen engine and read
  const engine2 = await openEngine();
  const incidentAfterRestart = await engine2.get("kv", `incident:${incidentId}`);
  console.log(`Restart read: ${incidentAfterRestart ? "PASS" : "FAIL"}`);

  // 9. Transaction rollback test
  if ((engine2 as any).transaction) {
    try {
      (engine2 as any).transaction(() => {
        engine2.put("kv", "tx-test-1", { value: 1 });
        engine2.put("kv", "tx-test-2", { value: 2 });
        throw new Error("forced failure");
      });
    } catch {}
    const tx1 = await engine2.get("kv", "tx-test-1");
    const tx2 = await engine2.get("kv", "tx-test-2");
    console.log(`Transaction rollback: ${tx1 === undefined && tx2 === undefined ? "PASS" : "FAIL"}`);
  }

  // 10. API persistence: simulate API write by storing a record, then read after reopen
  const apiKey = "api-test-key";
  const apiValue = { msg: "hello" };
  await engine2.put("kv", apiKey, apiValue);
  if ((engine2 as any).close) (engine2 as any).close();
  resetEngineForTesting();
  const engine3 = await openEngine();
  const apiAfterRestart = await engine3.get("kv", apiKey);
  console.log(`API persistence: ${apiAfterRestart && apiAfterRestart.msg === "hello" ? "PASS" : "FAIL"}`);
  if ((engine3 as any).close) (engine3 as any).close();

  console.log("\n=== PASS 1 COMPLETE ===");
  console.log("Persistence engine:", engine.kind);
  console.log("Database path:", DB_PATH);
  console.log("All persistence checks completed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});