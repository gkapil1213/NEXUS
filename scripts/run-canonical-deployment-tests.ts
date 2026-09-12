// scripts/run-canonical-deployment-tests.ts
//
// Focused tests for CanonicalDeploymentOrchestrator. Mock Docker + mock
// SmokeTestService are scripted; the DeploymentHistoryService runs against
// the real NexusEngine, so persistence is exercised for real.

import { openEngine } from "../src/core/db";
import { DeploymentHistoryService } from "../src/core/deployment-history";
import { CanonicalDeploymentOrchestrator } from "../src/core/deployment-orchestrator";
import type { DockerAdapter, DockerOp, DockerResult, SmokeTestService } from "../src/core/runtime";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  Evidence: " + detail : "")); }
  else { fail++; console.log("[FAILED] " + name + (detail ? "  Evidence: " + detail : "")); }
}

/* ---------------------------- mock Docker ------------------------------- */

type DockerScript = (op: DockerOp) => Partial<DockerResult> | undefined;

function mockDocker(script: DockerScript): DockerAdapter & { calls: DockerOp[] } {
  const calls: DockerOp[] = [];
  return {
    calls,
    async run(op: DockerOp): Promise<DockerResult> {
      calls.push(op);
      const over = script(op) ?? {};
      return {
        status: "SUCCEEDED", command: "docker " + op.kind,
        exit_code: 0, stdout: "", stderr: "", duration_ms: 1, blocked_reason: null,
        ...over,
      };
    },
  } as any;
}

/* ------------------------- mock SmokeTestService ------------------------ */

function mockSmoke(script: (input: any) => any): SmokeTestService {
  return {
    async run(input: any) { return script(input); },
  } as any;
}

function okSmoke() {
  return { health: { ok: true, error: null, status_code: 200 }, smoke: { status: "PASSED" }, verdict: "PASS" };
}
function failSmoke() {
  return { health: { ok: false, error: "HTTP 500", status_code: 500 }, smoke: { status: "FAILED" }, verdict: "FAIL" };
}

/* --------------------------------- main -------------------------------- */

const fakeSvc = { events: { emit: async () => {} }, audit: { record: async () => {} } } as any;

