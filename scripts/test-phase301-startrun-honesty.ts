// scripts/test-phase301-startrun-honesty.ts
// Phase 301 WP1: proves Fix B — CiPipelineEngine.startRun never transitions
// a remote-provider run to RUNNING without a confirmed external dispatch.
//
// Construction: the CiPipelineEngine is instantiated directly with a
// test-double CiServices whose `cicd` field is deliberately undefined,
// so we exercise the "no bridge" path. This is a pure unit test of
// startRun's decision logic; it does not boot NexusKernel and does not
// touch PostgreSQL.
//
// Cases:
//   WP301-STARTRUN-1  static provider -> BLOCKED (Phase 219 unchanged)
//   WP301-STARTRUN-2  remote+github, no bridge -> BLOCKED with "no CICD bridge"
//   WP301-STARTRUN-3  remote+gitlab, with bridge -> BLOCKED with "not implemented"
//   WP301-STARTRUN-4  remote+unknown, no bridge -> BLOCKED with "no CICD bridge"
//   WP301-STARTRUN-5  regression: NO case yields RUNNING without external_run_id
//   WP301-STARTRUN-6  regression: no case yields SUCCEEDED via fallthrough

process.env.NEXUS_ENVELOPE_HMAC_KID ??= "test-k1";
process.env.NEXUS_ENVELOPE_HMAC_KEY_HEX ??= "ab".repeat(32);

import { CiPipelineEngine, type CiPipelineRun, type CiContext, type GitProvider } from "../src/core/cicd";

type R = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
const rows: { id: string; name: string; r: R; n: string }[] = [];
function rec(id: string, name: string, r: R, n: string) {
  rows.push({ id, name, r, n });
  const m = r === "PASS" ? "[PASS]" : r === "FAIL" ? "[FAIL]" : r === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${m} ${id} ${name} -- ${n}`);
}
function ok(c: boolean, m: string) { if (!c) throw new Error(m); }
async function test(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  try { rec(id, name, "PASS", await fn()); }
  catch (e) { rec(id, name, "FAIL", e instanceof Error ? e.message : String(e)); }
}

// Minimal CiServices stub: startRun only reads svc.cicd, svc.events, svc.audit
// in its paths. The static and no-bridge branches never call the audit or engine.
function makeEngine(withBridge: boolean): CiPipelineEngine {
  const svc: any = {
    engine: {
      put: async (_store: string, _id: string, value: any) => value,
      get: async (_store: string, _id: string) => null,
    } as any,
    events: { emit: async () => {} },
    audit: { record: async () => {} },
    evidence: {} as any,
    artifacts: {} as any,
    authz: {} as any,
    cicd: withBridge
      ? {
          registry: { get: () => ({ id: "github-actions" }), list: () => [{ id: "github-actions" }] },
          manager: { trigger: async () => ({ externalRunId: "999" }), getStatus: async () => ({ status: "SUCCEEDED" }), cancel: async () => {} },
          providerId: "github-actions",
        }
      : undefined,
  };
  return new CiPipelineEngine(svc);
}

function makeRun(provider: "github" | "gitlab"): CiPipelineRun {
  return {
    id: "wp301-run-" + Math.random().toString(36).slice(2, 8),
    execution_id: "exec-x",
    project_id: "proj-x",
    provider,
    status: "QUEUED",
    attempt: 1,
    correlation_id: "corr-x",
    repository: "octocat/Hello-World",
    ref: "refs/heads/main",
    workflow_file: ".github/workflows/ci.yml",
    commit_sha: "0".repeat(40),
    external_run_id: null,
    blocked_reason: null,
  } as unknown as CiPipelineRun;
}

function makeCtx(): CiContext {
  return {
    actor: { email: "test@nexus.local" } as any,
    project_id: "proj-x",
    execution_id: "exec-x",
    attempt: 1,
    correlation_id: "corr-x",
  } as unknown as CiContext;
}

const staticProvider: GitProvider = { kind: "static", name: "github" } as unknown as GitProvider;
const remoteGithubProvider: GitProvider = { kind: "remote", name: "github" } as unknown as GitProvider;
const remoteGitlabProvider: GitProvider = { kind: "remote", name: "gitlab" } as unknown as GitProvider;
const unknownKindProvider: GitProvider = { kind: "unknown-kind" as any, name: "github" } as unknown as GitProvider;

async function main(): Promise<void> {
  // The transitionRun inside CiPipelineEngine may need to persist state via
  // svc.engine. Stub it so the transition is observed on the returned run.
  // We read the RETURNED run (not the persisted one) in every assertion.

  await test("WP301-STARTRUN-1", "static provider -> BLOCKED (Phase 219 unchanged)", async () => {
    const engine = makeEngine(false);
    const run = makeRun("github");
    const out = await engine.startRun(run, makeCtx(), staticProvider);
    ok(out.status === "BLOCKED", "expected BLOCKED, got " + out.status);
    ok(!!out.blocked_reason && /static provider fixture/.test(out.blocked_reason), "blocked_reason mismatch: " + out.blocked_reason);
    return "BLOCKED: " + out.blocked_reason!.slice(0, 60);
  });

  await test("WP301-STARTRUN-2", "remote+github, no bridge -> BLOCKED (Fix B core)", async () => {
    const engine = makeEngine(false);
    const run = makeRun("github");
    const out = await engine.startRun(run, makeCtx(), remoteGithubProvider);
    ok(out.status === "BLOCKED", "expected BLOCKED, got " + out.status);
    ok(!!out.blocked_reason && /no CICD bridge wired/.test(out.blocked_reason), "blocked_reason mismatch: " + out.blocked_reason);
    ok(out.status !== "RUNNING", "Fix B regression: remote+github without bridge reached RUNNING");
    return "BLOCKED: " + out.blocked_reason!.slice(0, 60);
  });

  await test("WP301-STARTRUN-3", "remote+gitlab, with bridge -> BLOCKED (not implemented)", async () => {
    const engine = makeEngine(true);
    const run = makeRun("gitlab");
    const out = await engine.startRun(run, makeCtx(), remoteGitlabProvider);
    ok(out.status === "BLOCKED", "expected BLOCKED, got " + out.status);
    ok(!!out.blocked_reason && /remote provider not implemented/.test(out.blocked_reason), "blocked_reason mismatch: " + out.blocked_reason);
    return "BLOCKED: " + out.blocked_reason!.slice(0, 60);
  });

  await test("WP301-STARTRUN-4", "remote+unknown provider, no bridge -> BLOCKED", async () => {
    const engine = makeEngine(false);
    const run = makeRun("github");
    const out = await engine.startRun(run, makeCtx(), unknownKindProvider);
    ok(out.status === "BLOCKED", "expected BLOCKED, got " + out.status);
    return "BLOCKED";
  });

  await test("WP301-STARTRUN-5", "regression: no case yields RUNNING without external_run_id", async () => {
    const cases: Array<[string, GitProvider, boolean]> = [
      ["static", staticProvider, false],
      ["remote+github/no-bridge", remoteGithubProvider, false],
      ["remote+gitlab/bridge", remoteGitlabProvider, true],
      ["remote+unknown/no-bridge", unknownKindProvider, false],
    ];
    for (const [name, prov, withBridge] of cases) {
      const engine = makeEngine(withBridge);
      const run = makeRun(prov.name === "gitlab" ? "gitlab" : "github");
      const out = await engine.startRun(run, makeCtx(), prov);
      if (out.status === "RUNNING" && !out.external_run_id) {
        throw new Error("Fix B regression in case " + name + ": RUNNING without external_run_id");
      }
    }
    return "all 4 cases safe";
  });

  await test("WP301-STARTRUN-6", "regression: no fallthrough to SUCCEEDED", async () => {
    const engine = makeEngine(false);
    const run = makeRun("github");
    const out = await engine.startRun(run, makeCtx(), remoteGithubProvider);
    ok(out.status !== "SUCCEEDED", "startRun fabricatd SUCCEEDED for unexecuted run");
    ok(out.status === "BLOCKED", "expected BLOCKED, got " + out.status);
    return "no false SUCCEEDED";
  });
}

main().then(() => {
  const pass = rows.filter((r) => r.r === "PASS").length;
  const fail = rows.filter((r) => r.r === "FAIL").length;
  const blk = rows.filter((r) => r.r === "BLOCKED").length;
  const ne = rows.filter((r) => r.r === "NOT EXECUTED").length;
  console.log("\n===== Phase 301 startRun Honesty summary =====");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blk);
  console.log("NOT EXECUTED: " + ne);
  process.exit(fail > 0 ? 1 : (blk > 0 || ne > 0) ? 2 : 0);
}).catch((e) => { console.error("FATAL:", e); process.exit(1); });