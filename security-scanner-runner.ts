import { SecurityApi } from "./security-api";
import { CapabilityDetector, Capability } from "./capability-detector";

export interface ScannerResult {
  scanner: string;
  status: "PASS" | "FAIL" | "BLOCKED" | "SKIPPED" | "ERROR";
  started_at: string;
  completed_at: string;
  duration_ms: number;
  command_identity: string;
  target: string | null;
  findings: any[];
  artifact_references?: {
    artifact_id?: string;
    image_ref?: string;
    image_digest?: string;
    commit_sha?: string;
    release_id?: string;
    signature_identity?: string;
  };
  error_reason?: string | null;
  blocked_reason?: string | null;
  [key: string]: any;
}

export class SecurityScannerRunner {
  private engine: any;
  private api: SecurityApi;
  private capabilityDetector: CapabilityDetector;
  private capabilities: Capability[] = [];

  constructor(engine: any, api: SecurityApi) {
    this.engine = engine;
    this.api = api;
    this.capabilityDetector = new CapabilityDetector();
  }

  async initialize(): Promise<void> {
    this.capabilities = await this.capabilityDetector.detect();
  }

  private isCapabilityAvailable(name: string): boolean {
    const cap = this.capabilities.find(c => c.name === name);
    return cap?.available ?? false;
  }

  private getCapabilityReason(name: string): string | null {
    const cap = this.capabilities.find(c => c.name === name);
    return cap?.reason ?? null;
  }

  private async runScanner(
    scanner: string,
    args: string[],
    timeoutMs = 180000
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const { spawn } = require("node:child_process");
      const child = spawn(scanner, args, { shell: false, windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ exitCode: 124, stdout, stderr: stderr + "\n[timeout]" });
      }, timeoutMs);
      child.stdout.on("data", (d: any) => (stdout += d.toString()));
      child.stderr.on("data", (d: any) => (stderr += d.toString()));
      child.on("error", (err: any) => {
        clearTimeout(timer);
        resolve({ exitCode: 1, stdout, stderr: String(err) });
      });
      child.on("close", (code: number) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }

  async runAll(
    executionId: string,
    projectId: string,
    commit: string,
    artifactDigest?: string,
    releaseId?: string
  ): Promise<ScannerResult[]> {
    await this.initialize();

    const results: ScannerResult[] = [];
    const target = artifactDigest
      ? `localhost:5000/nexus/nexus-app@sha256:${artifactDigest}`
      : projectId;

    const scanners = [
      { name: "semgrep", capability: "semgrep", command: "semgrep", args: ["--json", "--quiet", "."] },
      { name: "gitleaks", capability: "gitleaks", command: "gitleaks", args: ["detect", "--source", "."] },
      { name: "npm-audit", capability: "npm", command: "npm", args: ["audit", "--json"] },
      { name: "trivy", capability: "trivy", command: "trivy", args: ["image", "--format", "json", "--exit-code", "0", target] },
      { name: "trivy-sbom", capability: "trivy", command: "trivy", args: ["sbom", "--format", "cyclonedx", target] },
      { name: "trivy-config", capability: "trivy", command: "trivy", args: ["config", "--format", "json", "."] },
      { name: "dast", capability: "playwright", command: "npx", args: ["playwright", "test"] },
      { name: "supply-chain", capability: "npm", command: "npm", args: ["audit", "--json"] },
      { name: "signature", capability: "cosign", command: "cosign", args: ["verify", "--key", "cosign.pub", target] },
      { name: "syft", capability: "syft", command: "syft", args: ["scan", target] },
      { name: "grype", capability: "grype", command: "grype", args: ["scan", target] },
    ];

    for (const scanner of scanners) {
      const startedAt = new Date().toISOString();
      const capAvailable = this.isCapabilityAvailable(scanner.capability);

      // Special DAST handling
      if (scanner.name === "dast" && !process.env.STAGING_URL) {
        results.push({
          scanner: scanner.name,
          status: "BLOCKED",
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          duration_ms: 0,
          command_identity: `${scanner.command} ${scanner.args.join(" ")}`,
          target: "STAGING_URL missing",
          findings: [],
          blocked_reason: "STAGING_URL environment variable is not set",
        });
        continue;
      }

      if (!capAvailable) {
        results.push({
          scanner: scanner.name,
          status: "BLOCKED",
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          duration_ms: 0,
          command_identity: `${scanner.command} ${scanner.args.join(" ")}`,
          target: target,
          findings: [],
          blocked_reason: this.getCapabilityReason(scanner.capability) || `Required capability ${scanner.capability} not available`,
        });
        continue;
      }

      // Execute command
      try {
        const res = await this.runScanner(scanner.command, scanner.args);
        const completedAt = new Date().toISOString();
        const duration = new Date(completedAt).getTime() - new Date(startedAt).getTime();

        let status: ScannerResult["status"] = res.exitCode === 0 ? "PASS" : "FAIL";
        let findings: any[] = [];

        if (res.stdout.trim().length > 0) {
          try {
            const parsed = JSON.parse(res.stdout);
            if (parsed && typeof parsed === "object") {
              if (scanner.name === "trivy" && parsed.Results) {
                findings = parsed.Results.flatMap((r: any) => r.Vulnerabilities || []);
              } else if (scanner.name === "gitleaks") {
                findings = [parsed];
              } else {
                findings = [parsed];
              }
            }
          } catch {
            // Non-JSON output; leave findings empty if PASS
          }
        }

        if (status === "FAIL") {
          findings.push({ error: res.stderr.slice(0, 500) });
        }

        results.push({
          scanner: scanner.name,
          status,
          started_at: startedAt,
          completed_at: completedAt,
          duration_ms: duration,
          command_identity: `${scanner.command} ${scanner.args.join(" ")}`,
          target,
          findings,
        });
      } catch (err: any) {
        results.push({
          scanner: scanner.name,
          status: "ERROR",
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          duration_ms: 0,
          command_identity: `${scanner.command} ${scanner.args.join(" ")}`,
          target,
          findings: [],
          error_reason: String(err),
        });
      }
    }

    return results;
  }
}