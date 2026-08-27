import { NexusEngine } from "./db";
import { SecurityApi } from "./security-api";
import {
  SecurityEvidence,
  SecurityFinding,
  SecurityScannerCategory,
  SecurityEvidenceStatus,
} from "./types";
import { spawn } from "child_process";
import {
  sastAdapter,
  scaAdapter,
  secretAdapter,
  iacAdapter,
  trivyAdapter,
  sbomAdapter,
  dastAdapter,
  supplyChainAdapter,
  ScannerAdapter,
} from "./security-normalizer";

export interface ScannerRunResult {
  scanner: string;
  category: SecurityScannerCategory;
  status: "PASS" | "FAIL" | "BLOCKED";
  duration_ms: number;
  evidence_id?: string;
  findings_count: number;
  blocked_reason?: string;
  error_code?: string;
}

export interface ScannerRunSummary {
  execution_id: string;
  results: ScannerRunResult[];
}

interface ScannerDefinition {
  scanner: string;
  category: SecurityScannerCategory;
  command: string;
  args: string[];
  adapter: ScannerAdapter;
  timeoutMs: number;
  strategy: "LOCAL_EXECUTABLE" | "NPM" | "DOCKER" | "INTERNAL";
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function resolveCommand(command: string): string {
  if (isWindows() && (command === "npm" || command === "npx")) {
    return `${command}.cmd`;
  }
  return command;
}

function requiresShell(command: string): boolean {
  return isWindows() && command.endsWith(".cmd");
}

const SCANNERS: ScannerDefinition[] = [
  {
    scanner: "semgrep",
    category: "SAST",
    command: "semgrep",
    args: ["--config=auto", ".", "--json"],
    adapter: sastAdapter,
    timeoutMs: 120000,
    strategy: "LOCAL_EXECUTABLE",
  },
  {
    scanner: "gitleaks",
    category: "SECRET",
    command: "gitleaks",
    args: ["detect", "--source", ".", "--report-format", "json"],
    adapter: secretAdapter,
    timeoutMs: 120000,
    strategy: "LOCAL_EXECUTABLE",
  },
  {
    scanner: "npm-audit",
    category: "SCA",
    command: "npm",
    args: ["audit", "--json"],
    adapter: scaAdapter,
    timeoutMs: 120000,
    strategy: "NPM",
  },
  {
    scanner: "trivy",
    category: "CONTAINER",
    command: "trivy",
    args: ["fs", ".", "--format", "json", "--skip-db-update", "--scanners", "vuln,secret,misconfig", "--no-progress"],
    adapter: trivyAdapter,
    timeoutMs: 60000,
    strategy: "LOCAL_EXECUTABLE",
  },
  {
    scanner: "trivy-sbom",
    category: "SBOM",
    command: "trivy",
    args: ["fs", ".", "--format", "cyclonedx", "--skip-db-update", "--no-progress"],
    adapter: sbomAdapter,
    timeoutMs: 120000,
    strategy: "LOCAL_EXECUTABLE",
  },
  {
    scanner: "trivy-config",
    category: "IAC",
    command: "trivy",
    args: ["config", ".", "--format", "json", "--skip-db-update", "--no-progress"],
    adapter: iacAdapter,
    timeoutMs: 120000,
    strategy: "LOCAL_EXECUTABLE",
  },
  {
    scanner: "dast",
    category: "DAST",
    command: "INTERNAL_DAST",
    args: [],
    adapter: dastAdapter,
    timeoutMs: 120000,
    strategy: "INTERNAL",
  },
  {
    scanner: "supply-chain",
    category: "SUPPLY_CHAIN",
    command: "INTERNAL_SUPPLY_CHAIN",
    args: [],
    adapter: supplyChainAdapter,
    timeoutMs: 120000,
    strategy: "INTERNAL",
  },
];

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function runInternalDastScan(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const res = await fetch("http://localhost:3000", { method: "HEAD" });
    const requiredHeaders = [
      "content-security-policy",
      "x-content-type-options",
      "strict-transport-security",
      "x-frame-options",
    ];
    const missing = requiredHeaders.filter((h) => !res.headers.get(h));
    const findings = missing.map((h) => ({
      title: `Missing security header: ${h}`,
      severity: "MEDIUM",
    }));
    return {
      stdout: JSON.stringify({ blocked: false, findings }),
      stderr: "",
      exitCode: findings.length > 0 ? 1 : 0,
    };
  } catch (e: any) {
    return {
      stdout: JSON.stringify({ blocked: true, findings: [] }),
      stderr: e?.message || "DAST target unreachable",
      exitCode: 1,
    };
  }
}

async function runInternalSupplyChainCheck(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const fs = await import("fs/promises");
    const content = await fs.readFile("package-lock.json", "utf8");
    const parsed = JSON.parse(content);
    if (parsed && parsed.lockfileVersion) {
      return { stdout: JSON.stringify({ status: "PASS" }), stderr: "", exitCode: 0 };
    }
    return { stdout: JSON.stringify({ status: "FAIL", reason: "Invalid lockfile" }), stderr: "", exitCode: 1 };
  } catch (e: any) {
    return {
      stdout: JSON.stringify({ status: "BLOCKED" }),
      stderr: e?.message || "package-lock.json missing",
      exitCode: 1,
    };
  }
}

