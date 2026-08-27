import { ObservabilityService } from "./observability-service";
import http from "http";

export class VerificationAgent {
  constructor(private observability: ObservabilityService) {}

  async verifyServiceHealth(target: string, timeoutMs = 2000): Promise<{ status: "HEALTHY" | "UNHEALTHY" | "BLOCKED"; details: string }> {
    return new Promise((resolve) => {
      const req = http.get(target, { timeout: timeoutMs, agent: false }, (res) => {
        const healthy = res.statusCode && res.statusCode < 400;
        res.resume();
        res.on("end", () => {
          resolve({ status: healthy ? "HEALTHY" : "UNHEALTHY", details: `HTTP ${res.statusCode}` });
        });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: "BLOCKED", details: e.message }));
    });
  }
}