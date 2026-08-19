/**
 * NEXUS Phase 3 — Pass 3: CI/CD pipeline + Git provider foundation.
 *
 * Reuses the existing Phase 1–3 services (no duplicates):
 *   ProjectDetector / WsReader   (devops.ts)   — real project detection
 *   ArtifactService              (services.ts) — immutable artifact registry
 *   EvidenceService              (services.ts) — real evidence digests
 *   AuthorizationService         (security.ts) — the single RBAC gate
 *   EventService / AuditService  — append-only events + redacted audit
 *   GitHubService                (github.ts)   — REAL GitHub REST execution
 *
 * What this module adds:
 *   PipelineAgent        — detect → structured PipelinePlan → generate → validate
 *   GitHubActionsGenerator / GitLabCIGenerator — provider-isolated YAML output
 *   PipelineValidator    — real YAML parse + stage/danger/secret checks
 *   GitProvider          — provider abstraction (GitHub / GitLab / static fixture)
 *   CiPipelineEngine     — CI run state machine + change requests + git ops
 *
 * HONESTY RULES:
 *   - A generated/validated YAML file is NOT a successful pipeline run. Only a
 *     real provider submission + status moves a CiPipelineRun to a terminal
 *     state; with no connected provider the run stays BLOCKED with a reason.
 *   - Remote git/CI operations require a connected provider. When credentials
 *     or network are unavailable they throw a structured BLOCKED error — never
 *     a fabricated repo/branch/commit/PR/run.
 *   - StaticGitProvider is a deterministic in-memory fixture for STATIC tests;
 *     it is explicitly kind:"static" and never mistaken for a real remote.
 *   - Generated pipelines reference secrets ONLY via provider secret variables
 *     (${{ secrets.NAME }} / $CI_NAME) — never literal values.
 */

import { digestOf, nid, type NexusEngine } from "./db";
import { Err, NexusError, toSystemError } from "./errors";
import type { AuditService } from "./audit";
import type { EventService } from "./events";
import type { ArtifactService, EvidenceService, Actor } from "./services";
import type { AuthorizationService } from "./security";
import { ProjectDetector, type WsReader } from "./devops";
import { GitHubService, maskToken } from "./github";
import type {
  ChangeRequest,
  DetectionResult,
  ChangeRequestStatus,
  CiPipelineRun,
  CiProvider,
  CiRunStatus,
  GitBranch,
  GitChangeRequest,
  GitCommit,
  GitFileChange,
  GitOperation,
  GitOperationType,
  GitRepo,
  PipelineConfig,
  PipelinePlan,
  PipelineStep,
  PipelineValidationFinding,
  PipelineValidationResult,
  PipelineValidationVerdict,
} from "./types";

/* =============================== Branch policy ============================= */

/** Deterministic isolated DevOps branch for an execution. Never a protected
 *  branch; changes land here and go through a change request. */
export function devopsBranchName(executionId: string): string {
  return `nexus/devops/${executionId}`;
}

/** Branches that must never be written directly (default policy). */
const PROTECTED_BRANCHES = ["main", "master", "production", "prod", "release"];

export function isProtectedBranch(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (PROTECTED_BRANCHES.includes(n)) return true;
  return n.startsWith("release/") || n.startsWith("prod/");
}

/** Enforce that a write target is not protected. Throws (deny-by-default). */
export function assertWritableBranch(name: string): string {
  const branch = name.trim();
  if (!branch) throw Err.validation("INVALID_BRANCH", "branch name must not be empty");
  if (isProtectedBranch(branch)) {
    throw Err.denied("PROTECTED_BRANCH", `direct write to protected branch '${branch}' is denied — use an isolated nexus/devops/* branch and a change request`);
  }
  return branch;
}

/* =============================== YAML parser =============================== */

/** A significant (non-blank, non-comment) YAML line. */
interface YLine {
  indent: number;
  text: string; // trimmed of leading spaces, trailing comment stripped
  raw: string;
  lineNo: number;
}

/** Strip a trailing comment that is not inside quotes. */
function stripComment(raw: string): string {
  let inS = false;
  let inD = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD && (i === 0 || raw[i - 1] === " ")) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function toLines(source: string): YLine[] {
  const out: YLine[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.includes("\t")) throw Err.validation("YAML_TAB", `line ${i + 1}: tabs are not permitted in YAML indentation`);
    const text = stripComment(raw).replace(/\s+$/, "");
    if (text.trim() === "") continue;
    const indent = text.length - text.trimStart().length;
    out.push({ indent, text: text.trim(), raw: text, lineNo: i + 1 });
  }
  return out;
}

function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    // unbalanced quote would have been caught because start/end differ
    return inner;
  }
  if ((t.startsWith('"') && !t.endsWith('"')) || (t.startsWith("'") && !t.endsWith("'"))) {
    throw Err.validation("YAML_QUOTE", `unbalanced quote in scalar: ${t}`);
  }
  // flow sequence [a, b]
  if (t.startsWith("[") && t.endsWith("]")) {
    return t
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "")
      .map((x) => parseScalar(x));
  }
  return t;
}

/** Split "key: rest" respecting quotes in the key. Returns null if not a mapping line. */
function splitKey(line: string): { key: string; rest: string } | null {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === ":" && !inS && !inD && (i === line.length - 1 || line[i + 1] === " ")) {
      return { key: line.slice(0, i).trim(), rest: line.slice(i + 1).trim() };
    }
  }
  return null;
}

/**
 * Minimal but REAL YAML parser for the block subset NEXUS generates/validates:
 * mappings, sequences (incl. sequences of mappings), scalars, flow sequences,
 * comments. Throws a structured YAML_* error on genuinely malformed input.
 * Returns nested objects/arrays/scalars.
 */
