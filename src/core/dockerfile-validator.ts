// src/core/dockerfile-validator.ts
//
// Deterministic Dockerfile validator. Operates ONLY on Dockerfile text — never
// executes any instruction, never spawns a process, never touches the host.
// Caller maps verdict to stage status:
//   PASS    -> SUCCEEDED
//   WARN    -> SUCCEEDED  (WARN is not a failure)
//   FAIL    -> FAILED
//   BLOCKED -> BLOCKED

import type {
  DockerfileSource,
  DockerfileValidationFinding,
  DockerfileValidationResult,
} from "./types";

const KNOWN_INSTRUCTIONS = new Set([
  "FROM", "RUN", "CMD", "LABEL", "MAINTAINER", "EXPOSE", "ENV", "ADD", "COPY",
  "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL",
  "HEALTHCHECK", "SHELL",
]);

interface Instruction {
  name: string;
  args: string;
  line: number;
  raw: string;
}

function parse(content: string): Instruction[] {
  const out: Instruction[] = [];
  const physical = content.split(/\r?\n/);
  let i = 0;
  while (i < physical.length) {
    const firstLine = i + 1;
    const raw = physical[i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) { i++; continue; }
    let combined = physical[i];
    while (combined.trimEnd().endsWith("\\") && i + 1 < physical.length) {
      i++;
      combined = combined.trimEnd().slice(0, -1) + " " + physical[i];
    }
    const m = combined.match(/^\s*([A-Za-z]+)(\s+([\s\S]*))?$/);
    if (m) {
      out.push({
        name: m[1].toUpperCase(),
        args: (m[3] ?? "").trim(),
        line: firstLine,
        raw: raw.length > 400 ? raw.slice(0, 400) + "..." : raw,
      });
    }
    i++;
  }
  return out;
}

function looksLikeHardcodedSecret(key: string, value: string): boolean {
  const v = value.trim().replace(/^["']|["']$/g, "");
  if (v === "") return false;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v)) return false;
  const upperKey = key.toUpperCase();
  if (!/(SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)/.test(upperKey)) return false;
  if (/^(sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[bpoa]-)/.test(v)) return true;
  if (/^AKIA[0-9A-Z]{16}/.test(v)) return true;
  if (/^[A-Za-z0-9_\-/+]{16,}$/.test(v)) return true;
  return false;
}

function parseEnvPairs(s: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const trimmed = s.trim();
  if (trimmed.includes("=")) {
    for (const part of trimmed.split(/\s+/)) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      out.push({ key: part.slice(0, eq), value: part.slice(eq + 1) });
    }
  } else {
    const sp = trimmed.indexOf(" ");
    if (sp > 0) out.push({ key: trimmed.slice(0, sp), value: trimmed.slice(sp + 1) });
  }
  return out;
}

function parseArgPairs(s: string): { key: string; value: string }[] {
  const eq = s.indexOf("=");
  if (eq < 0) return [{ key: s.trim(), value: "" }];
  return [{ key: s.slice(0, eq).trim(), value: s.slice(eq + 1).trim() }];
}