async function main() {
  console.log("NEXUS CANONICAL DEPLOYMENT ORCHESTRATOR TESTS");
  console.log("=============================================\n");

  const engine = await openEngine();
  const history = new DeploymentHistoryService(engine);

  // ---- T1: :latest rejected ----
  {
    const docker = mockDocker(() => undefined);
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    let threw = false;
    try {
      await orch.deploy({
        project_id: "t1", environment: "dev", release_id: "r1",
        image_repository: "nexus/x", image_tag: "latest", image_id: "sha256:aaa",
        container_name: "t1-c", container_port: 8080,
      });
    } catch { threw = true; }
    check("T1 :latest rejected", threw && docker.calls.length === 0, "threw=" + threw);
  }

  // ---- T1b: digest must be used as immutable Docker image reference ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t1b\n" };
      if (op.kind === "inspect" && op.image === "container-t1b") {
        return {
          stdout: JSON.stringify([{
            Image: "sha256:aaa",
            NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12345" }] } }
          }])
        };
      }
      if (op.kind === "inspect" && op.image === "nexus/x@sha256:aaa") {
        return { stdout: JSON.stringify([{ Id: "sha256:aaa" }]) };
      }
      return undefined;
    });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);

    const r = await orch.deploy({
      project_id: "t1b", environment: "dev", release_id: "r1b",
      image_repository: "nexus/x", image_tag: "v1",
      image_id: null, image_digest: "sha256:aaa",
      container_name: "t1b-c", container_port: 8080,
    });

    const runOp = docker.calls.find((c) => c.kind === "run" && c.image === "nexus/x@sha256:aaa");

    check(
      "T1b digest deployment uses immutable image reference",
      !!runOp && r.deployment.status === "KNOWN_GOOD",
      "run_image=" + (runOp?.image ?? "missing") + " status=" + r.deployment.status
    );
  }
  // ---- T2: no immutable identity -> BLOCKED ----
  {
    const docker = mockDocker(() => undefined);
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t2", environment: "dev", release_id: "r2",
      image_repository: "nexus/x", image_tag: "v1", image_id: null, image_digest: null,
      container_name: "t2-c", container_port: 8080,
    });
    check("T2 no immutable identity -> BLOCKED", r.deployment.status === "BLOCKED", "status=" + r.deployment.status);
  }

  // ---- T3: docker run BLOCKED -> BLOCKED ----
  {
    const docker = mockDocker((op) => op.kind === "run" ? { status: "BLOCKED", blocked_reason: "host executor unavailable" } : undefined);
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t3", environment: "dev", release_id: "r3",
      image_repository: "nexus/x", image_tag: "v1", image_id: "sha256:aaa",
      container_name: "t3-c", container_port: 8080,
    });
    check("T3 docker run BLOCKED -> BLOCKED", r.deployment.status === "BLOCKED", "status=" + r.deployment.status);
  }

  // ---- T4: docker run non-zero exit -> FAILED ----
  {
    const docker = mockDocker((op) => op.kind === "run" ? { status: "FAILED", exit_code: 1, stderr: "boom" } : undefined);
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t4", environment: "dev", release_id: "r4",
      image_repository: "nexus/x", image_tag: "v1", image_id: "sha256:aaa",
      container_name: "t4-c", container_port: 8080,
    });
    check("T4 docker run non-zero -> FAILED", r.deployment.status === "FAILED", "status=" + r.deployment.status);
  }

  // ---- T5: docker inspect fails -> FAILED ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t5\n" };
      if (op.kind === "inspect") return { status: "FAILED", exit_code: 1, stderr: "no such container" };
      return undefined;
    });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t5", environment: "dev", release_id: "r5",
      image_repository: "nexus/x", image_tag: "v1", image_id: "sha256:aaa",
      container_name: "t5-c", container_port: 8080,
    });
    check("T5 docker inspect fails -> FAILED", r.deployment.status === "FAILED", "status=" + r.deployment.status);
  }

  // ---- T6: image id mismatch -> FAILED (+ rollback attempted, no previous -> BLOCKED) ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t6\n" };
      if (op.kind === "inspect" && op.image === "container-t6") return { stdout: JSON.stringify([{ Image: "sha256:other", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12345" }] } } }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t6", environment: "dev", release_id: "r6",
      image_repository: "nexus/x", image_tag: "v1", image_id: "sha256:aaa",
      container_name: "t6-c", container_port: 8080,
    });
    check("T6 identity mismatch -> FAILED", r.deployment.status === "FAILED", "status=" + r.deployment.status);
    check("T6 rollback attempted (no previous KNOWN_GOOD -> BLOCKED)", r.rollback !== null && r.rollback.status === "BLOCKED", "rollback=" + (r.rollback?.status ?? "null"));
  }

  // ---- T7: no mapped port -> BLOCKED ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t7\n" };
      if (op.kind === "inspect" && op.image === "container-t7") return { stdout: JSON.stringify([{ Image: "sha256:aaa", NetworkSettings: { Ports: {} } }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t7", environment: "dev", release_id: "r7",
      image_repository: "nexus/x", image_tag: "v1", image_id: "sha256:aaa",
      container_name: "t7-c", container_port: 8080,
    });
    check("T7 no mapped port -> BLOCKED", r.deployment.status === "BLOCKED", "status=" + r.deployment.status);
  }

  // ---- T8: health fails -> FAILED + rollback attempted ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t8\n" };
      if (op.kind === "inspect" && op.image === "container-t8") return { stdout: JSON.stringify([{ Image: "sha256:aaa", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12345" }] } } }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => failSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t8", environment: "dev", release_id: "r8",
      image_repository: "nexus/x", image_tag: "v1", image_id: "sha256:aaa",
      container_name: "t8-c", container_port: 8080,
    });
    check("T8 health/smoke fail -> FAILED + rollback attempted", r.deployment.status === "FAILED" && r.rollback !== null, "status=" + r.deployment.status + " rollback=" + (r.rollback?.status ?? "null"));
  }

  // ---- T9: smoke fails (health passes) -> FAILED + rollback attempted ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t9\n" };
      if (op.kind === "inspect" && op.image === "container-t9") return { stdout: JSON.stringify([{ Image: "sha256:aaa", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12345" }] } } }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => ({ health: { ok: true, error: null, status_code: 200 }, smoke: { status: "FAILED" }, verdict: "FAIL" }));
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t9", environment: "dev", release_id: "r9",
      image_repository: "nexus/x", image_tag: "v1", image_id: "sha256:aaa",
      container_name: "t9-c", container_port: 8080,
    });
    check("T9 smoke fail -> FAILED + rollback attempted", r.deployment.status === "FAILED" && r.rollback !== null, "status=" + r.deployment.status + " rollback=" + (r.rollback?.status ?? "null"));
  }

  // ---- T10 + T11: all pass -> KNOWN_GOOD + persisted ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t10\n" };
      if (op.kind === "inspect" && op.image === "container-t10") return { stdout: JSON.stringify([{ Image: "sha256:aaa", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12345" }] } } }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t10", environment: "prod", release_id: "r10",
      image_repository: "nexus/app", image_tag: "v2", image_id: "sha256:aaa",
      container_name: "t10-c", container_port: 8080,
    });
    check("T10 identity+health+smoke PASS -> KNOWN_GOOD verified", r.deployment.status === "KNOWN_GOOD" && r.deployment.verified === true, "status=" + r.deployment.status + " verified=" + r.deployment.verified);

    const persisted = await history.getDeployment(r.deployment.id);
    check("T11 KNOWN_GOOD persisted in DeploymentHistoryService", !!persisted && persisted.status === "KNOWN_GOOD", "persisted=" + (persisted?.status ?? "null"));
  }

  // ---- T12: full rollback restores previous KNOWN_GOOD ----
  {
    // Pre-seed a KNOWN_GOOD deployment.
    const known = await history.createDeployment({
      project_id: "t12", environment: "prod", release_id: "rel-prev",
      image_repository: "nexus/app", image_tag: "v1", image_id: "sha256:previous",
      container_name: "t12-c",
    });
    await history.markKnownGood(known.id);

    // Mock docker: differentiate new vs rollback by counting run calls.
    let runCount = 0;
    const docker = mockDocker((op) => {
      if (op.kind === "run") {
        runCount++;
        if (runCount === 1) return { stdout: "container-new\n" };
        return { stdout: "container-rollback\n" };
      }
      if (op.kind === "inspect") {
        if (op.image === "container-new") return { stdout: JSON.stringify([{ Image: "sha256:new", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12345" }] } } }]) };
        if (op.image === "sha256:previous") return { stdout: JSON.stringify([{ Id: "sha256:previous" }]) };
        if (op.image === "container-rollback") return { stdout: JSON.stringify([{ Image: "sha256:previous", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12346" }] } } }]) };
      }
      return undefined;
    });

    // Smoke script: fail for the new deployment, pass for the rollback.
    const smoke = mockSmoke((input: any) => {
      if (String(input.staging_url).includes(":12345")) return failSmoke();
      return okSmoke();
    });

    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t12", environment: "prod", release_id: "rel-new",
      image_repository: "nexus/app", image_tag: "v2", image_id: "sha256:new",
      container_name: "t12-c", container_port: 8080,
    });

    check("T12 rollback VERIFIED", r.rollback !== null && r.rollback.status === "VERIFIED", "rollback=" + (r.rollback?.status ?? "null") + " reason=" + (r.rollback?.reason ?? ""));

    const rbDeploy = r.rollback?.rollback_deployment_id ? await history.getDeployment(r.rollback.rollback_deployment_id) : null;
    check("T12 rollback deployment persisted with is_rollback=true", !!rbDeploy && rbDeploy.is_rollback === true, "is_rollback=" + (rbDeploy?.is_rollback ?? "null"));

    // T13: rollback must never issue a docker build
    const buildCalls = docker.calls.filter((c) => c.kind === "build");
    check("T13 rollback never rebuilds an image (no docker build op)", buildCalls.length === 0, "build calls=" + buildCalls.length);
  }

  console.log("\nPASS: " + pass + "  FAIL: " + fail);
  process.exit(fail === 0 ? 0 : 1);
}

await main();

export function run() { /* wrapper compat */ }