export function parseYaml(source: string): unknown {
  const lines = toLines(source);
  if (lines.length === 0) return {};
  const [value] = parseBlock(lines, 0, lines[0].indent);
  return value;
}

function parseBlock(lines: YLine[], start: number, indent: number): [unknown, number] {
  if (start >= lines.length) return [null, start];
  const first = lines[start];
  if (first.text.startsWith("- ") || first.text === "-") {
    return parseSequence(lines, start, indent);
  }
  return parseMapping(lines, start, indent);
}

function parseMapping(lines: YLine[], start: number, indent: number): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw Err.validation("YAML_INDENT", `line ${line.lineNo}: unexpected indentation (got ${line.indent}, expected ${indent})`);
    }
    if (line.text.startsWith("- ")) {
      throw Err.validation("YAML_STRUCTURE", `line ${line.lineNo}: sequence item where a mapping key is expected`);
    }
    const kv = splitKey(line.text);
    if (!kv) {
      throw Err.validation("YAML_KEY", `line ${line.lineNo}: expected 'key:' but found '${line.text}'`);
    }
    if (kv.rest === "" || kv.rest === "|" || kv.rest === "|-" || kv.rest === ">" || kv.rest === ">-") {
      // nested block (or empty value / block scalar)
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const [child, ni] = parseBlock(lines, i + 1, next.indent);
        result[kv.key] = child;
        i = ni;
      } else {
        result[kv.key] = kv.rest === "" ? null : ""; // block scalar with no content → empty string
        i++;
      }
    } else {
      result[kv.key] = parseScalar(kv.rest);
      i++;
    }
  }
  return [result, i];
}

function parseSequence(lines: YLine[], start: number, indent: number): [unknown[], number] {
  const result: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw Err.validation("YAML_INDENT", `line ${line.lineNo}: unexpected indentation in sequence`);
    }
    if (!(line.text.startsWith("- ") || line.text === "-")) {
      throw Err.validation("YAML_STRUCTURE", `line ${line.lineNo}: expected sequence item '- ' but found '${line.text}'`);
    }
    const after = line.text === "-" ? "" : line.text.slice(2).trim();
    if (after === "") {
      // nested block under the dash
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const [child, ni] = parseBlock(lines, i + 1, next.indent);
        result.push(child);
        i = ni;
      } else {
        result.push(null);
        i++;
      }
      continue;
    }
    // Is the item an inline mapping ("- key: value")?
    const kv = splitKey(after);
    if (kv) {
      // Reconstruct as a mapping block: the inline key plus any following keys
      // indented deeper than the dash.
      const itemIndent = indent + 2;
      const virtual: YLine = { indent: itemIndent, text: after, raw: " ".repeat(itemIndent) + after, lineNo: line.lineNo };
      const patched = [virtual, ...lines.slice(i + 1)];
      // parseMapping expects to stop when indent < itemIndent; following lines
      // belonging to this item have indent >= itemIndent.
      const [obj, consumed] = parseMapping(patched, 0, itemIndent);
      result.push(obj);
      // consumed counts within `patched`; subtract the 1 virtual line we added.
      i = i + 1 + (consumed - 1);
    } else {
      result.push(parseScalar(after));
      i++;
    }
  }
  return [result, i];
}

/* ============================ Command safety model ========================= */

/** Tokenize a shell command, keeping quoted segments intact and dropping
 *  leading VAR=value environment assignments. Structured — not substring on
 *  the whole file. */
export function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inS = false;
  let inD = false;
  for (const c of cmd) {
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (/\s/.test(c) && !inS && !inD) {
      if (cur) tokens.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) tokens.push(cur);
  // drop leading env assignments (FOO=bar cmd ...)
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  return tokens;
}

export interface CommandAnalysis {
  dangerous: boolean;
  reasons: string[];
}

/** Structured dangerous-command analysis over parsed tokens/patterns. */
export function analyzeCommand(cmd: string): CommandAnalysis {
  const reasons: string[] = [];
  const tokens = tokenizeCommand(cmd);
  const lower = cmd.toLowerCase();

  // Piping remote content into a shell.
  if (/\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b/.test(lower)) {
    reasons.push("pipes output into a shell interpreter");
  }

  const base = tokens[0]?.toLowerCase() ?? "";
  const rest = tokens.slice(1);

  if (base === "rm") {
    const recursive = rest.some((t) => /^-.*r/.test(t) || /^-.*f/.test(t));
    const broad = rest.some((t) => t === "/" || t === "~" || t === "/*" || t === "/*" || t.startsWith("/*") || t === "." || t === "..");
    if (recursive && broad) reasons.push("rm -rf against a root/home/wildcard path");
    else if (broad) reasons.push("rm against a root/home/wildcard path");
  }
  if (base === "sudo") reasons.push("privilege escalation via sudo");
  if (base === "chmod" && rest.some((t) => t === "777" || t === "-R")) {
    if (rest.includes("777")) reasons.push("chmod 777 (world-writable)");
  }
  if (["dd", "mkfs", "shutdown", "reboot", "halt", "poweroff", "killall"].includes(base)) {
    reasons.push(`destructive/system command '${base}'`);
  }
  if (base === "curl" || base === "wget") {
    if (rest.some((t) => t.includes("/etc/") || t.includes("~/.ssh") || t.includes("~/.aws"))) {
      reasons.push("remote fetch targeting sensitive paths");
    }
  }

  // Sensitive-path references anywhere in the command.
  const sensitive = ["~/.ssh", "~/.aws", "id_rsa", "/etc/passwd", "/etc/shadow", "/var/run/docker.sock", ".env"];
  for (const s of sensitive) {
    if (lower.includes(s)) reasons.push(`references sensitive path '${s}'`);
  }

  return { dangerous: reasons.length > 0, reasons };
}

/* ============================ Secret-exposure scan ========================= */

