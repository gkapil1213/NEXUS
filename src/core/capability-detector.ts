import { spawn } from "node:child_process";

export interface Capability {
  name: string;
  available: boolean;
  version: string | null;
  reason: string | null;
  checked_at: string;
}

export class CapabilityDetector {
  private async runCommand(cmd: string, args: string[] = [], timeoutMs = 10000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      // nosemgrep: spawn-shell-true – shell is required for Windows command resolution; commands are static
      // nosemgrep: spawn-shell-true, detect-child-process
const child = spawn(cmd, args, { shell: true, windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ stdout, stderr: "Command timed out", exitCode: 124 });
      }, timeoutMs);
      child.stdout.on("data", (d: any) => (stdout += d.toString()));
      child.stderr.on("data", (d: any) => (stderr += d.toString()));
      child.on("error", (err: any) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: String(err), exitCode: 1 });
      });
      child.on("close", (code: number) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
  }

  private async checkCommand(cmd: string, versionArgs: string[] = ["--version"]): Promise<Capability> {
    const res = await this.runCommand(cmd, versionArgs);
    const available = res.exitCode === 0;
    let version = null;
    if (available) {
      version = res.stdout.trim().split("\n")[0] || res.stderr.trim().split("\n")[0];
    }
    return {
      name: cmd,
      available,
      version,
      reason: available ? null : res.stderr.trim() || "executable not found",
      checked_at: new Date().toISOString(),
    };
  }

  async detect(): Promise<Capability[]> {
    const checks = [
      this.checkCommand("node"),
      this.checkCommand("npm", ["--version"]),
      this.checkCommand("docker", ["--version"]),
      this.checkCommand("docker", ["info"]),
      this.checkCommand("cosign", ["version"]),
      this.checkCommand("semgrep", ["--version"]),
      this.checkCommand("gitleaks", ["version"]),
      this.checkCommand("trivy", ["--version"]),
      this.checkCommand("checkov", ["--version"]),
      this.checkCommand("syft", ["version"]),
      this.checkCommand("grype", ["version"]),
      this.checkCommand("playwright", ["--version"]),
      this.checkCommand("chromium", ["--version"]),
      this.checkCommand("git", ["--version"]),
      this.checkCommand("curl", ["--version"]),
      this.checkCommand("terraform", ["version"]),
      this.checkCommand("aws", ["--version"]),
    ];
    return Promise.all(checks);
  }
}