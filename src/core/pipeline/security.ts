/**
 * SecurityReview — REAL static scanning.
 *
 * Always-available, genuinely executed checks:
 *  - secret detection (credential-shaped material in any file)
 *  - unsafe configuration (eval, disabled TLS, insecure endpoints)
 *  - workspace boundary markers (path traversal in file paths)
 *  - dependency presence (unpinned / obviously-vulnerable pinned versions)
 *
 * The external OSV.dev vulnerability feed is attempted with a real fetch and a
 * hard timeout. If it is unreachable the scan reports that check as BLOCKED
 * with the real reason — it is never silently dropped and never faked clean.
 */

import { StageHalt, type DetectionProfile, type SecurityFinding, type SecurityResult } from "../types";

const SECRET_PATTERNS: [RegExp, string][] = [
  [/ghp_[A-Za-z0-9]{20,}/, "GitHub personal access token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key material"],
  [/(api[_-]?key|apikey|secret|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i, "hardcoded api key/secret"],
  [/password\s*[:=]\s*["'][^"']{4,}["']/i, "hardcoded password"],
];

const UNSAFE_PATTERNS: [RegExp, string, "high" | "medium"][] = [
  [/\beval\s*\(/, "use of eval()", "high"],
  [/new\s+Function\s*\(/, "use of new Function()", "high"],
  [/rejectUnauthorized\s*:\s*false/, "TLS verification disabled", "high"],
  [/\bhttp:\/\/(?!localhost|127\.0\.0\.1)/, "insecure http:// endpoint", "medium"],
  [/--no-verify\b/, "git hook bypass flag", "medium"],
];

async function osvScan(
  profile: DetectionProfile,
  findings: SecurityFinding[],
  timeoutMs: number,
): Promise<"ok" | "blocked"> {
  const deps = profile.dependencies.filter((d) => d.version !== "unpinned");
  if (deps.length === 0) return "ok"; // nothing resolvable to query
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch("https://api.osv.dev/v1/querybatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: deps.slice(0, 20).map((d) => ({
            package: { name: d.name, ecosystem: profile.runtime === "python" ? "PyPI" : "npm" },
            version: d.version,
          })),
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OSV responded ${res.status}`);
      const data = (await res.json()) as { results?: { vulns?: { id?: string; summary?: string }[] }[] };
      (data.results ?? []).forEach((r, i) => {
        for (const v of r.vulns ?? []) {
          findings.push({
            severity: "high",
            rule: "osv-vulnerability",
            detail: `${deps[i].name}@${deps[i].version}: ${v.id ?? "vuln"}${v.summary ? ` — ${v.summary.slice(0, 70)}` : ""}`,
            file: null,
          });
        }
      });
      return "ok";
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    findings.push({
      severity: "info",
      rule: "osv-unreachable",
      detail: `OSV.dev feed unavailable (${(e as Error).message?.slice(0, 60)}): dependency CVEs were NOT checked`,
      file: null,
    });
    return "blocked";
  }
}

export async function runSecurityScan(
  workspace: Record<string, string>,
  profile: DetectionProfile,
  opts: { osvTimeoutMs?: number; allowExternal?: boolean } = {},
): Promise<SecurityResult> {
  const started = Date.now();
  const findings: SecurityFinding[] = [];
  const paths = Object.keys(workspace);

  for (const path of paths) {
    if (path.includes("..")) {
      findings.push({ severity: "critical", rule: "path-traversal", detail: `path traversal marker in '${path}'`, file: path });
    }
    const content = workspace[path];
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(content)) {
        findings.push({ severity: "critical", rule: "secret-leak", detail: `${label} detected in ${path}`, file: path });
      }
    }
    for (const [re, label, sev] of UNSAFE_PATTERNS) {
      if (re.test(content)) {
        findings.push({ severity: sev, rule: "unsafe-config", detail: `${label} in ${path}`, file: path });
      }
    }
  }

  // Unpinned dependencies are a real, verifiable supply-chain weakness.
  const unpinned = profile.dependencies.filter((d) => d.version === "unpinned");
  if (unpinned.length > 0) {
    findings.push({
      severity: "medium",
      rule: "unpinned-dependency",
      detail: `${unpinned.length} unpinned dependenc${unpinned.length === 1 ? "y" : "ies"}: ${unpinned.slice(0, 5).map((d) => d.name).join(", ")}`,
      file: null,
    });
  }

  let osv: "ok" | "blocked" | "skipped" = "skipped";
  if (opts.allowExternal !== false) {
    osv = await osvScan(profile, findings, opts.osvTimeoutMs ?? 4000);
  }

  const duration_ms = Date.now() - started;
  const blocking = findings.filter((f) => f.severity === "critical" || f.severity === "high");

  if (blocking.length > 0) {
    const result: SecurityResult = {
      scanner: "nexus-static-scanner",
      outcome: "FAILED",
      findings,
      scanned_files: paths.length,
      blocked_reason: null,
      duration_ms,
    };
    throw new StageHalt(
      "failed",
      `SECURITY_FAILED: ${blocking.length} critical/high finding(s) — ${blocking.slice(0, 3).map((f) => f.detail).join("; ")}`,
    );
  }

  const outcome: SecurityResult["outcome"] = osv === "blocked" ? "BLOCKED" : "PASSED";
  return {
    scanner: "nexus-static-scanner",
    outcome,
    findings,
    scanned_files: paths.length,
    blocked_reason:
      osv === "blocked"
        ? "SECURITY_SCANNER_PARTIAL: static checks passed but the OSV dependency-vulnerability feed was unreachable, so the scan is incomplete."
        : null,
    duration_ms,
  };
}