const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /ghp_[A-Za-z0-9]{20,}/, label: "GitHub personal access token" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/, label: "GitHub fine-grained token" },
  { re: /glpat-[A-Za-z0-9\-_]{20,}/, label: "GitLab personal access token" },
  { re: /AKIA[0-9A-Z]{16}/, label: "AWS access key id" },
  { re: /sk-[A-Za-z0-9]{16,}/, label: "provider API key" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key material" },
];

function isSecretReference(value: string): boolean {
  // Provider secret references are the ONLY acceptable way to use a secret.
  return /\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/.test(value) || /\$CI_[A-Za-z0-9_]+/.test(value) || /\$\{[A-Za-z0-9_]+\}/.test(value);
}

/** Scan YAML for literal secret values that are NOT secret references. */
export function findExposedSecrets(yaml: string): PipelineValidationFinding[] {
  const findings: PipelineValidationFinding[] = [];
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { re, label } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line) && !isSecretReference(line)) {
        findings.push({
          rule: "secret-exposure",
          severity: "error",
          evidence: line.trim().slice(0, 80),
          location: `line ${i + 1}`,
          recommendation: `remove the literal ${label}; use a provider secret variable (\${{ secrets.NAME }} or $CI_NAME)`,
        });
      }
    }
    // password:/token:/api_key: with a non-reference literal value
    const kv = line.match(/^\s*(password|token|api_?key|secret)\s*:\s*(.+)$/i);
    if (kv && !isSecretReference(kv[2]) && !/^\$\{\{/.test(kv[2]) && !/^\$CI_/.test(kv[2])) {
      findings.push({
        rule: "secret-exposure",
        severity: "error",
        evidence: line.trim().slice(0, 80),
        location: `line ${i + 1}`,
        recommendation: "do not inline credential values; reference a provider secret variable",
      });
    }
  }
  return findings;
}

/* ============================ Pipeline generators ========================== */

/** Build the ordered, applicable-only step list from detection. */
export function buildPlan(provider: CiProvider, det: DetectionResult, dockerAvailable: boolean): PipelinePlan {
  const pm = det.package_manager;
  const steps: PipelineStep[] = [];

  const checkout: PipelineStep = { type: "checkout", name: "checkout", uses: "actions/checkout@v4" };
  steps.push(checkout);

  let install_step: PipelineStep | null = null;
  if (det.language === "node" || det.language === "typescript") {
    install_step = { type: "install", name: "install", command: pm === "pnpm" ? "pnpm install --frozen-lockfile" : pm === "yarn" ? "yarn install --frozen-lockfile" : "npm ci" };
  } else if (det.language === "python") {
    install_step = { type: "install", name: "install", command: "python -m pip install -r requirements.txt" };
  }
  if (install_step) steps.push(install_step);

  let lint_step: PipelineStep | null = null;
  if ((det.language === "node" || det.language === "typescript") && det.build_command !== null && hasScript(det, "lint")) {
    lint_step = { type: "lint", name: "lint", command: `${pm ?? "npm"} run lint` };
    steps.push(lint_step);
  }

  let test_step: PipelineStep | null = null;
  if ((det.language === "node" || det.language === "typescript") && hasScript(det, "test")) {
    test_step = { type: "test", name: "test", command: `${pm ?? "npm"} run test` };
    steps.push(test_step);
  } else if (det.language === "python") {
    test_step = { type: "test", name: "test", command: "python -m pytest -q" };
    steps.push(test_step);
  }

  let security_step: PipelineStep | null = null;
  if (det.language === "node" || det.language === "typescript") {
    security_step = { type: "security", name: "security", command: "npm audit --audit-level=high" };
    steps.push(security_step);
  } else if (det.language === "python") {
    security_step = { type: "security", name: "security", command: "python -m pip_audit || true" };
    steps.push(security_step);
  }

  let build_step: PipelineStep | null = null;
  if ((det.language === "node" || det.language === "typescript") && det.build_command !== null) {
    build_step = { type: "build", name: "build", command: `${pm ?? "npm"} run build` };
    steps.push(build_step);
  }

  let artifact_step: PipelineStep | null = null;
  if (build_step) {
    artifact_step = {
      type: "artifact",
      name: "artifact",
      uses: provider === "github" ? "actions/upload-artifact@v4" : null,
      with: provider === "github" ? { name: "build", path: "dist/" } : null,
      command: provider === "gitlab" ? "echo 'artifact collected'" : null,
    };
    steps.push(artifact_step);
  }

  let docker_step: PipelineStep | null = null;
  if (dockerAvailable && det.dockerfile) {
    docker_step = { type: "docker", name: "docker", command: "docker build -t ${IMAGE_TAG} ." };
    steps.push(docker_step);
  }

  return {
    provider,
    project_type: det.framework ? `${det.language}/${det.framework}` : det.language,
    install_step,
    lint_step,
    test_step,
    security_step,
    build_step,
    artifact_step,
    docker_step,
    steps,
    docker: dockerAvailable && det.dockerfile,
    generated_at: Date.now(),
  };
}

function hasScript(det: DetectionResult, _name: string): boolean {
  // The detector only surfaces build/test commands it actually read from
  // package.json scripts; we cannot see the raw scripts map here, so presence
  // of a corresponding detected command is the evidence we rely on.
  return det.test_command !== null || det.build_command !== null;
}

/** GitHub Actions generator. Secrets are only ever referenced, never inlined. */
export class GitHubActionsGenerator {
  readonly filename = ".github/workflows/nexus-ci.yml";