async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let child;

    if (requiresShell(command)) {
      const fullCommand = [command, ...args].join(" ");
      child = spawn(fullCommand, {
        cwd: process.cwd(),
        env: process.env,
        timeout: timeoutMs,
        windowsHide: true,
        shell: true,
      });
    } else {
      child = spawn(command, args, {
        cwd: process.cwd(),
        env: process.env,
        timeout: timeoutMs,
        windowsHide: true,
        shell: false,
      });
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutObj = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err: any) => {
      clearTimeout(timeoutObj);
      if (err.code === "ENOENT") {
        reject({ code: "COMMAND_NOT_FOUND", message: `Command not found: ${command}` });
      } else {
        reject({ code: "PROCESS_START_FAILURE", message: err.message });
      }
    });

    child.on("close", (code) => {
      clearTimeout(timeoutObj);
      if (timedOut) {
        reject({ code: "PROCESS_TIMEOUT", message: `Process timed out after ${timeoutMs}ms` });
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

export class SecurityScannerRunner {
  constructor(private engine: NexusEngine, private api: SecurityApi) {}

  async runAll(
    executionId: string,
    projectId: string,
    commitSha: string,
    artifactDigest?: string,
    releaseId?: string,
  ): Promise<ScannerRunSummary> {
    const results: ScannerRunResult[] = [];

    for (const def of SCANNERS) {
      const started = Date.now();
      const evidenceBase = {
        project_id: projectId,
        execution_id: executionId,
        release_id: releaseId,
        commit_sha: commitSha,
        artifact_digest: artifactDigest,
        environment: "local",
        scanner: def.scanner,
        category: def.category,
        started_at: new Date(started).toISOString(),
      };

      let status: SecurityEvidenceStatus = "UNKNOWN";
      let findings: Partial<SecurityFinding>[] = [];
      let blockedReason: string | undefined;
      let errorCode: string | undefined;

      try {
        let stdout = "";
        let stderr = "";
        let exitCode = 0;

        if (def.strategy === "INTERNAL") {
          if (def.command === "INTERNAL_DAST") {
            const res = await runInternalDastScan();
            stdout = res.stdout;
            stderr = res.stderr;
            exitCode = res.exitCode;
          } else if (def.command === "INTERNAL_SUPPLY_CHAIN") {
            const res = await runInternalSupplyChainCheck();
            stdout = res.stdout;
            stderr = res.stderr;
            exitCode = res.exitCode;
          }
        } else {
          const resolvedCommand = resolveCommand(def.command);
          const proc = await runProcess(resolvedCommand, def.args, def.timeoutMs);
          stdout = proc.stdout;
          stderr = proc.stderr;
          exitCode = proc.exitCode;
        }

        const combined = `${stdout}\n${stderr}`;
        if (combined.includes("npm error code E404") || combined.includes("could not determine executable to run")) {
          status = "BLOCKED";
          errorCode = "PACKAGE_NOT_FOUND";
          blockedReason = combined.slice(0, 200);
        } else {
          const raw = safeJsonParse(stdout) ?? stdout;
          const adapterStatus = def.adapter.normalize(raw, { scanner: def.scanner, category: def.category });

          if (adapterStatus === "UNKNOWN") {
            if (exitCode !== 0) {
              status = "FAIL";
              errorCode = "NON_ZERO_EXIT";
              blockedReason = stderr?.trim() || `Process exited with code ${exitCode}`;
            } else {
              status = "PASS";
            }
          } else {
            status = adapterStatus;
            if (def.adapter.extractFindings) {
              findings = def.adapter.extractFindings(raw);
            }
          }
        }
      } catch (e: any) {
        const code = e?.code || "UNKNOWN";
        errorCode = code;
        if (code === "COMMAND_NOT_FOUND" || code === "PROCESS_START_FAILURE") {
          status = "BLOCKED";
          blockedReason = e?.message || "Process failed to start";
        } else if (code === "PROCESS_TIMEOUT") {
          status = "BLOCKED";
          blockedReason = e?.message || "Process timed out";
        } else {
          status = "BLOCKED";
          blockedReason = e?.message || "Unknown process error";
        }
      }

      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - started;

      const evidence = await this.api.ingestEvidence({
        ...evidenceBase,
        status,
        completed_at: completedAt,
        duration_ms: durationMs,
      });

      if (findings.length > 0 && status === "FAIL") {
        await this.api.ingestFindings(evidence, findings);
      }

      results.push({
        scanner: def.scanner,
        category: def.category,
        status: status as "PASS" | "FAIL" | "BLOCKED",
        duration_ms: durationMs,
        evidence_id: evidence.id,
        findings_count: findings.length,
        blocked_reason: blockedReason,
        error_code: errorCode,
      });
    }

    return { execution_id: executionId, results };
  }
}