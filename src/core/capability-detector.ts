import spawn from "cross-spawn";

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
      const child = spawn(cmd, args, { shell: false, windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ stdout, stderr: "Command timed out", exitCode: 124 });
      }, timeoutMs);
      child.stdout?.on("data", (d: any) => (stdout += d.toString()));
      child.stderr?.on("data", (d: any) => (stderr += d.toString()));
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

  private async checkCommand(cmd: string, versionArgs: string[] = ["--version"], capabilityName?: string, timeoutMs = 10000): Promise<Capability> {
    const res = await this.runCommand(cmd, versionArgs, timeoutMs);
    const available = res.exitCode === 0;
    let version = null;
    if (available) {
      version = res.stdout.trim().split("\n")[0] || res.stderr.trim().split("\n")[0];
    }
    return {
      name: capabilityName ?? cmd,
      available,
      version,
      reason: available ? null : res.stderr.trim() || "executable not found",
      checked_at: new Date().toISOString(),
    };
  }

  async detect(): Promise<Capability[]> {
    const checks = [
      this.checkCommand("node", ["--version"], "node"),
      this.checkCommand("npm", ["--version"], "npm"),
      this.checkCommand("docker", ["--version"], "docker_cli"),
      this.checkCommand("docker", ["info"], "docker_daemon", 30000),
      this.checkCommand("cosign", ["version"], "cosign"),
      this.checkCommand("semgrep", ["--version"], "semgrep"),
      this.checkCommand("gitleaks", ["version"], "gitleaks"),
      this.checkCommand("trivy", ["--version"], "trivy"),
      this.checkCommand("checkov", ["--version"], "checkov"),
      this.checkCommand("syft", ["version"], "syft"),
      this.checkCommand("grype", ["version"], "grype"),
      this.checkCommand("playwright", ["--version"], "playwright"),
      this.checkCommand("chromium", ["--version"], "chromium"),
      this.checkCommand("git", ["--version"], "git"),
      this.checkCommand("curl", ["--version"], "curl"),
      this.checkCommand("terraform", ["version"], "terraform"),
      this.checkCommand("aws", ["--version"], "aws_cli"),
    ];
    return Promise.all(checks);
  }
}