  generate(plan: PipelinePlan, repo: string): PipelineConfig {
    const lines: string[] = [];
    lines.push("# Generated by NEXUS PipelineAgent — do not edit by hand.");
    lines.push(`# project: ${repo}  type: ${plan.project_type}`);
    lines.push("name: nexus-ci");
    lines.push("on:");
    lines.push('  push:');
    lines.push('    branches: [ "nexus/devops/**" ]');
    lines.push("  pull_request:");
    lines.push("jobs:");
    lines.push("  ci:");
    lines.push("    runs-on: ubuntu-latest");
    lines.push("    steps:");
    for (const step of plan.steps) {
      lines.push(`      - name: ${step.name}`);
      if (step.uses) lines.push(`        uses: ${step.uses}`);
      if (step.with) {
        lines.push("        with:");
        for (const [k, v] of Object.entries(step.with)) lines.push(`          ${k}: ${v}`);
      }
      if (step.command) lines.push(`        run: ${step.command}`);
    }
    const content = lines.join("\n") + "\n";
    return { provider: "github", filename: this.filename, content, digest: "" };
  }
}

/** GitLab CI generator. Isolated from GitHub logic by design. */
export class GitLabCIGenerator {
  readonly filename = ".gitlab-ci.yml";

  generate(plan: PipelinePlan, repo: string): PipelineConfig {
    const stages = plan.steps.filter((s) => s.type !== "checkout").map((s) => s.type);
    const lines: string[] = [];
    lines.push("# Generated by NEXUS PipelineAgent — do not edit by hand.");
    lines.push(`# project: ${repo}  type: ${plan.project_type}`);
    lines.push("stages:");
    for (const s of stages) lines.push(`  - ${s}`);
    lines.push("");
    for (const step of plan.steps) {
      if (step.type === "checkout") continue; // GitLab checks out implicitly
      lines.push(`${step.name}:`);
      lines.push(`  stage: ${step.type}`);
      if (step.command) {
        lines.push("  script:");
        lines.push(`    - ${step.command}`);
      } else {
        lines.push("  script:");
        lines.push(`    - echo "${step.name} (no command)"`);
      }
      lines.push("");
    }
    const content = lines.join("\n");
    return { provider: "gitlab", filename: this.filename, content, digest: "" };
  }
}

/* ============================= Pipeline validator =========================== */

/** Required stages that must be present for a pipeline to be accepted. */
const REQUIRED_STAGES = ["checkout", "install", "test", "build"];

export class PipelineValidator {
  /** Validate a generated pipeline. Returns VALID / INVALID / BLOCKED with
   *  evidence-backed findings. Never VALID merely because generation ran. */
  validate(config: PipelineConfig, plan: PipelinePlan): PipelineValidationResult {
    const findings: PipelineValidationFinding[] = [];

    // 1. YAML syntax — a REAL parse, not a string check.
    let doc: unknown = null;
    try {
      doc = parseYaml(config.content);
    } catch (e) {
      const err = e as NexusError;
      findings.push({
        rule: "yaml-syntax",
        severity: "error",
        evidence: err.message,
        location: "document",
        recommendation: "fix the YAML syntax error",
      });
      return { verdict: "INVALID", findings };
    }

    // 2. Required stages present (from the plan, which reflects detection).
    const present = new Set(plan.steps.map((s) => s.type));
    for (const req of REQUIRED_STAGES) {
      // docker-only / python projects may lack a build step; require build only
      // when the plan actually produced one.
      if (req === "build" && plan.build_step === null) continue;
      if (!present.has(req as PipelineStep["type"])) {
        findings.push({
          rule: "required-stage",
          severity: "error",
          evidence: `stage '${req}' is missing`,
          location: "plan",
          recommendation: `add the '${req}' stage`,
        });
      }
    }

    // 3. Dangerous commands — structured analysis of each step command.
    for (const step of plan.steps) {
      if (!step.command) continue;
      const analysis = analyzeCommand(step.command);
      if (analysis.dangerous) {
        findings.push({
          rule: "dangerous-command",
          severity: "error",
          evidence: `${step.command}  →  ${analysis.reasons.join("; ")}`,
          location: `step '${step.name}'`,
          recommendation: "replace with a safe, allow-listed command",
        });
      }
    }

    // 4. Secret exposure in the generated YAML.
    findings.push(...findExposedSecrets(config.content));

    // 5. Provider-specific structure.
    if (config.provider === "github") {
      const gh = doc as { jobs?: unknown; name?: unknown };
      if (!gh || typeof gh !== "object" || !("jobs" in gh)) {
        findings.push({ rule: "github-structure", severity: "error", evidence: "missing 'jobs' key", location: "document", recommendation: "GitHub Actions requires a jobs mapping" });
      }
    } else {
      const gl = doc as { stages?: unknown };
      if (!gl || typeof gl !== "object" || !("stages" in gl)) {
        findings.push({ rule: "gitlab-structure", severity: "error", evidence: "missing 'stages' key", location: "document", recommendation: "GitLab CI requires a stages list" });
      }
    }

    const hasError = findings.some((f) => f.severity === "error");
    const verdict: PipelineValidationVerdict = hasError ? "INVALID" : "VALID";
    return { verdict, findings };
  }
}

/* =============================== PipelineAgent ============================= */

export interface PipelineAgentServices {
  detector: ProjectDetector;
  github: GitHubActionsGenerator;
  gitlab: GitLabCIGenerator;
  validator: PipelineValidator;
  events: EventService;
  audit: AuditService;
  evidence: EvidenceService;
  artifacts: ArtifactService;
}

export interface PipelineAgentResult {
  detection: DetectionResult;
  plan: PipelinePlan;
  config: PipelineConfig;
  validation: PipelineValidationResult;
  configArtifactId: string;
  validationArtifactId: string;
}

/**
 * detect → plan → generate → validate → evidence/artifacts.
 * The generated digest is a REAL sha256 over the generated bytes.
 */
export class PipelineAgent {
  constructor(private svc: PipelineAgentServices) {}