export function validateDockerfile(source: DockerfileSource | null | undefined): DockerfileValidationResult {
  const findings: DockerfileValidationFinding[] = [];
  const add = (
    rule: string,
    severity: "info" | "warn" | "fail",
    evidence: string,
    location: string,
    recommendation: string,
  ) => {
    findings.push({ rule, severity, evidence, location, recommendation });
  };

  if (!source || typeof source.content !== "string" || source.content.trim().length === 0) {
    return { verdict: "BLOCKED", findings };
  }

  const ins = parse(source.content);
  const hasFrom = ins.some((x) => x.name === "FROM");
  const userValues = ins.filter((x) => x.name === "USER").map((x) => x.args.trim().toLowerCase());

  // ---------- FAIL rules ----------
  if (!hasFrom) {
    add("dockerfile.from.missing", "fail", "no FROM instruction found", "line 1",
        "Add a FROM <image>:<tag> as the first instruction.");
  }

  for (const x of ins) {
    if (x.name === "FROM" && x.args === "") {
      add("dockerfile.from.malformed", "fail", x.raw, "line " + x.line,
          "FROM requires an image reference, e.g. FROM node:20-alpine.");
    }
  }

  for (const x of ins) {
    if (/--privileged\b/.test(x.args)) {
      add("dockerfile.privileged", "fail", x.raw, "line " + x.line,
          "Remove --privileged; build/run steps must never elevate.");
    }
    if (/\/var\/run\/docker\.sock/.test(x.args)) {
      add("dockerfile.docker-socket", "fail", x.raw, "line " + x.line,
          "Never reference the Docker socket inside an image.");
    }
    if (x.name === "RUN") {
      if (/\brm\s+-rf\s+\/(\s|$)/.test(x.args) || /\bchmod\s+(-R\s+)?777\s+\//.test(x.args)) {
        add("dockerfile.destructive", "fail", x.raw, "line " + x.line,
            "Destructive filesystem command detected; narrow the target path.");
      }
      if (/(curl|wget)\b[^|]*\|\s*(ba)?sh\b/.test(x.args)) {
        add("dockerfile.remote-shell", "fail", x.raw, "line " + x.line,
            "Piping a remote download into a shell is unsafe; verify a checksum first.");
      }
    }
    if (x.name === "ENV" || x.name === "ARG") {
      const pairs = x.name === "ENV" ? parseEnvPairs(x.args) : parseArgPairs(x.args);
      for (const p of pairs) {
        if (looksLikeHardcodedSecret(p.key, p.value)) {
          add("dockerfile.embedded-secret", "fail", x.raw.replace(p.value, "***"), "line " + x.line,
              "Do not bake credentials into the image; pass them at runtime.");
        }
      }
    }
  }

  // ---------- WARN rules ----------
  if (hasFrom && userValues.length === 0) {
    add("dockerfile.user.missing", "warn", "no USER instruction", "line 1",
        "Container runs as root by default; add a non-root USER.");
  } else if (userValues.length > 0 && userValues.every((v) => v === "root" || v === "0")) {
    add("dockerfile.user.root", "warn", "USER " + userValues.join(" "), "line 1",
        "USER is root; switch to a non-root account.");
  }

  for (const x of ins) {
    if (x.name === "FROM" && /:latest(\s|$)/.test(x.args)) {
      add("dockerfile.latest-tag", "warn", x.raw, "line " + x.line,
          "Pin a specific version instead of :latest.");
    }
  }

  for (const x of ins) {
    if (x.name === "RUN") {
      if (/\bapt-get\s+install\b/.test(x.args) && !/--no-install-recommends\b/.test(x.args)) {
        add("dockerfile.apt-get.no-install-recommends", "warn", x.raw, "line " + x.line,
            "Add --no-install-recommends to reduce image size and attack surface.");
      }
      if (/\bapt-get\s+install\b/.test(x.args) && !/rm\s+-rf\s+\/var\/lib\/apt\/lists/.test(x.args)) {
        add("dockerfile.apt-get.cache", "warn", x.raw, "line " + x.line,
            "Clear /var/lib/apt/lists/* in the same RUN to avoid shipping caches.");
      }
    }
  }

  for (const x of ins) {
    if (!KNOWN_INSTRUCTIONS.has(x.name)) {
      add("dockerfile.unknown-instruction", "warn", x.raw, "line " + x.line,
          "Unknown instruction '" + x.name + "'. Check the spelling.");
    }
  }

  // ---------- INFO rules ----------
  if (hasFrom && !ins.some((x) => x.name === "HEALTHCHECK")) {
    add("dockerfile.healthcheck.missing", "info", "", "line 1",
        "Consider HEALTHCHECK for runtime health probing (optional).");
  }

  // ---------- Verdict ----------
  let verdict: "PASS" | "WARN" | "FAIL" = "PASS";
  if (findings.some((f) => f.severity === "fail")) verdict = "FAIL";
  else if (findings.some((f) => f.severity === "warn")) verdict = "WARN";

  return { verdict, findings };
}
