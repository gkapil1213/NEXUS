// scripts/run-canonical-deployment-tests.ts
//
// Focused tests for CanonicalDeploymentOrchestrator. Mock Docker + mock
// SmokeTestService are scripted; the DeploymentHistoryService runs against
// the real NexusEngine, so persistence is exercised for real.

import { openEngine } from "../src/core/db";
import { DeploymentHistoryService } from "../src/core/deployment-history";
import { CanonicalDeploymentOrchestrator } from "../src/core/deployment-orchestrator";
import type { DockerAdapter, DockerOp, DockerResult, SmokeTestService } from "../src/core/runtime";
import { ReleaseDeploymentBridge } from "../src/core/deployment-release-bridge";
import { ProductionReleaseEnforcementService } from "../src/core/production-release-enforcement";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { ReleaseRecoveryService } from "../src/core/release-recovery";

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


  // ---- T14: health BLOCKED -> BLOCKED (never KNOWN_GOOD) ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t14\n" };
      if (op.kind === "inspect" && op.image === "container-t14") return { stdout: JSON.stringify([{ Image: "sha256:aaa", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12345" }] } } }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => ({ health: { ok: false, error: "ECONNREFUSED", status_code: null }, smoke: { status: "BLOCKED" }, verdict: "BLOCKED" }));
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t14", environment: "dev", release_id: "r14",
      image_repository: "nexus/x", image_tag: "v1", image_id: "sha256:aaa",
      container_name: "t14-c", container_port: 8080,
    });
    check("T14 health BLOCKED cannot produce KNOWN_GOOD", r.deployment.status === "BLOCKED", "status=" + r.deployment.status);
  }

  // ---- T15: smoke BLOCKED -> BLOCKED (never KNOWN_GOOD) ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t15\n" };
      if (op.kind === "inspect" && op.image === "container-t15") return { stdout: JSON.stringify([{ Image: "sha256:aaa", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12345" }] } } }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => ({ health: { ok: true, error: null, status_code: 200 }, smoke: { status: "BLOCKED" }, verdict: "BLOCKED" }));
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t15", environment: "dev", release_id: "r15",
      image_repository: "nexus/x", image_tag: "v1", image_id: "sha256:aaa",
      container_name: "t15-c", container_port: 8080,
    });
    check("T15 smoke BLOCKED cannot produce KNOWN_GOOD", r.deployment.status === "BLOCKED", "status=" + r.deployment.status);
  }

  // ---- T16: docker inspect BLOCKED -> BLOCKED (distinct from FAILED) ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t16\n" };
      if (op.kind === "inspect" && op.image === "container-t16") return { status: "BLOCKED", blocked_reason: "host executor unavailable" };
      return undefined;
    });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t16", environment: "dev", release_id: "r16",
      image_repository: "nexus/x", image_tag: "v1", image_id: "sha256:aaa",
      container_name: "t16-c", container_port: 8080,
    });
    check("T16 docker inspect BLOCKED -> BLOCKED (not FAILED)", r.deployment.status === "BLOCKED", "status=" + r.deployment.status);
  }

  // ---- T17: docker run BLOCKED emits deployment.blocked event ----
  {
    const events: string[] = [];
    const svcSpy = { events: { emit: async (e: any) => { events.push(e.type); } }, audit: { record: async () => {} } } as any;
    const docker = mockDocker((op) => op.kind === "run" ? { status: "BLOCKED", blocked_reason: "host executor unavailable" } : undefined);
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, svcSpy);
    await orch.deploy({
      project_id: "t17", environment: "dev", release_id: "r17",
      image_repository: "nexus/x", image_tag: "v1", image_id: "sha256:aaa",
      container_name: "t17-c", container_port: 8080,
    });
    check("T17 docker run BLOCKED emits deployment.blocked", events.includes("deployment.blocked"), "events=" + events.join(","));
  }

  // ---- T18: failed deployment does not overwrite previous KNOWN_GOOD ----
  {
    const known = await history.createDeployment({
      project_id: "t18", environment: "prod", release_id: "rel-prev",
      image_repository: "nexus/app", image_tag: "v1", image_id: "sha256:old",
      container_name: "t18-c",
    });
    await history.markKnownGood(known.id);

    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t18\n" };
      if (op.kind === "inspect" && op.image === "container-t18") return { stdout: JSON.stringify([{ Image: "sha256:new", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12345" }] } } }]) };
      if (op.kind === "inspect" && op.image === "sha256:old") return { stdout: JSON.stringify([{ Id: "sha256:old" }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => failSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    await orch.deploy({
      project_id: "t18", environment: "prod", release_id: "rel-new",
      image_repository: "nexus/app", image_tag: "v2", image_id: "sha256:new",
      container_name: "t18-c", container_port: 8080,
    });

    const stillKnown = await history.getDeployment(known.id);
    check("T18 failed deployment does not overwrite previous KNOWN_GOOD",
      stillKnown !== null && stillKnown.status === "KNOWN_GOOD",
      "prev_status=" + (stillKnown?.status ?? "null"));
  }

  // ---- T19: quality BLOCKED (defensive) cannot produce KNOWN_GOOD ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t19\n" };
      if (op.kind === "inspect" && op.image === "container-t19") return { stdout: JSON.stringify([{ Image: "sha256:aaa", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12345" }] } } }]) };
      return undefined;
    });
    // Deliberately inconsistent smoke service output: health PASS, smoke PASS, verdict BLOCKED
    const smoke = mockSmoke(() => ({ health: { ok: true, error: null, status_code: 200 }, smoke: { status: "PASSED" }, verdict: "BLOCKED" }));
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t19", environment: "dev", release_id: "r19",
      image_repository: "nexus/x", image_tag: "v1", image_id: "sha256:aaa",
      container_name: "t19-c", container_port: 8080,
    });
    check("T19 quality BLOCKED cannot produce KNOWN_GOOD", r.deployment.status === "BLOCKED", "status=" + r.deployment.status);
  }


  // ---- T27: KNOWN_GOOD persists release_id + artifact_id ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t27\n" };
      if (op.kind === "inspect" && op.image === "container-t27") return { stdout: JSON.stringify([{ Image: "sha256:t27", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12350" }] } } }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t27", environment: "prod", release_id: "rel-t27",
      artifact_id: "art-t27", execution_id: "exec-t27",
      image_repository: "nexus/t27", image_tag: "v1", image_id: "sha256:t27",
      container_name: "t27-c", container_port: 8080,
    });
    const persisted = await history.getDeployment(r.deployment.id);
    check(
      "T27 KNOWN_GOOD persists release_id + artifact_id",
      r.deployment.status === "KNOWN_GOOD" && !!persisted
        && persisted!.release_id === "rel-t27"
        && persisted!.artifact_id === "art-t27",
      "status=" + r.deployment.status + " release=" + (persisted?.release_id ?? "null") + " artifact=" + (persisted?.artifact_id ?? "null")
    );
  }

  // ---- T30: rollback uses previous immutable image identity ----
  {
    const known = await history.createDeployment({
      project_id: "t30", environment: "prod", release_id: "rel-prev-t30",
      image_repository: "nexus/app", image_tag: "v1", image_id: "sha256:prev-t30",
      container_name: "t30-c",
    });
    await history.markKnownGood(known.id);
    // T30 timing guard: createDeployment uses Date.now() for started_at.
    // Without a gap, the pre-seeded KNOWN_GOOD and the new deployment can
    // share the same millisecond, and getPreviousKnownGood's strict
    // `started_at < current.started_at` filter returns null.
    await new Promise((r) => setTimeout(r, 10));

    let runCount = 0;
    const docker = mockDocker((op) => {
      if (op.kind === "run") {
        runCount++;
        if (runCount === 1) return { stdout: "container-t30-new\n" };
        return { stdout: "container-t30-rb\n" };
      }
      if (op.kind === "inspect") {
        if (op.image === "container-t30-new") return { stdout: JSON.stringify([{ Image: "sha256:new-t30", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12370" }] } } }]) };
        if (op.image === "sha256:prev-t30") return { stdout: JSON.stringify([{ Id: "sha256:prev-t30" }]) };
        if (op.image === "container-t30-rb") return { stdout: JSON.stringify([{ Image: "sha256:prev-t30", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12371" }] } } }]) };
      }
      return undefined;
    });
    const smoke = mockSmoke((input: any) => String(input.staging_url).includes(":12370") ? failSmoke() : okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const r = await orch.deploy({
      project_id: "t30", environment: "prod", release_id: "rel-new-t30",
      image_repository: "nexus/app", image_tag: "v2", image_id: "sha256:new-t30",
      container_name: "t30-c", container_port: 8080,
    });
    const rbRun = docker.calls.filter((c) => c.kind === "run")[1];
    const usedImmutable = rbRun !== undefined && String(rbRun.image).includes("sha256:prev-t30");
    check(
      "T30 rollback uses previous immutable image identity",
      r.rollback !== null && r.rollback.status === "VERIFIED"
        && r.rollback.restored_image_id === "sha256:prev-t30"
        && usedImmutable,
      "restored=" + (r.rollback?.restored_image_id ?? "null") + " used=" + (rbRun?.image ?? "null")
    );
  }

  // ---- T36: successful lifecycle preserves full lineage ----
  {
    const executionId = "exec-t36";
    const releaseId = "rel-t36";
    const artifactId = "art-t36";
    const imageDigest = "sha256:t36";
    const events: any[] = [];
    const svcSpy = { events: { emit: async (e: any) => { events.push(e); } }, audit: { record: async () => {} } } as any;

    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t36\n" };
      if (op.kind === "inspect" && op.image === "container-t36") return { stdout: JSON.stringify([{ Image: imageDigest, NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12360" }] } } }]) };
      if (op.kind === "inspect" && op.image === "nexus/t36@" + imageDigest) return { stdout: JSON.stringify([{ Id: imageDigest }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, svcSpy);
    const r = await orch.deploy({
      project_id: "t36", environment: "prod", release_id: releaseId,
      artifact_id: artifactId, execution_id: executionId,
      image_repository: "nexus/t36", image_tag: "v1",
      image_id: null, image_digest: imageDigest,
      container_name: "t36-c", container_port: 8080,
    });
    const persisted = await history.getDeployment(r.deployment.id);
    const imageOk = docker.calls.some((c) => c.kind === "run" && String(c.image) === "nexus/t36@" + imageDigest);
    const eventOk = events.some((e) => e.execution_id === executionId && e.type === "deployment.verified");
    check(
      "T36 successful lifecycle preserves full lineage",
      r.deployment.status === "KNOWN_GOOD" && !!persisted
        && persisted!.release_id === releaseId
        && persisted!.artifact_id === artifactId
        && persisted!.container_id === "container-t36"
        && imageOk && eventOk,
      "release=" + (persisted?.release_id ?? "null")
        + " artifact=" + (persisted?.artifact_id ?? "null")
        + " container=" + (persisted?.container_id ?? "null")
        + " image_ok=" + imageOk + " event_ok=" + eventOk
    );
  }

  // ---- T37: release enforcement BLOCKED prevents deployment ----
  {
    let bridgeCalls = 0;
    let dockerRunCalls = 0;
    const docker = mockDocker((op) => { if (op.kind === "run") dockerRunCalls++; return undefined; });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const bridge = new ReleaseDeploymentBridge({ deployments: orch, artifacts: { list: async () => [] } as any, svc: fakeSvc });
    const realExec = bridge.execute.bind(bridge);
    bridge.execute = async (r) => { bridgeCalls++; return realExec(r); };

    const decisionStub: any = {
      async decide(p: any) {
        return { status: "BLOCKED", releaseId: p.releaseId, artifactId: p.artifactId, artifactDigest: p.artifactDigest, securityStatus: "BLOCKED", riskScore: 0, policyStatus: "BLOCKED", approvalStatus: "PENDING", blockers: ["security gate BLOCKED"], warnings: [] };
      }
    };
    const enforcement = new ProductionReleaseEnforcementService({} as any, {} as any, decisionStub, bridge);
    const approval: any = { releaseId: "rel-t37", artifactId: "art-t37", artifactDigest: "sha256:t37", environment: "production", approver: "owner", approvedAt: new Date().toISOString(), status: "APPROVED" };
    const res = await enforcement.requestRelease({
      releaseId: "rel-t37", executionId: "exec-t37", artifactId: "art-t37",
      artifactDigest: "sha256:t37", commitSha: "c-t37", environment: "production",
      approval,
      projectId: "proj-t37", imageRepository: "nexus/t37", imageTag: "v1", imageId: "sha256:t37",
      containerName: "t37-c", containerPort: 8080,
    });
    check(
      "T37 release enforcement BLOCKED prevents deployment",
      res.status === "BLOCKED" && bridgeCalls === 0 && dockerRunCalls === 0,
      "status=" + res.status + " bridge=" + bridgeCalls + " docker_run=" + dockerRunCalls,
    );
  }

  // ---- T38: release enforcement FAIL prevents deployment ----
  {
    let bridgeCalls = 0;
    let dockerRunCalls = 0;
    const docker = mockDocker((op) => { if (op.kind === "run") dockerRunCalls++; return undefined; });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const bridge = new ReleaseDeploymentBridge({ deployments: orch, artifacts: { list: async () => [] } as any, svc: fakeSvc });
    const realExec = bridge.execute.bind(bridge);
    bridge.execute = async (r) => { bridgeCalls++; return realExec(r); };

    const decisionStub: any = {
      async decide(p: any) {
        return { status: "FAIL", releaseId: p.releaseId, artifactId: p.artifactId, artifactDigest: p.artifactDigest, securityStatus: "FAIL", riskScore: 100, policyStatus: "FAIL", approvalStatus: "APPROVED", blockers: ["security scan failed"], warnings: [] };
      }
    };
    const enforcement = new ProductionReleaseEnforcementService({} as any, {} as any, decisionStub, bridge);
    const approval: any = { releaseId: "rel-t38", artifactId: "art-t38", artifactDigest: "sha256:t38", environment: "production", approver: "owner", approvedAt: new Date().toISOString(), status: "APPROVED" };
    const res = await enforcement.requestRelease({
      releaseId: "rel-t38", executionId: "exec-t38", artifactId: "art-t38",
      artifactDigest: "sha256:t38", commitSha: "c-t38", environment: "production",
      approval,
      projectId: "proj-t38", imageRepository: "nexus/t38", imageTag: "v1", imageId: "sha256:t38",
      containerName: "t38-c", containerPort: 8080,
    });
    check(
      "T38 release enforcement FAIL prevents deployment",
      res.status === "FAIL" && bridgeCalls === 0 && dockerRunCalls === 0,
      "status=" + res.status + " bridge=" + bridgeCalls + " docker_run=" + dockerRunCalls,
    );
  }

  // ---- T39: release enforcement ALLOW -> bridge -> canonical deployment -> KNOWN_GOOD ----
  {
    let dockerRunCalls = 0;
    const docker = mockDocker((op) => {
      if (op.kind === "run") { dockerRunCalls++; return { stdout: "container-t39\n" }; }
      if (op.kind === "inspect" && op.image === "container-t39") return { stdout: JSON.stringify([{ Image: "sha256:t39", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12400" }] } } }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);

    const artifactsStub: any = {
      async list(execId: string) {
        if (execId === "exec-t39") {
          return [{ id: "art-t39", execution_id: "exec-t39", kind: "DOCKER_IMAGE", name: "t39", digest: "sha256:t39", size: 0, location: "artifact://art-t39", created_at: Date.now() }];
        }
        return [];
      }
    };
    const bridge = new ReleaseDeploymentBridge({ deployments: orch, artifacts: artifactsStub, svc: fakeSvc });
    let bridgeCalls = 0;
    const realExec = bridge.execute.bind(bridge);
    bridge.execute = async (r) => { bridgeCalls++; return realExec(r); };

    const decisionStub: any = {
      async decide(p: any) {
        return { status: "ALLOW", releaseId: p.releaseId, artifactId: p.artifactId, artifactDigest: p.artifactDigest, securityStatus: "PASS", riskScore: 0, policyStatus: "PASS", approvalStatus: "APPROVED", blockers: [], warnings: [] };
      }
    };
    const enforcement = new ProductionReleaseEnforcementService({} as any, {} as any, decisionStub, bridge);
    const approval: any = { releaseId: "rel-t39", artifactId: "art-t39", artifactDigest: "sha256:t39", environment: "production", approver: "owner", approvedAt: new Date().toISOString(), status: "APPROVED" };

    const reqRes = await enforcement.requestRelease({
      releaseId: "rel-t39", executionId: "exec-t39", artifactId: "art-t39",
      artifactDigest: "sha256:t39", commitSha: "c-t39", environment: "production",
      approval,
      projectId: "proj-t39", imageRepository: "nexus/t39", imageTag: "v1", imageId: "sha256:t39",
      containerName: "t39-c", containerPort: 8080,
    });
    check("T39a enforcement ALLOW issues authorization",
      reqRes.status === "AUTHORIZED" && !!reqRes.authorization,
      "status=" + reqRes.status);

    if (reqRes.authorization) {
      const auth = reqRes.authorization;
      const depRes = await enforcement.executeRelease(auth.authorizationId, auth.releaseId, auth.artifactId, auth.commitSha, auth.environment);
      const persisted = depRes.deploymentId ? await history.getDeployment(depRes.deploymentId) : null;
      check(
        "T39b enforcement ALLOW -> bridge -> canonical deployment -> KNOWN_GOOD",
        depRes.status === "DEPLOYED" && bridgeCalls === 1 && dockerRunCalls === 1
          && !!persisted && persisted.status === "KNOWN_GOOD"
          && persisted.release_id === "rel-t39" && persisted.artifact_id === "art-t39",
        "dep=" + depRes.status + " bridge=" + bridgeCalls + " docker=" + dockerRunCalls
          + " persisted=" + (persisted?.status ?? "null")
          + " release=" + (persisted?.release_id ?? "null")
          + " artifact=" + (persisted?.artifact_id ?? "null"),
      );
    }
  }

  // ---- T40: bridge artifact mismatch -> BLOCKED, deploy not called ----
  {
    let dockerRunCalls = 0;
    const docker = mockDocker((op) => { if (op.kind === "run") dockerRunCalls++; return undefined; });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);

    const artifactsStub: any = {
      async list() {
        return [{ id: "art-t40", execution_id: "exec-t40", kind: "DOCKER_IMAGE", name: "t40", digest: "sha256:DIFFERENT", size: 0, location: "artifact://art-t40", created_at: Date.now() }];
      }
    };
    const bridge = new ReleaseDeploymentBridge({ deployments: orch, artifacts: artifactsStub, svc: fakeSvc });
    const res = await bridge.execute({
      authorizationId: "auth-t40", releaseId: "rel-t40", artifactId: "art-t40",
      commitSha: "c-t40", environment: "production",
      projectId: "proj-t40", executionId: "exec-t40",
      imageRepository: "nexus/t40", imageTag: "v1", imageId: "sha256:t40",
      imageDigest: "sha256:t40",
      containerName: "t40-c", containerPort: 8080,
    });
    check(
      "T40 bridge artifact mismatch -> BLOCKED, deploy not called",
      res.status === "BLOCKED" && dockerRunCalls === 0,
      "status=" + res.status + " docker=" + dockerRunCalls + " msg=" + res.message.slice(0, 60),
    );
  }

  // ---- T41: bridge preserves immutable digest to orchestrator ----
  {
    const seen: any[] = [];
    const docker = mockDocker((op) => {
      seen.push(op);
      if (op.kind === "run") return { stdout: "container-t41\n" };
      if (op.kind === "inspect" && op.image === "container-t41") return { stdout: JSON.stringify([{ Image: "sha256:t41", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12410" }] } } }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);

    const artifactsStub: any = {
      async list() {
        return [{ id: "art-t41", execution_id: "exec-t41", kind: "DOCKER_IMAGE", name: "t41", digest: "sha256:t41", size: 0, location: "artifact://art-t41", created_at: Date.now() }];
      }
    };
    const bridge = new ReleaseDeploymentBridge({ deployments: orch, artifacts: artifactsStub, svc: fakeSvc });
    const res = await bridge.execute({
      authorizationId: "auth-t41", releaseId: "rel-t41", artifactId: "art-t41",
      commitSha: "c-t41", environment: "production",
      projectId: "proj-t41", executionId: "exec-t41",
      imageRepository: "nexus/t41", imageTag: "v1", imageId: "sha256:t41",
      imageDigest: "sha256:t41",
      containerName: "t41-c", containerPort: 8080,
    });
    const runOp = seen.find((o) => o.kind === "run");
    const used = runOp ? runOp.image : null;
    check(
      "T41 bridge preserves immutable digest to orchestrator",
      res.status === "DEPLOYED" && used === "nexus/t41@sha256:t41",
      "status=" + res.status + " used=" + used,
    );
  }

  // ---- T42: bridge preserves full lineage ----
  {
    const docker = mockDocker((op) => {
      if (op.kind === "run") return { stdout: "container-t42\n" };
      if (op.kind === "inspect" && op.image === "container-t42") return { stdout: JSON.stringify([{ Image: "sha256:t42", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12420" }] } } }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);

    const artifactsStub: any = {
      async list() {
        return [{ id: "art-t42", execution_id: "exec-t42", kind: "DOCKER_IMAGE", name: "t42", digest: "sha256:t42", size: 0, location: "artifact://art-t42", created_at: Date.now() }];
      }
    };
    const bridge = new ReleaseDeploymentBridge({ deployments: orch, artifacts: artifactsStub, svc: fakeSvc });
    const res = await bridge.execute({
      authorizationId: "auth-t42", releaseId: "rel-t42", artifactId: "art-t42",
      commitSha: "commit-t42", environment: "production",
      projectId: "proj-t42", executionId: "exec-t42",
      imageRepository: "nexus/t42", imageTag: "v1", imageId: "sha256:t42",
      imageDigest: "sha256:t42",
      containerName: "t42-c", containerPort: 8080,
    });
    const persisted = res.deploymentId ? await history.getDeployment(res.deploymentId) : null;
    check(
      "T42 bridge preserves full lineage",
      res.status === "DEPLOYED"
        && !!persisted
        && persisted.release_id === "rel-t42"
        && persisted.artifact_id === "art-t42"
        && persisted.container_id === "container-t42"
        && persisted.image_digest === "sha256:t42",
      "status=" + res.status
        + " release=" + (persisted?.release_id ?? "null")
        + " artifact=" + (persisted?.artifact_id ?? "null")
        + " container=" + (persisted?.container_id ?? "null")
        + " digest=" + (persisted?.image_digest ?? "null"),
    );
  }
  // ============================ Phase 103 ============================
  const rawDb = (engine as any).getDatabase?.();
  const execStore = rawDb ? new ExecutionStore(rawDb) : null;
  const intents = execStore ? new ReleaseDeploymentIntentService(execStore) : null;
  const recovery = new ReleaseRecoveryService();

  if (!intents) {
    console.log("[SKIPPED] Phase 103 tests — engine.getDatabase() unavailable");
  } else {

  const artifactStub = (id, execId, digest) => ({
    async list(execution_id) {
      if (execution_id !== execId) return [];
      return [{ id, execution_id: execId, kind: "DOCKER_IMAGE", name: id, digest, size: 0, location: "artifact://" + id, created_at: Date.now() }];
    }
  });

  const baseReq = (tag, artifactId, digest) => ({
    authorizationId: "auth-" + tag, releaseId: "rel-" + tag, artifactId,
    commitSha: "c-" + tag, environment: "production", projectId: "proj-" + tag,
    executionId: "exec-" + tag, imageRepository: "nexus/" + tag, imageTag: "v1",
    imageId: "sha256:" + tag, imageDigest: digest, containerName: tag + "-c", containerPort: 8080,
  });

  {
    const t43Suffix = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); const input = { releaseId: "rel-t43-" + t43Suffix, executionId: "exec-t43-" + t43Suffix, artifactId: "art-t43-" + t43Suffix, artifactDigest: "sha256:t43-" + t43Suffix, commitSha: "c-t43-" + t43Suffix, environment: "production", imageRepository: "nexus/t43-" + t43Suffix, imageTag: "v1", imageId: null, imageDigest: "sha256:t43-" + t43Suffix, containerName: "t43-c-" + t43Suffix, containerPort: 8080 };
    const r1 = await intents.getOrCreate(input);
    const r2 = await intents.getOrCreate(input);
    check("T43 durable intent created with deterministic key", r1.created === true && r2.created === false && r1.intent.intentKey === r2.intent.intentKey, "created1=" + r1.created + " created2=" + r2.created);
  }

  {
    const n44 = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    const execId44 = "exec-t44-" + n44;
    const artifactId44 = "art-t44-" + n44;
    const containerName44 = "container-t44-" + n44;
    let dockerRuns = 0;
    const docker = mockDocker((op) => {
      if (op.kind === "run") { dockerRuns++; return { stdout: containerName44 + "\n" }; }
      if (op.kind === "inspect" && op.image === containerName44) return { stdout: JSON.stringify([{ Image: "sha256:t44", NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12500" }] } } }]) };
      return undefined;
    });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const bridge = new ReleaseDeploymentBridge({ deployments: orch, artifacts: artifactStub(artifactId44, execId44, "sha256:t44"), svc: fakeSvc, intents });
    const req = {
      authorizationId: "auth-t44-" + n44, releaseId: "rel-t44-" + n44, artifactId: artifactId44,
      commitSha: "c-t44-" + n44, environment: "production", projectId: "proj-t44-" + n44,
      executionId: execId44, imageRepository: "nexus/t44", imageTag: "v1",
      imageId: "sha256:t44", imageDigest: "sha256:t44", containerName: containerName44, containerPort: 8080,
    };
    const first = await bridge.execute(req);
    const runsAfterFirst = dockerRuns;
    const second = await bridge.execute(req);
    check("T44 duplicate intent does not deploy twice", runsAfterFirst === 1 && second.status === first.status && dockerRuns === runsAfterFirst, "first=" + first.status + " runs1=" + runsAfterFirst + " second=" + second.status + " runs2=" + dockerRuns);
  }

  {
    const input = { releaseId: "rel-t45", executionId: "exec-t45", artifactId: "art-t45", artifactDigest: "sha256:t45", commitSha: "c-t45", environment: "production", imageRepository: "nexus/t45", imageTag: "v1", imageId: "sha256:t45", imageDigest: "sha256:t45", containerName: "t45-c", containerPort: 8080 };
    const { intent } = await intents.getOrCreate(input);
    intents.transition(intent.intentKey, "KNOWN_GOOD", { deploymentId: "dep-prior-t45" });
    let dockerRuns = 0;
    const docker = mockDocker((op) => { if (op.kind === "run") dockerRuns++; return undefined; });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const bridge = new ReleaseDeploymentBridge({ deployments: orch, artifacts: artifactStub("art-t45", "exec-t45", "sha256:t45"), svc: fakeSvc, intents });
    const res = await bridge.execute(baseReq("t45", "art-t45", "sha256:t45"));
    check("T45 existing KNOWN_GOOD returned idempotently without Docker", res.status === "DEPLOYED" && res.deploymentId === "dep-prior-t45" && dockerRuns === 0, "status=" + res.status + " docker=" + dockerRuns);
  }

  {
    const input = { releaseId: "rel-t49", executionId: "exec-t49", artifactId: "art-t49", artifactDigest: "sha256:t49", commitSha: "c-t49", environment: "production", imageRepository: "nexus/t49", imageTag: "v1", imageId: "sha256:t49", imageDigest: "sha256:t49", containerName: "t49-c", containerPort: 8080 };
    const { intent } = await intents.getOrCreate(input);
    intents.transition(intent.intentKey, "DEPLOYING");
    let dockerRuns = 0;
    const docker = mockDocker((op) => { if (op.kind === "run") dockerRuns++; return undefined; });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const bridge = new ReleaseDeploymentBridge({ deployments: orch, artifacts: artifactStub("art-t49", "exec-t49", "sha256:t49"), svc: fakeSvc, intents });
    const res = await bridge.execute(baseReq("t49", "art-t49", "sha256:t49"));
    check("T49 crash during DEPLOYING enters recovery path", res.status === "BLOCKED" && dockerRuns === 0 && /RECOVERY_REQUIRED/.test(res.message), "status=" + res.status + " docker=" + dockerRuns);
  }

  {
    const input = { releaseId: "rel-t52", executionId: "exec-t52", artifactId: "art-t52", artifactDigest: "sha256:t52", commitSha: "c-t52", environment: "production", imageRepository: "nexus/t52", imageTag: "v1", imageId: "sha256:t52", imageDigest: "sha256:t52", containerName: "t52-c", containerPort: 8080 };
    const { intent } = await intents.getOrCreate(input);
    const first = intents.acquireLease(intent.intentKey, "worker-A");
    const second = intents.acquireLease(intent.intentKey, "worker-B");
    let dockerRuns = 0;
    const docker = mockDocker((op) => { if (op.kind === "run") dockerRuns++; return undefined; });
    const smoke = mockSmoke(() => okSmoke());
    const orch = new CanonicalDeploymentOrchestrator(history, docker, smoke, fakeSvc);
    const bridge = new ReleaseDeploymentBridge({ deployments: orch, artifacts: artifactStub("art-t52", "exec-t52", "sha256:t52"), svc: fakeSvc, intents, workerId: "worker-B" });
    const res = await bridge.execute(baseReq("t52", "art-t52", "sha256:t52"));
    check("T52 lease prevents concurrent deployment", first.acquired === true && second.acquired === false && res.status === "BLOCKED" && dockerRuns === 0, "first=" + first.acquired + " second=" + second.acquired + " res=" + res.status);
  }

  {
    const n53 = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6); const input = { releaseId: "rel-t53-" + n53, executionId: "exec-t53-" + n53, artifactId: "art-t53-" + n53, artifactDigest: "sha256:t53-" + n53, commitSha: "c-t53-" + n53, environment: "production", imageRepository: "nexus/t53", imageTag: "v1", imageId: "sha256:t53", imageDigest: "sha256:t53", containerName: "t53-c-" + n53, containerPort: 8080 };
    const { intent } = await intents.getOrCreate(input);
    const shortLease = intents.acquireLease(intent.intentKey, "worker-old", 1);
    await new Promise((r) => setTimeout(r, 15));
    const reacquire = intents.acquireLease(intent.intentKey, "worker-new", 60000);
    const after = intents.get(intent.intentKey);
    check("T53 expired lease permits re-acquire", shortLease.acquired === true && reacquire.acquired === true && after?.status === "DEPLOYMENT_INTENT_CREATED", "old=" + shortLease.acquired + " new=" + reacquire.acquired + " status=" + (after?.status ?? "null"));
  }

  {
    const i = { intentKey: "k54", status: "DEPLOYING", releaseId: "r", executionId: "e", artifactId: "a", artifactDigest: "d", imageRepository: "i", imageTag: "v", imageDigest: "id", containerName: "c", containerPort: 80, commitSha: "cs", environment: "prod" };
    const p = recovery.classify({ intent: i });
    check("T54 DEPLOYING requires Docker inspection", p.action === "RECOVERY_REQUIRED" && p.requiresDockerInspection === true, "action=" + p.action);
  }
  {
    const i = { intentKey: "k55", status: "HEALTH_CHECKING", deploymentId: "dep-x", releaseId: "r", executionId: "e", artifactId: "a", artifactDigest: "d", imageRepository: "i", imageTag: "v", imageDigest: "id", containerName: "c", containerPort: 80, commitSha: "cs", environment: "prod" };
    const p = recovery.classify({ intent: i });
    check("T55 HEALTH_CHECKING resumes verification", p.action === "RESUME_VERIFICATION" && p.requiresDockerInspection === true, "action=" + p.action);
  }
  {
    const i = { intentKey: "k56", status: "ROLLING_BACK", releaseId: "r", executionId: "e", artifactId: "a", artifactDigest: "d", imageRepository: "i", imageTag: "v", imageDigest: "id", containerName: "c", containerPort: 80, commitSha: "cs", environment: "prod" };
    const p = recovery.classify({ intent: i });
    check("T56 ROLLING_BACK resumes rollback", p.action === "RESUME_ROLLBACK" && p.requiresDockerInspection === true, "action=" + p.action);
  }
  {
    const i = { intentKey: "k58", status: "KNOWN_GOOD", releaseId: "r", executionId: "e", artifactId: "a", artifactDigest: "d", imageRepository: "i", imageTag: "v", imageDigest: "id", containerName: "c", containerPort: 80, commitSha: "cs", environment: "prod" };
    const p = recovery.classify({ intent: i });
    check("T58 KNOWN_GOOD is terminal", p.action === "ALREADY_KNOWN_GOOD" && p.requiresDockerInspection === false, "action=" + p.action);
  }
  {
    const i = { intentKey: "k59", status: "BLOCKED", releaseId: "r", executionId: "e", artifactId: "a", artifactDigest: "d", imageRepository: "i", imageTag: "v", imageDigest: "id", containerName: "c", containerPort: 80, commitSha: "cs", environment: "prod" };
    const p = recovery.classify({ intent: i });
    check("T59 BLOCKED is terminal", p.action === "ALREADY_BLOCKED" && p.requiresDockerInspection === false, "action=" + p.action);
  }

  }


  console.log("\nPASS: " + pass + "  FAIL: " + fail);
  process.exit(fail === 0 ? 0 : 1);
}

await main();

export function run() { /* wrapper compat */ }