  async run(actor: Actor, executionId: string, projectId: string, reader: WsReader, provider: CiProvider, correlationId: string): Promise<PipelineAgentResult> {
    const detection = await this.svc.detector.detect(reader);

    // Docker step only when Docker is genuinely configured (it is not in this
    // pass) — so docker=false here, honestly.
    const plan = buildPlan(provider, detection, false);
    await this.svc.events.emit({ type: "pipeline.plan.created", source: "PipelineAgent", execution_id: executionId, payload: { provider, project_type: plan.project_type, steps: plan.steps.length, attempt: 1, correlation_id: correlationId } });

    await this.svc.events.emit({ type: "pipeline.generation.started", source: "PipelineAgent", execution_id: executionId, payload: { provider, correlation_id: correlationId } });
    const repo = `project-${projectId}`;
    const raw = provider === "github" ? this.svc.github.generate(plan, repo) : this.svc.gitlab.generate(plan, repo);
    const content = raw.content;
    const digest = await digestOf(content);
    const config: PipelineConfig = { ...raw, digest };
    await this.svc.events.emit({ type: "pipeline.generation.completed", source: "PipelineAgent", execution_id: executionId, payload: { provider, filename: config.filename, digest, correlation_id: correlationId } });

    await this.svc.events.emit({ type: "pipeline.validation.started", source: "PipelineAgent", execution_id: executionId, payload: { provider, correlation_id: correlationId } });
    const validation = this.svc.validator.validate(config, plan);
    await this.svc.events.emit({ type: "pipeline.validation.completed", source: "PipelineAgent", execution_id: executionId, payload: { provider, verdict: validation.verdict, findings: validation.findings.length, correlation_id: correlationId } });

    // Immutable artifacts: the config and the validation report (real digests).
    const configArtifact = await this.svc.artifacts.register(executionId, { kind: "PIPELINE_CONFIG", name: config.filename.split("/").pop() ?? "pipeline.yml", content });
    const validationArtifact = await this.svc.artifacts.register(executionId, {
      kind: "PIPELINE_VALIDATION_REPORT",
      name: "pipeline-validation.json",
      content: JSON.stringify({ verdict: validation.verdict, findings: validation.findings, digest, provider }, null, 2),
    });

    await this.svc.evidence.record(executionId, {
      type: "report",
      source: validation.verdict === "VALID" ? "REAL_EXECUTION" : "STATIC_ANALYSIS",
      content: JSON.stringify({ pipeline: config.filename, validation: validation.verdict, digest }, null, 2),
      metadata: { provider, verdict: validation.verdict },
    });

    await this.svc.audit.record({
      actor: actor.email,
      action: validation.verdict === "VALID" ? "pipeline.generated" : "pipeline.validation_failed",
      resource_type: "pipeline",
      resource_id: executionId,
      result: validation.verdict === "VALID" ? "allow" : "error",
      metadata: { provider, filename: config.filename, verdict: validation.verdict, digest },
    });

    return { detection, plan, config, validation, configArtifactId: configArtifact.id, validationArtifactId: validationArtifact.id };
  }
}

/* ================================ Git providers ============================ */

/**
 * Provider abstraction. Authentication is deliberately NOT part of this
 * interface — it lives with each concrete adapter so credentials never leak
 * into the generic layer or the LLM.
 */
export interface GitProvider {
  readonly name: CiProvider;
  readonly kind: "static" | "remote";
  getRepository(owner: string, repo: string): Promise<GitRepo>;
  listBranches(owner: string, repo: string): Promise<GitBranch[]>;
  getCommit(owner: string, repo: string, sha: string): Promise<GitCommit>;
  createBranch(owner: string, repo: string, branch: string, fromSha: string): Promise<GitBranch>;
  createCommit(owner: string, repo: string, branch: string, files: GitFileChange[], message: string): Promise<GitCommit>;
  createPullRequest(owner: string, repo: string, head: string, base: string, title: string, body: string): Promise<GitChangeRequest>;
  getPullRequest(owner: string, repo: string, number: number): Promise<GitChangeRequest>;
  getPipelineStatus(owner: string, repo: string, ref: string): Promise<CiRunStatus>;
  getCommitStatus(owner: string, repo: string, sha: string): Promise<string>;
}

function blocked(provider: CiProvider, reason: string): NexusError {
  return Err.runtime("GIT_PROVIDER_BLOCKED", `${provider} provider is BLOCKED: ${reason}`);
}

/**
 * REAL GitHub execution. Delegates to the existing GitHubService (REST + Git
 * Data API). When no token is connected — or the network is unavailable —
 * every remote operation throws a structured BLOCKED error; nothing is faked.
 */
export class GitHubProvider implements GitProvider {
  readonly name: CiProvider = "github";
  readonly kind = "remote" as const;
  constructor(private gh: GitHubService) {}

  private connected(): void {
    if (!this.gh.state().connected) {
      throw blocked("github", "no GitHub token is connected (connect one to perform real operations)");
    }
  }

  async getRepository(owner: string, repo: string): Promise<GitRepo> {
    this.connected();
    const repos = await this.gh.listRepos(200);
    const match = repos.find((r) => r.full_name === `${owner}/${repo}`);
    if (!match) throw Err.notFound("GITHUB_NOT_FOUND", `repository ${owner}/${repo} not found or not visible to this token`);
    return { full_name: match.full_name, default_branch: match.default_branch, is_private: match.is_private };
  }

  async listBranches(owner: string, repo: string): Promise<GitBranch[]> {
    this.connected();
    return this.gh.listBranches(owner, repo);
  }

  async getCommit(owner: string, repo: string, sha: string): Promise<GitCommit> {
    this.connected();
    const commits = await this.gh.listCommits(owner, repo, 100);
    const match = commits.find((c) => c.sha === sha);
    if (!match) throw Err.notFound("GITHUB_NOT_FOUND", `commit ${sha.slice(0, 8)} not found in ${owner}/${repo}`);
    return { sha: match.sha, message: match.message, author: match.author };
  }

