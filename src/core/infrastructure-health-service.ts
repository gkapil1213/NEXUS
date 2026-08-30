import { spawn } from "node:child_process";
import http from "http";

export interface HealthCheckResult {
  status: "HEALTHY" | "DEGRADED" | "FAILED" | "BLOCKED";
  resources_checked: string[];
  failures: string[];
  timestamp: string;
}

export class InfrastructureHealthService {
  async checkLocalContainer(containerName: string): Promise<HealthCheckResult> {
    const resources: string[] = [`docker:${containerName}`];
    const failures: string[] = [];
    const status = await new Promise<"HEALTHY" | "FAILED">((resolve) => {
      const child = spawn("docker", ["inspect", "-f", "{{.State.Running}}", containerName], { shell: false });
      let output = "";
      child.stdout.on("data", d => (output += d.toString()));
      child.on("close", code => resolve(code === 0 && output.trim() === "true" ? "HEALTHY" : "FAILED"));
      child.on("error", () => resolve("FAILED"));
    });
    if (status === "FAILED") failures.push(`${containerName} is not running`);
    return { status, resources_checked: resources, failures, timestamp: new Date().toISOString() };
  }

  async checkHttp(target: string, timeoutMs = 2000): Promise<HealthCheckResult> {
    return new Promise((resolve) => {
      const req = http.get(target, { timeout: timeoutMs }, (res) => {
        const healthy = res.statusCode !== undefined && res.statusCode < 500;
        resolve({
          status: healthy ? "HEALTHY" : "FAILED",
          resources_checked: [target],
          failures: healthy ? [] : [`HTTP ${res.statusCode}`],
          timestamp: new Date().toISOString(),
        });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({
          status: "FAILED",
          resources_checked: [target],
          failures: ["timeout"],
          timestamp: new Date().toISOString(),
        });
      });
      req.on("error", () => resolve({
        status: "BLOCKED",
        resources_checked: [target],
        failures: ["unreachable"],
        timestamp: new Date().toISOString(),
      }));
    });
  }
}