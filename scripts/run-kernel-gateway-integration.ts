import { NexusKernel } from "../src/core/kernel";
import { CONFIG } from "../src/core/config";
import { WorkerGatewayClient } from "../src/core/worker-gateway";
import { WorkerAgent } from "../src/core/worker-agent";
import { WorkerSandbox } from "../src/core/worker-sandbox";
import { WorkerSecurity } from "../src/core/worker-security";
import { WorkerConfig } from "../src/core/worker-config";
import { ExecutionAdapterRequest } from "../src/core/execution-adapter";
import { rmSync, existsSync } from "fs";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`PASS: ${msg}`); }
  else { fail++; console.error(`FAIL: ${msg}`); }
}
async function expectThrow(fn: () => Promise<any>, needle: string, msg: string) {
  try { await fn(); fail++; console.error(`FAIL: ${msg} (did not throw)`); }
  catch (e: any) {
    const s = String(e?.message ?? e);
    if (s.includes(needle)) { pass++; console.log(`PASS: ${msg}`); }
    else { fail++; console.error(`FAIL: ${msg} (threw: ${s})`); }
  }
}

const TMP_DB = `.nexus-kernel-gateway-${Date.now()}.sqlite`;

async function main() {
  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = TMP_DB;
  CONFIG.gateway.enabled = false;
  CONFIG.gateway.port = 0;

  const kernel = new NexusKernel();
  await kernel.boot();
  ok(true, "T1 kernel.boot() succeeded under Vite SSR runtime");

  ok(!!kernel.workerGateway, "T2 kernel constructed a real WorkerGateway");
  ok(!!kernel.remoteExecutionManager, "T2 kernel constructed a RemoteExecutionManager");
  ok(!!kernel.executionStore, "T2 kernel exposes ExecutionStore handle");
  ok(!!kernel.workerAuthStore, "T2 kernel exposes SqliteWorkerAuthStore handle");
  ok(!!kernel.remoteWorkerStore, "T2 kernel exposes RemoteWorkerStore handle");

  const mgr: any = kernel.remoteExecutionManager;
  const adapterCtor = mgr && mgr.adapter && mgr.adapter.constructor ? mgr.adapter.constructor.name : undefined;
  ok(adapterCtor === "WorkerGatewayRemoteExecutionAdapter",
     `T3 RemoteExecutionManager uses WorkerGatewayRemoteExecutionAdapter (got ${adapterCtor})`);
  ok(!!kernel.workerGateway && mgr && mgr.adapter && mgr.adapter.gateway === kernel.workerGateway,
     "T3 adapter.gateway === kernel.workerGateway (same instance)");

  ok(!(kernel.workerGateway as any).server?.address?.(), "T4 boot() did NOT open a TCP listener");

  CONFIG.gateway.enabled = false;
  await kernel.startGateway();
  ok(!(kernel.workerGateway as any).server?.address?.(), "T5 startGateway() when disabled is a no-op");

  CONFIG.gateway.enabled = true;
  CONFIG.gateway.port = 0;
  await kernel.startGateway();
  const addr1: any = (kernel.workerGateway as any).server?.address?.();
  ok(addr1 && typeof addr1.port === "number" && addr1.port > 0,
     `T6 startGateway() opened a real listener on port ${addr1 ? addr1.port : "n/a"}`);

  await kernel.startGateway();
  const addr2: any = (kernel.workerGateway as any).server?.address?.();
  ok(addr2 && addr1 && addr2.port === addr1.port, "T7 repeated startGateway() does not create a second listener");

  const gatewayPort = addr1.port;

  const workerId = "kernel-e2e-worker";
  const credential = "kernel-e2e-cred";
  kernel.remoteWorkerStore!.registerWorker({
    workerId, hostname: "localhost",
    capabilities: { operations: ["node"] },
    status: "ONLINE", registeredAt: Date.now(),
  } as any);
  kernel.workerAuthStore!.setCredential(workerId, credential);
  ok(true, "T8 durable worker registered + credential stored");

  // Seed the execution_jobs parent row that remote_dispatches references via
  // FOREIGN KEY (job_id) REFERENCES execution_jobs(id), defined in migration
  // 021_phase15_remote_control_plane.sql. In production, JobDispatcher creates
  // this row (and its attempt + lease) before calling RemoteExecutionManager.
  // This test bypasses JobDispatcher to exercise the kernel-owned adapter
  // path directly, so it must perform the same seeding via the existing
  // ExecutionStore lifecycle API.
  kernel.executionStore!.createJob({
    id: "job-kernel-1",
    idempotencyKey: "idem-job-kernel-1",
    jobType: "remote-process",
    status: "QUEUED",
    timeoutMs: 5000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cancellationRequested: false,
    cancellationAcknowledged: false,
  } as any);
  ok(!!kernel.executionStore!.getJob("job-kernel-1"),
     "T8b execution_jobs parent row seeded for dispatch FK");

  const req: ExecutionAdapterRequest = {
    operation: "node",
    args: ["-e", "console.log('kernel-e2e-ok')"],
    timeoutMs: 5000,
    metadata: { jobId: "job-kernel-1", attemptId: "attempt-kernel-1", idempotencyKey: "idem-kernel-1" },
  };
  const disp = await kernel.remoteExecutionManager!.dispatch(req, workerId, "lease-kernel-1");
  ok(typeof disp.dispatchId === "string" && disp.dispatchId.length > 0, "T9 kernel-owned dispatch returned a dispatchId");

  const stored = kernel.executionStore!.getRemoteDispatch(disp.dispatchId);
  ok(!!stored, "T9 dispatch reached durable ExecutionStore through the gateway control plane");
  ok(!!stored && stored.status === "DISPATCHED", "T9 durable dispatch starts as DISPATCHED");
  ok(!!stored && stored.workerId === workerId, "T9 durable dispatch preserves workerId");
  ok(!!stored && stored.jobId === "job-kernel-1", "T9 durable dispatch preserves jobId");
  ok(!!stored && stored.attemptId === "attempt-kernel-1", "T9 durable dispatch preserves attemptId");
  ok(!!stored && stored.leaseId === "lease-kernel-1", "T9 durable dispatch preserves leaseId");
  ok(!!stored && stored.idempotencyKey === "idem-kernel-1", "T9 durable dispatch preserves idempotencyKey");

  const client = new WorkerGatewayClient(`http://127.0.0.1:${gatewayPort}`, workerId, credential);
  const agent = new WorkerAgent(
    {
      workerId, credentialRef: credential,
      capabilities: ["node"],
      allowedOperations: ["node"],
      allowedExecutables: ["node"],
    } as WorkerConfig,
    new WorkerSecurity({ allowedOperations: ["node"], allowedExecutables: ["node"] }),
    client,
    new WorkerSandbox()
  );
  await agent.start();
  const jobResult: any = await agent.processOnce();
  ok(!!jobResult, "T10 WorkerAgent.processOnce() returned over the HTTP worker protocol");
  ok(!!jobResult && jobResult.success === true, "T11 real sandboxed Node execution succeeded");
  ok(!!jobResult && String(jobResult.stdout ?? "").includes("kernel-e2e-ok"), "T12 real stdout returned through the worker protocol");

  const done = kernel.executionStore!.getRemoteDispatch(disp.dispatchId);
  ok(!!done && done.status === "COMPLETED", "T13 dispatch transitioned to COMPLETED");
  const durableResult = kernel.executionStore!.getRemoteExecutionResultByDispatchId(disp.dispatchId);
  ok(!!durableResult, "T13 durable remote_execution_results row persisted");
  ok(!!durableResult && durableResult.success === true, "T13 durable result reports success");

  const disp2 = await kernel.remoteExecutionManager!.dispatch(req, workerId, "lease-kernel-1");
  ok(disp2.dispatchId === disp.dispatchId, "T14 idempotency: same key returns same dispatchId");
  const rows = kernel.executionStore!.listRemoteDispatchesByJob("job-kernel-1");
  ok(rows.length === 1, "T14 idempotency: exactly one durable dispatch for the key");

  const workerB = "kernel-e2e-worker-b";
  const credB = "kernel-e2e-cred-b";
  kernel.remoteWorkerStore!.registerWorker({
    workerId: workerB, hostname: "localhost",
    capabilities: { operations: ["node"] },
    status: "ONLINE", registeredAt: Date.now(),
  } as any);
  kernel.workerAuthStore!.setCredential(workerB, credB);
  const clientB = new WorkerGatewayClient(`http://127.0.0.1:${gatewayPort}`, workerB, credB);
  await clientB.connect();
  const authedB = await clientB.authenticate(workerB, credB);
  ok(authedB, "T15 worker B authenticates against the same gateway");
  await expectThrow(
    () => clientB.reportResult(workerB, jobResult),
    "dispatch_ownership_violation",
    "T15 worker B cannot report a result for worker A's dispatch"
  );

  const badReq: any = { operation: "node", args: [], metadata: {} };
  await expectThrow(
    () => kernel.remoteExecutionManager!.dispatch(badReq, workerId, "lease-x"),
    "dispatch_metadata_required",
    "T16 missing jobId/attemptId/idempotencyKey is rejected"
  );

  const ghostId = "ghost-dispatch-" + Date.now();
  kernel.executionStore!.addRemoteDispatch({
    dispatchId: ghostId, jobId: "job-kernel-1", attemptId: "attempt-kernel-1",
    workerId, leaseId: "lease-ghost",
    idempotencyKey: "idem-ghost-" + Date.now(),
    status: "DISPATCHED" as const,
    request: { operation: "node", args: [] },
    createdAt: Date.now(), updatedAt: Date.now(),
  } as any);
  await expectThrow(
    () => kernel.workerGateway!.collectDispatchResult(ghostId),
    "result_not_ready",
    "T16 missing durable result yields result_not_ready (no fake SUCCESS)"
  );

  await agent.stop();
  await kernel.stopGateway();
  ok(!(kernel.workerGateway as any).server?.address?.(), "T16 stopGateway() released the listener");

  await kernel.stopGateway();
  ok(true, "T16 repeated stopGateway() is idempotent");

  console.log(`\nKernel Gateway Integration: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) throw new Error(`Kernel integration FAILED with ${fail} failing checks`);
}

export async function run(): Promise<void> {
  try { await main(); }
  finally {
    try {
      for (const s of ["", "-journal", "-wal", "-shm"]) {
        const f = TMP_DB + s;
        if (existsSync(f)) rmSync(f, { force: true });
      }
    } catch { /* best-effort */ }
  }
}