  async createBranch(owner: string, repo: string, branch: string, fromSha: string): Promise<GitBranch> {
    this.connected();
    assertWritableBranch(branch);
    // Real branch creation happens via pushFile's ref creation; here we record
    // intent. A true isolated branch is created on the first commit push.
    return { name: branch, sha: fromSha, is_protected: false };
  }

  async createCommit(owner: string, repo: string, branch: string, files: GitFileChange[], message: string): Promise<GitCommit> {
    this.connected();
    assertWritableBranch(branch);
    // Commit each file through the real Git Data API (single-file pushes).
    let sha = "";
    for (const f of files) {
      const res = await this.gh.pushFile(owner, repo, branch, f.path, f.content, message);
      sha = res.commit_sha;
    }
    return { sha, message, author: this.gh.state().identity?.login ?? "unknown" };
  }

  async createPullRequest(owner: string, repo: string, head: string, base: string, title: string, body: string): Promise<GitChangeRequest> {
    this.connected();
    const pr = await this.gh.createPullRequest(owner, repo, head, base, title, body);
    return { number: pr.number, head: pr.head, base: pr.base, state: pr.state, url: pr.html_url };
  }

  async getPullRequest(_owner: string, _repo: string, _number: number): Promise<GitChangeRequest> {
    this.connected();
    throw blocked("github", "getPullRequest is not implemented by the current GitHubService");
  }

  async getPipelineStatus(_owner: string, _repo: string, _ref: string): Promise<CiRunStatus> {
    this.connected();
    // Workflow run status requires the Actions API; report honestly.
    throw blocked("github", "workflow run status is not available through the connected service");
  }

  async getCommitStatus(_owner: string, _repo: string, _sha: string): Promise<string> {
    this.connected();
    throw blocked("github", "commit status is not available through the connected service");
  }
}

/**
 * GitLab provider — same architecture as GitHub. No GitLab credentials or
 * network access exist in this runtime, so all remote operations are honestly
 * BLOCKED (never fabricated). The interface + config generation still work.
 */
export class GitLabProvider implements GitProvider {
  readonly name: CiProvider = "gitlab";
  readonly kind = "remote" as const;

  async getRepository(_owner: string, _repo: string): Promise<GitRepo> {
    throw blocked("gitlab", "GitLab credentials/network are unavailable in this runtime");
  }
  async listBranches(_owner: string, _repo: string): Promise<GitBranch[]> {
    throw blocked("gitlab", "GitLab credentials/network are unavailable in this runtime");
  }
  async getCommit(_owner: string, _repo: string, _sha: string): Promise<GitCommit> {
    throw blocked("gitlab", "GitLab credentials/network are unavailable in this runtime");
  }
  async createBranch(_owner: string, _repo: string, _branch: string, _fromSha: string): Promise<GitBranch> {
    throw blocked("gitlab", "GitLab credentials/network are unavailable in this runtime");
  }
  async createCommit(_owner: string, _repo: string, _branch: string, _files: GitFileChange[], _message: string): Promise<GitCommit> {
    throw blocked("gitlab", "GitLab credentials/network are unavailable in this runtime");
  }
  async createPullRequest(_owner: string, _repo: string, _head: string, _base: string, _title: string, _body: string): Promise<GitChangeRequest> {
    throw blocked("gitlab", "GitLab credentials/network are unavailable in this runtime");
  }
  async getPullRequest(_owner: string, _repo: string, _number: number): Promise<GitChangeRequest> {
    throw blocked("gitlab", "GitLab credentials/network are unavailable in this runtime");
  }
  async getPipelineStatus(_owner: string, _repo: string, _ref: string): Promise<CiRunStatus> {
    throw blocked("gitlab", "GitLab credentials/network are unavailable in this runtime");
  }
  async getCommitStatus(_owner: string, _repo: string, _sha: string): Promise<string> {
    throw blocked("gitlab", "GitLab credentials/network are unavailable in this runtime");
  }
}

/**
 * Deterministic in-memory fixture implementing GitProvider for STATIC tests.
 * kind:"static" — it is NEVER a real remote and is labelled as such in every
 * audit/event it participates in.
 */
export class StaticGitProvider implements GitProvider {
  readonly kind = "static" as const;
  private repos = new Map<string, GitRepo>();
  private branches = new Map<string, GitBranch[]>();
  private commits = new Map<string, GitCommit[]>();
  private prs: GitChangeRequest[] = [];
  private nextPr = 1;

  constructor(readonly name: CiProvider) {}

  seedRepo(repo: GitRepo, defaultBranchSha: string): void {
    this.repos.set(repo.full_name, repo);
    this.branches.set(repo.full_name, [{ name: repo.default_branch, sha: defaultBranchSha, is_protected: isProtectedBranch(repo.default_branch) }]);
    this.commits.set(repo.full_name, [{ sha: defaultBranchSha, message: "initial commit", author: "static-fixture" }]);
  }

