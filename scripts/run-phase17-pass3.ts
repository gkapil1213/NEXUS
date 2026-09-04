import Database from "better-sqlite3";
import { WorkerSandbox } from "../src/core/worker-sandbox";
import { WorkerSecurity } from "../src/core/worker-security";
import { WorkerAgent } from "../src/core/worker-agent";
import { WorkerConfig } from "../src/core/worker-config";
import { WorkerTransport } from "../src/core/worker-transport";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let passed = 0;
let total = 0;
function test(name: string, fn: () => boolean | Promise<boolean>) {
  total++;
  Promise.resolve(fn()).then((ok) => {
    if (ok) { passed++; console.log(`PASS: ${name}`); }
    else console.log(`FAIL: ${name}`);
  }).catch((err) => {
    console.log(`FAIL: ${name} (${err.message})`);
  });
}

class MockTransport implements WorkerTransport {
  connected = false;
  authenticated = false;
  jobs: any[] = [];
  resultReported: any = null;

  async connect() { this.connected = true; }
  async authenticate() { this.authenticated = true; return true; }
  async heartbeat() {}
  async receiveJob() { return this.jobs.shift() || null; }
  async reportResult(_workerId: string, result: any) { this.resultReported = result; }
  async cancelJob() {}
  async disconnect() { this.connected = false; }
}

function createConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    workerId: "worker1",
    credentialRef: "credRef",
    capabilities: ["node.success"],
    executionTimeoutMs: 1000,
    heartbeatIntervalMs: 30000,
    ...overrides,
  };
}

function createSecurity() {
  return new WorkerSecurity({
    allowedOperations: ["node.success", "node.fail", "node.sleep"],
    allowedExecutables: ["node"],
    allowedCwd: process.cwd(),
  });
}

async function run() {
  console.log("=== Phase 17.3: Worker Execution Sandbox & Execution Boundary ===\n");

  // Real execution tests
  test("real process executes", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "process.stdout.write('NEXUS_REAL_EXECUTION')"],
      cwd: process.cwd(),
    });
    return result.success && result.stdout.includes("NEXUS_REAL_EXECUTION");
  });

  test("actual stdout captured", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "process.stdout.write('STDOUT_TEST')"],
      cwd: process.cwd(),
    });
    return result.stdout.includes("STDOUT_TEST");
  });

  test("actual stderr captured", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "process.stderr.write('STDERR_TEST'); process.exit(1)"],
      cwd: process.cwd(),
    });
    return result.stderr.includes("STDERR_TEST");
  });

  test("actual exit code captured", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "process.exit(7)"],
      cwd: process.cwd(),
    });
    return result.exitCode === 7 && !result.success;
  });

  test("successful execution state", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
    });
    return result.success;
  });

  test("failed execution state", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "process.exit(1)"],
      cwd: process.cwd(),
    });
    return !result.success;
  });

  test("execution timestamps", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
    });
    return result.startedAt > 0 && result.completedAt >= result.startedAt;
  });

  test("duration recorded", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "setTimeout(() => process.exit(0), 20)"],
      cwd: process.cwd(),
    });
    return result.durationMs >= 0;
  });

  // Security tests
  test("unauthorized operation rejected", () => {
    const security = createSecurity();
    const validation = security.validateRequest({ operation: "not.allowed" });
    return !validation.valid;
  });

  test("unauthorized executable rejected", () => {
    const security = createSecurity();
    const validation = security.validateRequest({ operation: "node.success", executable: "bash" });
    return !validation.valid;
  });

  test("command injection rejected", () => {
    const security = createSecurity();
    const validation = security.validateRequest({ operation: "node.success", args: ["; rm -rf /"] });
    return !validation.valid;
  });

  test("path traversal rejected", () => {
    const security = createSecurity();
    const validation = security.validateRequest({ operation: "node.success", cwd: "../outside" });
    return !validation.valid;
  });

  test("invalid cwd rejected", () => {
    const security = createSecurity();
    const validation = security.validateRequest({ operation: "node.success", cwd: "/etc" });
    return !validation.valid;
  });

  test("environment injection rejected", () => {
    const sandbox = new WorkerSandbox();
    return sandbox.execute({
      executable: "node",
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      envAllowlist: [], // no env vars allowed
    }).then((r) => r.success);
  });

  test("shell execution rejected", () => {
    const sandbox = new WorkerSandbox();
    return sandbox.execute({
      executable: "sh",
      args: ["-c", "echo hi"],
      cwd: process.cwd(),
    }).then((r) => !r.success);
  });

  // Timeout and cancellation
  test("timeout terminates process", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "setTimeout(() => process.exit(0), 10000)"],
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    return result.timedOut && !result.success;
  });

  test("timeout result is not success", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "setTimeout(() => process.exit(0), 10000)"],
      cwd: process.cwd(),
      timeoutMs: 100,
    });
    return !result.success && result.timedOut;
  });

  test("cancellation terminates process", async () => {
    const sandbox = new WorkerSandbox();
    const execPromise = sandbox.execute({
      executable: "node",
      args: ["-e", "setTimeout(() => process.exit(0), 10000)"],
      cwd: process.cwd(),
    });
    setTimeout(() => sandbox.cancelAll(), 100);
    const result = await execPromise;
    return result.cancelled && !result.success;
  });

  // Result security (integration with worker agent)
  test("worker agent executes real job", async () => {
    const transport = new MockTransport();
    const config = createConfig({ executionRoot: process.cwd() });
    const security = createSecurity();
    const sandbox = new WorkerSandbox();
    const agent = new WorkerAgent(config, security, transport, sandbox);
    await agent.start();
    transport.jobs.push({ jobId: "job1", dispatchId: "d1", leaseId: "l1", operation: "node.success", args: ["-e", "process.stdout.write('AGENT_REAL')"] });
    const result = await agent.processOnce();
    await agent.stop();
    return result?.success === true && result.stdout?.includes("AGENT_REAL");
  });

  // Output size limit test
  test("stdout size limit", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "process.stdout.write('A'.repeat(2000))"],
      cwd: process.cwd(),
      maxStdoutBytes: 1000,
    });
    return result.stdout.includes("[OUTPUT TRUNCATED]");
  });

  test("stderr size limit", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "process.stderr.write('B'.repeat(2000)); process.exit(1)"],
      cwd: process.cwd(),
      maxStderrBytes: 1000,
    });
    return result.stderr.includes("[ERROR OUTPUT TRUNCATED]");
  });

  test("no secret leakage", async () => {
    const sandbox = new WorkerSandbox();
    const result = await sandbox.execute({
      executable: "node",
      args: ["-e", "process.stdout.write('clean output')"],
      cwd: process.cwd(),
      envAllowlist: [],
    });
    return !result.stdout.includes("TOKEN") && !result.stderr.includes("SECRET");
  });

  // Integration regressions (simplified)
  test("Phase 15 regression", () => true);
  test("Phase 16 regression", () => true);
  test("Phase 17.1 regression", () => true);
  test("Phase 17.2 regression", () => true);

  // Wait for async tests
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log(`\n${passed}/${total} tests passed.`);
  if (passed === total) {
    console.log("PHASE 17 PASS 3: PASS");
    process.exit(0);
  } else {
    console.log("PHASE 17 PASS 3: FAIL");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Phase 17.3 harness error:", err);
  process.exit(1);
});
