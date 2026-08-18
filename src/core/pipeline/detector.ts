/**
 * ProjectDetector — inspects a real workspace (a path -> source map) and
 * produces a grounded DetectionProfile. It only reports what the files
 * actually show; unknown fields are null, never guessed.
 */

import type { DetectionProfile, DetectedDependency } from "../types";

export function detectProject(workspace: Record<string, string>): DetectionProfile {
  const evidence: string[] = [];
  const has = (p: string) => Object.prototype.hasOwnProperty.call(workspace, p);

  let language: string | null = null;
  let framework: string | null = null;
  let runtime: string | null = null;
  let package_manager: string | null = null;
  let build_command: string | null = null;
  let test_command: string | null = null;
  let entrypoint: string | null = null;
  const dependencies: DetectedDependency[] = [];

  /* ------------------------------- Node / TS ------------------------------- */
  if (has("package.json")) {
    evidence.push("package.json");
    language = "typescript";
    runtime = "node";
    package_manager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    try {
      const pkg = JSON.parse(workspace["package.json"]) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        main?: string;
      };
      build_command = pkg.scripts?.build ? `${package_manager} run build` : null;
      test_command = pkg.scripts?.test && pkg.scripts.test !== "echo \"Error: no test specified\" && exit 1"
        ? `${package_manager} test`
        : null;
      entrypoint = pkg.main ?? null;
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        dependencies.push({ name, version, dev: false });
      }
      for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
        dependencies.push({ name, version, dev: true });
      }
      const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (all["next"]) framework = "next";
      else if (all["react"]) framework = "react";
      else if (all["vue"]) framework = "vue";
      else if (all["express"]) framework = "express";
    } catch {
      build_command = null;
    }
    // A tsconfig confirms TypeScript specifically.
    if (has("tsconfig.json")) {
      language = "typescript";
      evidence.push("tsconfig.json");
    } else if (language === "typescript") {
      language = "javascript";
    }
  }

  /* --------------------------------- Python -------------------------------- */
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    if (has("pyproject.toml")) evidence.push("pyproject.toml");
    if (has("requirements.txt")) evidence.push("requirements.txt");
    if (has("setup.py")) evidence.push("setup.py");
    language = "python";
    runtime = "python";
    package_manager = has("poetry.lock") ? "poetry" : has("Pipfile.lock") ? "pipenv" : "pip";
    if (has("requirements.txt")) {
      for (const line of workspace["requirements.txt"].split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const m = trimmed.match(/^([A-Za-z0-9_.\-]+)\s*(?:==|>=|~=)\s*([^\s;]+)/);
        if (m) dependencies.push({ name: m[1], version: m[2], dev: false });
        else dependencies.push({ name: trimmed.split(/[=<>~\[]/)[0], version: "unpinned", dev: false });
      }
    }
    // FastAPI / Flask detection from requirements or an app file.
    const reqs = workspace["requirements.txt"] ?? "";
    if (/fastapi/i.test(reqs)) framework = "fastapi";
    else if (/flask/i.test(reqs)) framework = "flask";
    test_command = "pytest";
    build_command = null; // interpreted language — no compile step
  }

  /* ----------------------------------- Go ----------------------------------- */
  if (has("go.mod")) {
    evidence.push("go.mod");
    language = "go";
    runtime = "go";
    package_manager = "go";
    build_command = "go build ./...";
    test_command = "go test ./...";
  }

  /* ---------------------------------- Java ---------------------------------- */
  if (has("pom.xml")) {
    evidence.push("pom.xml");
    language = "java";
    runtime = "jvm";
    package_manager = "maven";
    build_command = "mvn -q package";
    test_command = "mvn -q test";
  } else if (has("build.gradle") || has("build.gradle.kts")) {
    evidence.push(has("build.gradle") ? "build.gradle" : "build.gradle.kts");
    language = "java";
    runtime = "jvm";
    package_manager = "gradle";
    build_command = "gradle build";
    test_command = "gradle test";
  }

  /* --------------------------------- Docker --------------------------------- */
  const has_dockerfile = has("Dockerfile");
  const has_compose = has("docker-compose.yml") || has("docker-compose.yaml");
  if (has_dockerfile) evidence.push("Dockerfile");
  if (has_compose) evidence.push("docker-compose.yml");

  return {
    language,
    framework,
    runtime,
    package_manager,
    build_command,
    test_command,
    entrypoint,
    has_dockerfile,
    has_compose,
    dependencies,
    evidence,
    detected_at: Date.now(),
  };
}