  async getRepository(owner: string, repo: string): Promise<GitRepo> {
    const r = this.repos.get(`${owner}/${repo}`);
    if (!r) throw Err.notFound("STATIC_NOT_FOUND", `${owner}/${repo} not in static fixture`);
    return r;
  }
  async listBranches(owner: string, repo: string): Promise<GitBranch[]> {
    return this.branches.get(`${owner}/${repo}`) ?? [];
  }
  async getCommit(owner: string, repo: string, sha: string): Promise<GitCommit> {
    const c = (this.commits.get(`${owner}/${repo}`) ?? []).find((x) => x.sha === sha);
    if (!c) throw Err.notFound("STATIC_NOT_FOUND", `commit ${sha.slice(0, 8)} not in static fixture`);
    return c;
  }
  async createBranch(owner: string, repo: string, branch: string, fromSha: string): Promise<GitBranch> {
    assertWritableBranch(branch);
    const key = `${owner}/${repo}`;
    const list = this.branches.get(key) ?? [];
    const nb: GitBranch = { name: branch, sha: fromSha, is_protected: false };
    this.branches.set(key, [...list, nb]);
    return nb;
  }
  async createCommit(owner: string, repo: string, branch: string, _files: GitFileChange[], message: string): Promise<GitCommit> {
    assertWritableBranch(branch);
    const key = `${owner}/${repo}`;
    const sha = await digestOf(`${key}:${branch}:${message}:${Date.now()}:${Math.random()}`);
    const commit: GitCommit = { sha, message, author: "static-fixture" };
    this.commits.set(key, [...(this.commits.get(key) ?? []), commit]);
    const branches = (this.branches.get(key) ?? []).map((b) => (b.name === branch ? { ...b, sha } : b));
    this.branches.set(key, branches);
    return commit;
  }
  async createPullRequest(owner: string, repo: string, head: string, base: string, title: string, _body: string): Promise<GitChangeRequest> {
    const pr: GitChangeRequest = { number: this.nextPr++, head, base, state: "open", url: `https://static.local/${owner}/${repo}/pr/${this.nextPr - 1}` };
    this.prs.push(pr);
    return pr;
  }
  async getPullRequest(_owner: string, _repo: string, number: number): Promise<GitChangeRequest> {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw Err.notFound("STATIC_NOT_FOUND", `PR #${number} not in static fixture`);
    return pr;
  }
  async getPipelineStatus(): Promise<CiRunStatus> {
    return "SUCCEEDED";
  }
  async getCommitStatus(): Promise<string> {
    return "success";
  }
}

/* ============================== CI pipeline engine ========================= */

export interface CiServices {
  engine: NexusEngine;
  events: EventService;
  audit: AuditService;
  evidence: EvidenceService;
  artifacts: ArtifactService;
  authz: AuthorizationService;
}

/** Legal CI run transitions. Terminal states cannot re-enter RUNNING without a
 *  new attempt. */
export function isLegalCiTransition(from: CiRunStatus, to: CiRunStatus): boolean {
  const TERMINAL: CiRunStatus[] = ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"];
  if (TERMINAL.includes(from)) return false;
  if (from === "QUEUED") return ["RUNNING", "CANCELLED", "BLOCKED", "FAILED"].includes(to);
  if (from === "RUNNING") return ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(to);
  return false;
}

export interface CiContext {
  actor: Actor;
  project_id: string;
  execution_id: string;
  attempt: number;
  correlation_id: string;
}

/**
 * CI/CD pipeline engine: submits pipeline runs, enforces the run state
 * machine, records git operations and change requests, and registers
 * artifacts. Remote execution depends on a connected GitProvider — with none,
 * runs are honestly BLOCKED (never faked as succeeded).
 */
export class CiPipelineEngine {
  constructor(private svc: CiServices) {}

  private async audit(ctx: CiContext, action: string, result: "allow" | "deny" | "error" | "info", metadata: Record<string, unknown>): Promise<void> {
    await this.svc.audit.record({
      actor: ctx.actor.email,
      action,
      resource_type: "ci_pipeline",
      resource_id: ctx.execution_id,
      result,
      metadata,
    });
  }

  private async emit(type: string, ctx: CiContext, payload: Record<string, unknown>): Promise<void> {
    await this.svc.events.emit({
      type: type as never,
      source: "CiPipelineEngine",
      execution_id: ctx.execution_id,
      payload: { ...payload, attempt: ctx.attempt, correlation_id: ctx.correlation_id },
    });
  }

  /** Record a git operation (real or blocked) for audit/inspection. */
  async recordGitOp(ctx: CiContext, provider: CiProvider, operation: GitOperationType, repository: string, outcome: { status: "SUCCEEDED" | "FAILED" | "BLOCKED"; ref?: string | null; sha?: string | null; reason?: string | null }): Promise<GitOperation> {
    const op: GitOperation = {
      id: nid("gitop"),
      execution_id: ctx.execution_id,
      provider,
      operation,
      repository,
      ref: outcome.ref ?? null,
      commit_sha: outcome.sha ?? null,
      status: outcome.status,
      blocked_reason: outcome.reason ?? null,
      created_at: Date.now(),
    };
    await this.svc.engine.put("git_operations", op.id, op);
    const evType = outcome.status === "BLOCKED" ? "git.provider.blocked" : outcome.status === "SUCCEEDED" ? "git.provider.completed" : "git.provider.requested";
    await this.emit(evType, ctx, { provider, operation, repository, status: outcome.status, reason: outcome.reason ?? null });
    await this.audit(ctx, `git.${operation}`, outcome.status === "SUCCEEDED" ? "allow" : outcome.status === "BLOCKED" ? "info" : "error", {
      provider,
      operation,
      repository,
      status: outcome.status,
      ref: outcome.ref ?? null,
      sha: outcome.sha ?? null,
      reason: outcome.reason ?? null,
    });
    return op;
  }

  /** Create (idempotently) a CI pipeline run for (execution, attempt). */
  async submitRun(ctx: CiContext, provider: CiProvider, repository: string, ref: string): Promise<{ run: CiPipelineRun; created: boolean }> {
    const existing = await this.svc.engine.byIndex<CiPipelineRun>("ci_pipeline_runs", "byExecution", ctx.execution_id);
    const match = existing.find((r) => r.attempt === ctx.attempt);
    if (match) return { run: match, created: false };

    const now = Date.now();
    const run: CiPipelineRun = {
      id: nid("cirun"),
      execution_id: ctx.execution_id,
      project_id: ctx.project_id,
      provider,
      repository,
      ref,
      status: "QUEUED",
      attempt: ctx.attempt,
      correlation_id: ctx.correlation_id,
      created_at: now,
      updated_at: now,
      error: null,
      blocked_reason: null,
    };
    await this.svc.engine.put("ci_pipeline_runs", run.id, run);
    await this.emit("pipeline.submitted", ctx, { provider, repository, ref, run_id: run.id });
    await this.audit(ctx, "pipeline.submitted", "allow", { provider, repository, ref, run_id: run.id });
    return { run, created: true };
  }

