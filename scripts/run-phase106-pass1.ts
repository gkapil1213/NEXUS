// scripts/run-phase106-pass1.ts
// Phase 106: production container registry publication — deterministic tests.
//
// Every test uses a fake DockerAdapter at the HTTP boundary. No live registry
// call. The live capability probe at the end reports BLOCKED honestly when
// credentials are absent.

import { DockerRegistryProvider, extractRepoDigest } from "../src/core/container-registry-provider";
import type { DockerAdapter, DockerOp, DockerResult } from "../src/core/runtime";
import type { ImageReference } from "../src/core/types";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  Evidence: " + detail : "")); }
  else { fail++; console.log("[FAILED] " + name + (detail ? "  Evidence: " + detail : "")); }
}

interface Track { calls: DockerOp[] }
function fakeDocker(handler: (op: DockerOp) => Partial<DockerResult> | undefined): DockerAdapter & Track {
  const calls: DockerOp[] = [];
  return {
    calls,
    async run(op: DockerOp): Promise<DockerResult> {
      calls.push(op);
      const over = handler(op) ?? {};
      return {
        status: "SUCCEEDED", command: "docker " + op.kind, exit_code: 0,
        stdout: "", stderr: "", duration_ms: 1, blocked_reason: null,
        ...over,
      };
    },
  } as unknown as DockerAdapter & Track;
}

function fakeFetch(status: number, throwErr?: Error): typeof fetch {
  return (async () => {
    if (throwErr) throw throwErr;
    return new Response(null, { status });
  }) as unknown as typeof fetch;
}

const originalEnv = { ...process.env };
// Snapshot of the true external registry env — never mutated by tests, used
// for the live-capability probe at the end of the run.
const TRUE_REGISTRY_HOST = originalEnv.NEXUS_REGISTRY_HOST;
const TRUE_REGISTRY_TOKEN = originalEnv.NEXUS_REGISTRY_TOKEN;
function setEnv(k: string, v: string | null): void {
  if (v === null) delete process.env[k]; else process.env[k] = v;
}
function restoreEnv(): void {
  for (const k of ["NEXUS_REGISTRY_HOST", "NEXUS_REGISTRY_TOKEN", "NEXUS_REGISTRY_USERNAME"]) {
    if (k in originalEnv) process.env[k] = originalEnv[k]!; else delete process.env[k];
  }
}
const ref = (repository: string, tag: string): ImageReference => ({
  repository, tag, digest: null, full: repository + ":" + tag,
});

