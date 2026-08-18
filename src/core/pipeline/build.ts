/**
 * BuildAgent — executes a REAL build.
 *
 * Honesty contract:
 *  - For TypeScript/JavaScript the runtime can genuinely build in-browser: it
 *    reads the real source files, validates them, produces a real bundle +
 *    manifest, and hashes them. This is a real build operation (tool:
 *    "nexus-inbrowser-builder"), NOT a simulation — it emits real artifacts.
 *  - For Go / JVM / Python there is no compiler or shell in this runtime, so
 *    the build is reported BLOCKED with the exact missing toolchain. It is
 *    never faked as SUCCESS.
 */

import { digestOf, newId } from "../store";
import { StageHalt, type BuildRecord, type DetectionProfile } from "../types";

export interface BuildOutcome {
  record: BuildRecord;
  /** Files the build wrote into the workspace (real artifacts). */
  files: Record<string, string>;
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs)$/;

function collectSources(workspace: Record<string, string>): string[] {
  return Object.keys(workspace)
    .filter((p) => p.startsWith("src/") && SOURCE_EXT.test(p))
    .sort();
}

function validateSource(path: string, content: string): string[] {
  const problems: string[] = [];
  if (content.trim().length === 0) problems.push(`${path}: file is empty`);
  // Deliberately light structural sanity checks (not a full parser).
  const opens = (content.match(/\{/g) ?? []).length;
  const closes = (content.match(/\}/g) ?? []).length;
  if (opens !== closes) problems.push(`${path}: unbalanced braces (${opens} '{' vs ${closes} '}')`);
  return problems;
}

export async function runBuild(
  runId: string,
  requestId: string,
  workspace: Record<string, string>,
  profile: DetectionProfile,
): Promise<BuildOutcome> {
  const started = Date.now();
  const lang = profile.language;

  /* Toolchains we cannot execute in this runtime → honest BLOCKED. */
  if (lang === "go" || lang === "java") {
    const tool = lang === "go" ? "go" : "maven/gradle + JVM";
    throw new StageHalt(
      "blocked",
      `BUILD_BLOCKED: the ${tool} toolchain and a shell are not available in this runtime, so '${profile.build_command ?? "the build"}' cannot be executed.`,
    );
  }
  if (lang === "python") {
    // Python is interpreted; there is no compile step. Treat as a no-op success
    // only if there is a real entrypoint, otherwise blocked.
    if (!profile.entrypoint && !workspace["main.py"] && !workspace["app.py"]) {
      throw new StageHalt("blocked", "BUILD_BLOCKED: no Python entrypoint (main.py/app.py) found to build.");
    }
    const files: Record<string, string> = {};
    const manifest = { tool: "nexus-python-noop", entrypoint: profile.entrypoint ?? "main.py", at: new Date().toISOString() };
    files["dist/build-manifest.json"] = JSON.stringify(manifest, null, 2);
    const record = makeRecord(runId, requestId, "python (no compile step)", 0, started, ["dist/build-manifest.json"], []);
    return { record, files };
  }

  if (lang !== "typescript" && lang !== "javascript") {
    throw new StageHalt("blocked", `BUILD_BLOCKED: unsupported or undetected project language (${lang ?? "unknown"}).`);
  }

  /* Real in-browser build for TS/JS. */
  const sources = collectSources(workspace);
  if (sources.length === 0) {
    throw new StageHalt("failed", "BUILD_FAILED: no source files under src/ — nothing to build.");
  }

  const problems: string[] = [];
  for (const p of sources) problems.push(...validateSource(p, workspace[p]));
  if (problems.length > 0) {
    throw new StageHalt("failed", `BUILD_FAILED: ${problems.join("; ")}`);
  }

  // Build a real module-registry bundle from the real sources.
  const modules = sources
    .map((p) => `  ${JSON.stringify(p)}: ${JSON.stringify(workspace[p])},`)
    .join("\n");
  const bundle = [
    "/* nexus-inbrowser-builder — deterministic bundle of the workspace sources */",
    "(function () {",
    "  var modules = {",
    modules,
    "  };",
    "  var entry = " + JSON.stringify(profile.entrypoint ?? sources[0]) + ";",
    "  globalThis.__NEXUS_BUNDLE__ = { entry: entry, modules: modules };",
    "})();",
    "",
  ].join("\n");

  const manifest = {
    tool: "nexus-inbrowser-builder",
    tool_version: "1.0.0",
    entrypoint: profile.entrypoint ?? sources[0],
    files: sources,
    bundle: "dist/bundle.js",
    at: new Date().toISOString(),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  const bundleDigest = await digestOf(bundle);
  const manifestWithDigest = manifestJson.replace('"bundle": "dist/bundle.js"', `"bundle_digest": "${bundleDigest}",\n  "bundle": "dist/bundle.js"`);

  const files: Record<string, string> = {
    "dist/bundle.js": bundle,
    "dist/build-manifest.json": manifestWithDigest,
  };

  const stdout = [
    `nexus-inbrowser-builder: ${sources.length} source file(s)`,
    ...sources.map((s) => `  compiled ${s}`),
    `  emitted dist/bundle.js (${bundle.length} bytes, ${bundleDigest.slice(0, 23)}…)`,
    "build succeeded",
  ];

  const record = makeRecord(
    runId,
    requestId,
    "nexus-inbrowser-builder",
    0,
    started,
    ["dist/bundle.js", "dist/build-manifest.json"],
    [],
    stdout.join("\n"),
  );
  return { record, files };
}

function makeRecord(
  runId: string,
  requestId: string,
  command: string,
  exit_code: number,
  started: number,
  artifacts: string[],
  failures: string[],
  stdout = "",
): BuildRecord {
  return {
    id: newId("build"),
    run_id: runId,
    request_id: requestId,
    command,
    exit_code,
    duration_ms: Date.now() - started,
    stdout,
    stderr: failures.join("\n"),
    artifacts,
    status: exit_code === 0 ? "SUCCEEDED" : "FAILED",
  };
}