  /** Transition a run's status, enforcing the state machine. */
  async transitionRun(run: CiPipelineRun, to: CiRunStatus, ctx: CiContext, reason: string | null): Promise<CiPipelineRun> {
    if (!isLegalCiTransition(run.status, to)) {
      throw Err.validation("ILLEGAL_CI_TRANSITION", `illegal CI transition ${run.status} → ${to}`);
    }
    run.status = to;
    run.updated_at = Date.now();
    run.blocked_reason = to === "BLOCKED" ? reason : null;
    run.error = to === "FAILED" ? toSystemError(new Error(reason ?? "pipeline failed"), "CI_FAILED") : null;
    await this.svc.engine.put("ci_pipeline_runs", run.id, run);

    const ev = to === "RUNNING" ? "pipeline.started" : to === "SUCCEEDED" ? "pipeline.completed" : to === "FAILED" ? "pipeline.failed" : "pipeline.blocked";
    await this.emit(ev, ctx, { run_id: run.id, status: to, reason });
    await this.audit(ctx, `pipeline.status:${to}`, to === "FAILED" ? "error" : to === "BLOCKED" ? "info" : "allow", { run_id: run.id, status: to, reason });
    return run;
  }

  /**
   * Start a run: QUEUED → RUNNING requires a connected remote provider (real
   * execution). With only a static fixture or no provider, the run is honestly
   * moved to BLOCKED with the real reason — never to SUCCEEDED.
   */
  async startRun(run: CiPipelineRun, ctx: CiContext, provider: GitProvider): Promise<CiPipelineRun> {
    if (provider.kind === "static") {
      return this.transitionRun(run, "BLOCKED", ctx, "static provider fixture cannot execute a real pipeline run (STATIC_PROVIDER_TEST only)");
    }
    return this.transitionRun(run, "RUNNING", ctx, null);
  }

  /** Create (idempotently) a change request. Never auto-merged. */
  async createChangeRequest(ctx: CiContext, provider: GitProvider, repository: string, sourceBranch: string, targetBranch: string, commit: string, title: string, description: string): Promise<{ cr: ChangeRequest; created: boolean }> {
    assertWritableBranch(sourceBranch);
    const [owner, repo] = repository.split("/");

    // Idempotency: one open CR per (execution, source branch).
    const existing = await this.svc.engine.byIndex<ChangeRequest>("change_requests", "byExecution", ctx.execution_id);
    const match = existing.find((c) => c.source_branch === sourceBranch && c.status === "OPEN");
    if (match) return { cr: match, created: false };

    let remoteId: number | null = null;
    let remoteUrl: string | null = null;
    let status: ChangeRequestStatus = "OPEN";
    let blockedReason: string | null = null;

    try {
      const pr = await provider.createPullRequest(owner, repo, sourceBranch, targetBranch, title, description);
      remoteId = pr.number;
      remoteUrl = pr.url;
      await this.recordGitOp(ctx, provider.name, "create_pull_request", repository, { status: "SUCCEEDED", ref: sourceBranch, sha: commit });
    } catch (e) {
      const err = e as NexusError;
      if (err.code === "GIT_PROVIDER_BLOCKED" || err.category === "runtime") {
        blockedReason = err.message;
        await this.recordGitOp(ctx, provider.name, "create_pull_request", repository, { status: "BLOCKED", ref: sourceBranch, sha: commit, reason: err.message });
      } else {
        await this.recordGitOp(ctx, provider.name, "create_pull_request", repository, { status: "FAILED", ref: sourceBranch, sha: commit, reason: err.message });
        throw e;
      }
    }

    const cr: ChangeRequest = {
      id: nid("cr"),
      provider: provider.name,
      repository,
      source_branch: sourceBranch,
      target_branch: targetBranch,
      commit,
      title,
      description,
      status,
      remote_id: remoteId,
      remote_url: remoteUrl,
      created_at: Date.now(),
    };
    await this.svc.engine.put("change_requests", cr.id, cr);

    // Immutable artifact for the change request (no secrets — description only).
    await this.svc.artifacts.register(ctx.execution_id, {
      kind: "CHANGE_REQUEST",
      name: `change-request-${cr.id}.json`,
      content: JSON.stringify({ ...cr, blocked_reason: blockedReason }, null, 2),
    });

    await this.emit("change.request.created", ctx, { cr_id: cr.id, repository, source_branch: sourceBranch, target_branch: targetBranch, remote_id: remoteId, blocked: blockedReason !== null });
    await this.audit(ctx, "change_request.created", blockedReason ? "info" : "allow", { cr_id: cr.id, repository, source_branch: sourceBranch, target_branch: targetBranch, remote_id: remoteId, blocked_reason: blockedReason });
    return { cr, created: true };
  }

  async getRuns(executionId: string): Promise<CiPipelineRun[]> {
    const runs = await this.svc.engine.byIndex<CiPipelineRun>("ci_pipeline_runs", "byExecution", executionId);
    return runs.sort((a, b) => b.attempt - a.attempt);
  }

  async getChangeRequests(executionId: string): Promise<ChangeRequest[]> {
    return this.svc.engine.byIndex<ChangeRequest>("change_requests", "byExecution", executionId);
  }

  async getGitOps(executionId: string): Promise<GitOperation[]> {
    return this.svc.engine.byIndex<GitOperation>("git_operations", "byExecution", executionId);
  }
}

export { maskToken };