async function main(): Promise<void> {
  console.log("NEXUS PHASE 106 — CONTAINER REGISTRY PUBLICATION TESTS");
  console.log("=======================================================\n");

  // ----------------------------------------------------------
  // T01–T06 Contract + config
  // ----------------------------------------------------------
  {
    setEnv("NEXUS_REGISTRY_HOST", "ghcr.io");
    setEnv("NEXUS_REGISTRY_TOKEN", "ghp_fakebutvalidlengthvalue1234567890");
    const p = new DockerRegistryProvider(fakeDocker(() => undefined), fakeFetch(200));
    const auth = await p.authenticate();
    check("T01 provider implements ContainerRegistryProvider (authenticate ok with reachable registry)", auth.ok === true, JSON.stringify(auth));
  }
  {
    restoreEnv();
    setEnv("NEXUS_REGISTRY_HOST", null);
    setEnv("NEXUS_REGISTRY_TOKEN", null);
    const p = new DockerRegistryProvider(fakeDocker(() => undefined), fakeFetch(200));
    const auth = await p.authenticate();
    check("T02 missing configuration → BLOCKED", auth.ok === false && /BLOCKED/.test(auth.reason ?? ""), auth.reason ?? "");
  }
  {
    restoreEnv();
    setEnv("NEXUS_REGISTRY_HOST", "ghcr.io");
    setEnv("NEXUS_REGISTRY_TOKEN", null);
    const p = new DockerRegistryProvider(fakeDocker(() => undefined), fakeFetch(200));
    const auth = await p.authenticate();
    check("T03 missing token → BLOCKED", auth.ok === false && /BLOCKED/.test(auth.reason ?? ""), auth.reason ?? "");
  }
  {
    setEnv("NEXUS_REGISTRY_HOST", "not a valid host with spaces");
    setEnv("NEXUS_REGISTRY_TOKEN", "token1234567890");
    const p = new DockerRegistryProvider(fakeDocker(() => undefined), fakeFetch(200));
    const auth = await p.authenticate();
    check("T04 malformed host → BLOCKED", auth.ok === false && /BLOCKED/.test(auth.reason ?? ""), auth.reason ?? "");
  }
  {
    setEnv("NEXUS_REGISTRY_HOST", "ghcr.io");
    setEnv("NEXUS_REGISTRY_TOKEN", "tok");
    const p = new DockerRegistryProvider(fakeDocker(() => undefined), fakeFetch(401));
    const auth = await p.authenticate();
    check("T05 registry 401 → BLOCKED", auth.ok === false && /BLOCKED/.test(auth.reason ?? ""), auth.reason ?? "");
  }
  {
    setEnv("NEXUS_REGISTRY_HOST", "ghcr.io");
    setEnv("NEXUS_REGISTRY_TOKEN", "tok");
    const p = new DockerRegistryProvider(fakeDocker(() => undefined), fakeFetch(200, new Error("ECONNREFUSED")));
    const auth = await p.authenticate();
    check("T06 registry unreachable → BLOCKED", auth.ok === false && /BLOCKED/.test(auth.reason ?? ""), auth.reason ?? "");
  }

  // ----------------------------------------------------------
  // T07–T12 Push semantics
  // ----------------------------------------------------------
  {
    restoreEnv();
    setEnv("NEXUS_REGISTRY_HOST", "ghcr.io");
    setEnv("NEXUS_REGISTRY_TOKEN", "tok");
    const docker = fakeDocker(() => undefined);
    const p = new DockerRegistryProvider(docker, fakeFetch(200));
    const res = await p.push(ref("ghcr.io/nexus/app", "latest"));
    check("T07 latest rejected", res.ok === false && /latest/i.test(res.reason ?? ""), res.reason ?? "");
  }
  {
    restoreEnv();
    const p = new DockerRegistryProvider(fakeDocker(() => undefined), fakeFetch(200));
    const res = await p.push(ref("ghcr.io/nexus/app", "v1"));
    check("T08 push without config → BLOCKED", res.ok === false && /BLOCKED/.test(res.reason ?? ""), res.reason ?? "");
  }
  {
    setEnv("NEXUS_REGISTRY_HOST", "ghcr.io");
    setEnv("NEXUS_REGISTRY_TOKEN", "tok");
    const docker = fakeDocker((op) => op.kind === "push" ? { status: "SUCCEEDED", exit_code: 0 } : undefined);
    const p = new DockerRegistryProvider(docker, fakeFetch(200));
    const res = await p.push(ref("ghcr.io/nexus/app", "v1"));
    const pushCalls = docker.calls.filter((c) => c.kind === "push");
    check("T09 successful push uses exactly one docker push arg", res.ok === true && pushCalls.length === 1
      && (pushCalls[0] as { ref: string }).ref === "ghcr.io/nexus/app:v1", "calls=" + pushCalls.length);
  }
  {
    const docker = fakeDocker((op) => op.kind === "push" ? { status: "FAILED", exit_code: 1, stderr: "denied: access forbidden" } : undefined);
    const p = new DockerRegistryProvider(docker, fakeFetch(200));
    const res = await p.push(ref("ghcr.io/nexus/app", "v1"));
    check("T10 push failure not reported as success", res.ok === false && /denied|failed/i.test(res.reason ?? ""), res.reason ?? "");
  }
  {
    const docker = fakeDocker((op) => op.kind === "push" ? { status: "BLOCKED", blocked_reason: "docker daemon unavailable" } : undefined);
    const p = new DockerRegistryProvider(docker, fakeFetch(200));
    const res = await p.push(ref("ghcr.io/nexus/app", "v1"));
    check("T11 push BLOCKED surfaces blocked_reason", res.ok === false && /unavailable/.test(res.reason ?? ""), res.reason ?? "");
  }
  {
    const docker = fakeDocker(() => undefined);
    const p = new DockerRegistryProvider(docker, fakeFetch(200));
    const res = await p.push({ repository: "ghcr.io/nexus/app", tag: "", digest: null, full: "ghcr.io/nexus/app:" });
    check("T12 push with empty tag → BLOCKED", res.ok === false && /tag/i.test(res.reason ?? ""), res.reason ?? "");
  }

  // ----------------------------------------------------------
  // T13–T16 Immutable digest resolution
  // ----------------------------------------------------------
  {
    const SHA = "sha256:" + "a".repeat(64);
    const stdout = JSON.stringify([{ RepoDigests: ["ghcr.io/nexus/app@" + SHA] }]);
    const docker = fakeDocker((op) => op.kind === "inspect" ? { status: "SUCCEEDED", exit_code: 0, stdout } : undefined);
    const p = new DockerRegistryProvider(docker, fakeFetch(200));
    const pub = await p.resolvePublishedDigest(ref("ghcr.io/nexus/app", "v1"));
    check("T13 post-push inspect yields authoritative digest", pub.ok === true && pub.digest === SHA && pub.immutable_reference === "ghcr.io/nexus/app@" + SHA, JSON.stringify(pub));
  }
  {
    const docker = fakeDocker((op) => op.kind === "inspect" ? { status: "SUCCEEDED", exit_code: 0, stdout: JSON.stringify([{ RepoDigests: [] }]) } : undefined);
    const p = new DockerRegistryProvider(docker, fakeFetch(200));
    const pub = await p.resolvePublishedDigest(ref("ghcr.io/nexus/app", "v1"));
    check("T14 empty RepoDigests → BLOCKED", pub.ok === false && /BLOCKED/.test(pub.reason ?? ""), pub.reason ?? "");
  }
  {
    const docker = fakeDocker((op) => op.kind === "inspect" ? { status: "SUCCEEDED", exit_code: 0, stdout: JSON.stringify([{ RepoDigests: ["ghcr.io/nexus/app@sha256:not-a-valid-digest"] }]) } : undefined);
    const p = new DockerRegistryProvider(docker, fakeFetch(200));
    const pub = await p.resolvePublishedDigest(ref("ghcr.io/nexus/app", "v1"));
    check("T15 malformed digest → BLOCKED", pub.ok === false && /BLOCKED/.test(pub.reason ?? ""), pub.reason ?? "");
  }
  {
    const docker = fakeDocker((op) => op.kind === "inspect" ? { status: "FAILED", exit_code: 1, stderr: "no such image" } : undefined);
    const p = new DockerRegistryProvider(docker, fakeFetch(200));
    const pub = await p.resolvePublishedDigest(ref("ghcr.io/nexus/app", "v1"));
    check("T16 inspect failure → BLOCKED", pub.ok === false && /BLOCKED/.test(pub.reason ?? ""), pub.reason ?? "");
  }

  // ----------------------------------------------------------
  // T17–T18 Pull/Delete honestly BLOCKED
  // ----------------------------------------------------------
  {
    const p = new DockerRegistryProvider(fakeDocker(() => undefined), fakeFetch(200));
    const pull = await p.pull(ref("ghcr.io/nexus/app", "v1"));
    const del = await p.delete(ref("ghcr.io/nexus/app", "v1"));
    check("T17 pull/delete are honestly BLOCKED in this pass",
      pull.ok === false && /BLOCKED/.test(pull.reason ?? "") && del.ok === false && /BLOCKED/.test(del.reason ?? ""),
      "pull=" + pull.reason + " delete=" + del.reason);
  }

  // ----------------------------------------------------------
  // T18–T22 Security
  // ----------------------------------------------------------
  {
    const res = await new DockerRegistryProvider(fakeDocker(() => undefined), fakeFetch(200))
      .push(ref("ghcr.io/nexus/app", "v1"));
    check("T18 no token in push error serialization", !/tok/.test(JSON.stringify(res)), JSON.stringify(res));
  }
  {
    const p = new DockerRegistryProvider(fakeDocker(() => undefined), fakeFetch(200));
    const res = await p.push({ repository: "ghcr.io/nexus/app", tag: "v1", digest: null, full: "ghcr.io/nexus/app:v1 --privileged" });
    check("T19 ref with forbidden characters rejected", res.ok === false, res.reason ?? "");
  }
  {
    const p = new DockerRegistryProvider(fakeDocker(() => undefined), fakeFetch(200));
    const res = await p.push({ repository: "ghcr.io/nexus/app", tag: "v1", digest: null, full: "-rm" });
    check("T20 ref starting with '-' rejected", res.ok === false, res.reason ?? "");
  }
  {
    // authenticate() token redaction: if fetch throws and includes the token, it must be redacted.
    setEnv("NEXUS_REGISTRY_HOST", "ghcr.io");
    setEnv("NEXUS_REGISTRY_TOKEN", "ghp_thisShouldNeverAppearInErrors1234567890");
    const err = new Error("connection refused while sending Bearer ghp_thisShouldNeverAppearInErrors1234567890");
    const p = new DockerRegistryProvider(fakeDocker(() => undefined), fakeFetch(200, err));
    const auth = await p.authenticate();
    check("T21 token never appears in authenticate error",
      auth.ok === false && !/ghp_thisShouldNeverAppearInErrors/.test(auth.reason ?? ""),
      auth.reason ?? "");
  }
  {
    const SHA = "sha256:" + "b".repeat(64);
    check("T22 extractRepoDigest handles array and object forms",
      extractRepoDigest(JSON.stringify([{ RepoDigests: ["r@" + SHA] }])) === SHA
      && extractRepoDigest(JSON.stringify({ RepoDigests: ["r@" + SHA] })) === SHA,
      "ok");
  }

  // ----------------------------------------------------------
  // Live capability probe
  // ----------------------------------------------------------
  console.log("\n=== Live registry capability ===");
  const host = TRUE_REGISTRY_HOST;
  const token = TRUE_REGISTRY_TOKEN;
  if (!host || !token) {
    console.log("BLOCKED — registry capability unavailable (NEXUS_REGISTRY_HOST / NEXUS_REGISTRY_TOKEN not configured)");
  } else {
    console.log("Registry configured (" + host + ", token length " + token.length + "). Live push is not performed by this deterministic suite.");
  }

  restoreEnv();
  console.log("\n=======================================================");
  console.log("PASS: " + pass + "  FAIL: " + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });