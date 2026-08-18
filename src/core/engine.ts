/**
 * NEXUS Pass-1 pipeline engine.
 *
 * Runs the REAL pipeline modules in sequence against an in-browser workspace:
 *   detect → build → test → security → docker → image-scan → sbom → artifact
 *
 * Honesty rules enforced here:
 *  - Every stage that runs produces real evidence (outputs, digests, counts).
 *  - Docker build and image scan have no daemon/scanner in this runtime, so they
 *    are recorded as BLOCKED with the true reason — never faked as success.
 *  - A failed or blocked hard-gate (build/test/security) stops the chain; the
 *    run reports FAILED or BLOCKED accordingly. SBOM + artifact registration
 *    still run because they depend only on the (real) build output.
 */

import { detectProject } from "./pipeline/detector";
import { runBuild } from "./pipeline/build";
import { runTests } from "./pipeline/testing";
import { runSecurityScan } from "./pipeline/security";
import { generateSbom } from "./pipeline/sbom";
import { digestOf, newId } from "./store";
import { StageHalt } from "./types";
import type {
  ArtifactRecord,
  DetectionProfile,
  SecurityResult,
  StageName,
  StageStatus,
  TestResult,
} from "./types";

export type LogKind = "dim" | "info" | "ok" | "warn" | "err";

export interface LogLine {
  id: string;
  at: number;
  kind: LogKind;
  text: string;
}

export interface StageState {
  stage: StageName;
  status: StageStatus;
  detail: string;
  started_at: number | null;
  duration_ms: number | null;
  evidence: Record<string, unknown>;
}

export type RunStatus = "IDLE" | "RUNNING" | "COMPLETED" | "BLOCKED" | "FAILED";

export interface RunSnapshot {
  status: RunStatus;
  current: StageName | null;
  stages: Record<string, StageState>;
  logs: LogLine[];
  artifacts: ArtifactRecord[];
  profile: DetectionProfile | null;
  test: TestResult | null;
  security: SecurityResult | null;
  terminal: { code: string; message: string } | null;
  started_at: number | null;
  finished_at: number | null;
}

/** The ordered console pipeline. */
export const PIPELINE: { stage: StageName; label: string }[] = [
  { stage: "PLANNING", label: "Detect / Plan" },
  { stage: "BUILDING", label: "Build" },
  { stage: "TESTING", label: "Test" },
  { stage: "SECURITY_REVIEW", label: "Security" },
  { stage: "DOCKER_BUILD", label: "Docker" },
  { stage: "IMAGE_SCAN", label: "Image Scan" },
  { stage: "SBOM", label: "SBOM" },
  { stage: "ARTIFACT", label: "Artifact" },
];

function emptyStages(): Record<string, StageState> {
  const out: Record<string, StageState> = {};
  for (const { stage } of PIPELINE) {
    out[stage] = { stage, status: "PENDING", detail: "", started_at: null, duration_ms: null, evidence: {} };
  }
  return out;
}

export function emptySnapshot(): RunSnapshot {
  return {
    status: "IDLE",
    current: null,
    stages: emptyStages(),
    logs: [],
    artifacts: [],
    profile: null,
    test: null,
    security: null,
    terminal: null,
    started_at: null,
    finished_at: null,
  };
}

export interface EngineHooks {
  onUpdate: (snap: RunSnapshot) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real artifact registration with a genuine sha256 digest over the content. */
async function makeArtifact(
  org: string,
  runId: string,
  requestId: string,
  correlationId: string,
  type: ArtifactRecord["type"],
  name: string,
  content: string,
  location: string,
): Promise<ArtifactRecord> {
  return {
    id: newId("art"),
    org,
    run_id: runId,
    request_id: requestId,
    correlation_id: correlationId,
    type,
    name,
    digest: await digestOf(content),
    size: content.length,
    location,
    created_at: Date.now(),
  };
}

export async function runPipeline(
  workspace: Record<string, string>,
  prompt: string,
  hooks: EngineHooks,
): Promise<RunSnapshot> {
  const org = "nexus";
  const requestId = newId("req");
  const runId = newId("run");
  const correlationId = newId("cor");

  const snap = emptySnapshot();
  snap.status = "RUNNING";
  snap.started_at = Date.now();

  let logSeq = 0;
  const log = (kind: LogKind, text: string) => {
    logSeq += 1;
    snap.logs = [...snap.logs, { id: `log-${logSeq}`, at: Date.now(), kind, text }];
    hooks.onUpdate(structuredCloneLite(snap));
  };
  const setStage = (stage: StageName, patch: Partial<StageState>) => {
    snap.stages = { ...snap.stages, [stage]: { ...snap.stages[stage], ...patch } };
    hooks.onUpdate(structuredCloneLite(snap));
  };
  const pushArtifact = (a: ArtifactRecord) => {
    snap.artifacts = [...snap.artifacts, a];
    hooks.onUpdate(structuredCloneLite(snap));
  };

  const begin = (stage: StageName, label: string) => {
    snap.current = stage;
    setStage(stage, { status: "RUNNING", started_at: Date.now(), detail: `${label} running…` });
    log("info", `▶ ${label} — started`);
  };
  const succeed = (stage: StageName, label: string, detail: string, evidence: Record<string, unknown>) => {
    const st = snap.stages[stage];
    setStage(stage, {
      status: "SUCCEEDED",
      detail,
      duration_ms: st.started_at ? Date.now() - st.started_at : null,
      evidence,
    });
    log("ok", `✓ ${label} — ${detail}`);
  };
  const block = (stage: StageName, label: string, reason: string) => {
    const st = snap.stages[stage];
    setStage(stage, {
      status: "BLOCKED",
      detail: reason,
      duration_ms: st.started_at ? Date.now() - st.started_at : null,
      evidence: { blocked_reason: reason },
    });
    log("warn", `⛔ ${label} — BLOCKED: ${reason}`);
  };
  const fail = (stage: StageName, label: string, reason: string) => {
    const st = snap.stages[stage];
    setStage(stage, {
      status: "FAILED",
      detail: reason,
      duration_ms: st.started_at ? Date.now() - st.started_at : null,
      evidence: { error: reason },
    });
    log("err", `✗ ${label} — FAILED: ${reason}`);
  };

  log("dim", `nexus pass-1 engine · request ${requestId} · run ${runId}`);
  log("dim", `prompt: ${prompt.slice(0, 90)}${prompt.length > 90 ? "…" : ""}`);
  await sleep(350);

  /* The workspace accumulates real build outputs as stages run. */
  const ws: Record<string, string> = { ...workspace };

  /* ------------------------------ 1. PLANNING ------------------------------ */
  begin("PLANNING", "Detect / Plan");
  await sleep(300);
  const profile = detectProject(ws);
  snap.profile = profile;
  if (!profile.language) {
    fail("PLANNING", "Detect / Plan", "no recognizable project manifest found");
    return finish(snap, "FAILED", { code: "DETECTION_FAILED", message: "no recognizable project manifest" });
  }
  succeed(
    "PLANNING",
    "Detect / Plan",
    `${profile.language} · ${profile.runtime ?? "?"} · ${profile.dependencies.length} deps`,
    {
      language: profile.language,
      framework: profile.framework,
      runtime: profile.runtime,
      package_manager: profile.package_manager,
      build_command: profile.build_command,
      test_command: profile.test_command,
      entrypoint: profile.entrypoint,
      has_dockerfile: profile.has_dockerfile,
      evidence_files: profile.evidence,
    },
  );
  log("dim", `  build: ${profile.build_command ?? "—"} · test: ${profile.test_command ?? "—"}`);
  await sleep(300);

  /* ------------------------------ 2. BUILDING ------------------------------ */
  begin("BUILDING", "Build");
  await sleep(350);
  let buildStdout = "";
  try {
    const outcome = await runBuild(runId, requestId, ws, profile);
    Object.assign(ws, outcome.files);
    buildStdout = outcome.record.stdout;
    for (const line of buildStdout.split("\n")) if (line.trim()) log("dim", `  ${line}`);
    succeed(
      "BUILDING",
      "Build",
      `${outcome.record.artifacts.length} artifact(s) · exit ${outcome.record.exit_code}`,
      {
        command: outcome.record.command,
        exit_code: outcome.record.exit_code,
        artifacts: outcome.record.artifacts,
        stdout: outcome.record.stdout,
      },
    );
    await sleep(300);
  } catch (e) {
    return haltOn(snap, "BUILDING", "Build", e, ws, runId);
  }

  /* ------------------------------ 3. TESTING ------------------------------- */
  begin("TESTING", "Test");
  await sleep(350);
  try {
    const test = await runTests(ws, profile);
    snap.test = test;
    succeed(
      "TESTING",
      "Test",
      `${test.passed}/${test.total} passed · ${test.duration_ms}ms`,
      { suite: test.suite, total: test.total, passed: test.passed, failed: test.failed, failures: test.failures },
    );
    log("dim", `  suite '${test.suite}': ${test.passed}/${test.total} assertions held`);
    await sleep(300);
  } catch (e) {
    return haltOn(snap, "TESTING", "Test", e, ws, runId);
  }

  /* --------------------------- 4. SECURITY_REVIEW -------------------------- */
  begin("SECURITY_REVIEW", "Security");
  await sleep(350);
  try {
    const sec = await runSecurityScan(ws, profile, { allowExternal: false });
    snap.security = sec;
    if (sec.outcome === "BLOCKED") {
      block("SECURITY_REVIEW", "Security", sec.blocked_reason ?? "scanner unavailable");
      return finish(snap, "BLOCKED", { code: "SECURITY_BLOCKED", message: sec.blocked_reason ?? "scanner unavailable" });
    }
    if (sec.outcome === "FAILED") {
      const crit = sec.findings.filter((f) => f.severity === "critical" || f.severity === "high");
      fail("SECURITY_REVIEW", "Security", `${sec.findings.length} finding(s), ${crit.length} high/critical`);
      return finish(snap, "FAILED", { code: "SECURITY_FAILED", message: `${crit.length} high/critical finding(s)` });
    }
    succeed(
      "SECURITY_REVIEW",
      "Security",
      `clean · ${sec.scanned_files} file(s) scanned`,
      { scanner: sec.scanner, outcome: sec.outcome, findings: sec.findings, scanned_files: sec.scanned_files },
    );
    await sleep(300);
  } catch (e) {
    return haltOn(snap, "SECURITY_REVIEW", "Security", e, ws, runId);
  }

  /* ---------------------------- 5. DOCKER_BUILD ---------------------------- */
  begin("DOCKER_BUILD", "Docker");
  await sleep(400);
  block(
    "DOCKER_BUILD",
    "Docker",
    "DOCKER_NOT_CONFIGURED — no Docker daemon is reachable from this browser runtime, so no image is built and no digest is invented.",
  );
  await sleep(300);

  /* ----------------------------- 6. IMAGE_SCAN ----------------------------- */
  begin("IMAGE_SCAN", "Image Scan");
  await sleep(350);
  block(
    "IMAGE_SCAN",
    "Image Scan",
    "CONTAINER_SCANNER_NOT_CONFIGURED — no image exists (Docker blocked) and no scanner adapter is configured.",
  );
  await sleep(300);

  /* -------------------------------- 7. SBOM -------------------------------- */
  begin("SBOM", "SBOM");
  await sleep(350);
  try {
    const buildArtifacts = snap.artifacts.filter((a) => a.type === "build_package");
    const { result } = await generateSbom(org, runId, requestId, correlationId, profile, "workspace-app", buildArtifacts);
    const sbomContent = JSON.stringify({ format: result.format, spec: result.spec, components: result.components }, null, 2);
    const sbomArt = await makeArtifact(org, runId, requestId, correlationId, "sbom", "sbom.cyclonedx.json", sbomContent, result.location);
    pushArtifact(sbomArt);
    succeed("SBOM", "SBOM", `CycloneDX ${result.spec} · ${result.components} component(s)`, {
      format: result.format,
      spec: result.spec,
      components: result.components,
      digest: result.digest,
      location: result.location,
    });
    await sleep(300);
  } catch (e) {
    return haltOn(snap, "SBOM", "SBOM", e, ws, runId);
  }

  /* ------------------------------- 8. ARTIFACT ------------------------------ */
  begin("ARTIFACT", "Artifact");
  await sleep(350);
  try {
    // Register real artifacts for the outputs that actually exist.
    const bundle = ws["dist/bundle.js"];
    const manifest = ws["dist/build-manifest.json"];
    if (bundle) pushArtifact(await makeArtifact(org, runId, requestId, correlationId, "build_package", "dist/bundle.js", bundle, `ws://${requestId}/dist/bundle.js`));
    if (manifest) pushArtifact(await makeArtifact(org, runId, requestId, correlationId, "build_package", "dist/build-manifest.json", manifest, `ws://${requestId}/dist/build-manifest.json`));
    if (snap.test) pushArtifact(await makeArtifact(org, runId, requestId, correlationId, "test_report", "test-report.json", JSON.stringify(snap.test, null, 2), `ws://${requestId}/test-report.json`));
    if (snap.security) pushArtifact(await makeArtifact(org, runId, requestId, correlationId, "security_report", "security-report.json", JSON.stringify(snap.security, null, 2), `ws://${requestId}/security-report.json`));
    const dockerfile = ws["Dockerfile"];
    if (dockerfile) pushArtifact(await makeArtifact(org, runId, requestId, correlationId, "dockerfile", "Dockerfile", dockerfile, `ws://${requestId}/Dockerfile`));
    succeed("ARTIFACT", "Artifact", `${snap.artifacts.length} artifact(s) registered`, { count: snap.artifacts.length });
    log("dim", `  ${snap.artifacts.length} artifact(s) with sha256 digests`);
  } catch (e) {
    return haltOn(snap, "ARTIFACT", "Artifact", e, ws, runId);
  }

  /* Docker/image-scan are blocked, so the overall run is BLOCKED even though the
   * source-chain (detect→build→test→security→sbom→artifact) genuinely ran. */
  return finish(snap, "BLOCKED", {
    code: "DOCKER_NOT_CONFIGURED",
    message: "source pipeline executed; containerization unavailable in this runtime",
  });
}

/* ------------------------------ halt handling ------------------------------ */

function haltOn(
  snap: RunSnapshot,
  stage: StageName,
  label: string,
  e: unknown,
  _ws: Record<string, string>,
  _runId: string,
): RunSnapshot {
  if (e instanceof StageHalt) {
    if (e.kind === "blocked") {
      const st = snap.stages[stage];
      snap.stages = { ...snap.stages, [stage]: { ...st, status: "BLOCKED", detail: e.message, duration_ms: st.started_at ? Date.now() - st.started_at : null, evidence: { blocked_reason: e.message } } };
      snap.logs = [...snap.logs, { id: `log-${snap.logs.length + 1}`, at: Date.now(), kind: "warn", text: `⛔ ${label} — BLOCKED: ${e.message}` }];
      return finish(snap, "BLOCKED", { code: "STAGE_BLOCKED", message: e.message });
    }
    const st = snap.stages[stage];
    snap.stages = { ...snap.stages, [stage]: { ...st, status: "FAILED", detail: e.message, duration_ms: st.started_at ? Date.now() - st.started_at : null, evidence: { error: e.message } } };
    snap.logs = [...snap.logs, { id: `log-${snap.logs.length + 1}`, at: Date.now(), kind: "err", text: `✗ ${label} — FAILED: ${e.message}` }];
    return finish(snap, "FAILED", { code: "STAGE_FAILED", message: e.message });
  }
  const msg = e instanceof Error ? e.message : String(e);
  const st = snap.stages[stage];
  snap.stages = { ...snap.stages, [stage]: { ...st, status: "FAILED", detail: msg, duration_ms: st.started_at ? Date.now() - st.started_at : null, evidence: { error: msg } } };
  snap.logs = [...snap.logs, { id: `log-${snap.logs.length + 1}`, at: Date.now(), kind: "err", text: `✗ ${label} — unexpected error: ${msg}` }];
  return finish(snap, "FAILED", { code: "UNEXPECTED", message: msg });
}

function finish(snap: RunSnapshot, status: Exclude<RunStatus, "IDLE" | "RUNNING">, terminal: { code: string; message: string }): RunSnapshot {
  snap.status = status;
  snap.current = null;
  snap.terminal = terminal;
  snap.finished_at = Date.now();
  const kind = status === "FAILED" ? "err" : status === "BLOCKED" ? "warn" : "ok";
  snap.logs = [
    ...snap.logs,
    {
      id: `log-${snap.logs.length + 1}`,
      at: Date.now(),
      kind,
      text: `■ run ${status.toLowerCase()} — ${terminal.message}`,
    },
  ];
  return structuredCloneLite(snap);
}

/** Shallow-ish clone good enough to trigger React state updates. */
function structuredCloneLite(snap: RunSnapshot): RunSnapshot {
  return {
    ...snap,
    stages: { ...snap.stages },
    logs: [...snap.logs],
    artifacts: [...snap.artifacts],
  };
}
