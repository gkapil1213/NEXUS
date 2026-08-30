import { spawn } from "node:child_process";
import path from "node:path";
import type { TerraformPlanSummary, TerraformPlanChange } from "./cloud-types";

export class TerraformService {
  private async runTerraform(
    args: string[],
    cwd: string,
    timeoutMs = 60000
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn("terraform", args, { cwd, shell: false, windowsHide: true });
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

  async isAvailable(): Promise<boolean> {
    const res = await this.runTerraform(["version"], process.cwd(), 5000);
    return res.exitCode === 0;
  }

  async format(dir: string): Promise<CloudOperationResult> {
    const res = await this.runTerraform(["fmt"], dir);
    return {
      status: res.exitCode === 0 ? "PASS" : "FAIL",
      operation: "fmt",
      provider: "terraform",
      reason: res.exitCode === 0 ? null : res.stderr,
    };
  }

  async validate(dir: string): Promise<CloudOperationResult> {
    const initRes = await this.runTerraform(["init", "-backend=false"], dir, 120000);
    if (initRes.exitCode !== 0) {
      return {
        status: "FAIL",
        operation: "validate",
        provider: "terraform",
        reason: initRes.stderr,
      };
    }
    const valRes = await this.runTerraform(["validate"], dir);
    return {
      status: valRes.exitCode === 0 ? "PASS" : "FAIL",
      operation: "validate",
      provider: "terraform",
      reason: valRes.exitCode === 0 ? null : valRes.stderr,
    };
  }

  async plan(dir: string): Promise<TerraformPlanSummary> {
    const initRes = await this.runTerraform(["init", "-backend=false"], dir, 120000);
    if (initRes.exitCode !== 0) {
      return {
        status: "FAIL",
        changes: [],
        destructive_changes: [],
        estimated_cost: null,
        risk: "LOW",
        output: initRes.stderr,
      };
    }
    const planRes = await this.runTerraform(["plan", "-out=plan.tfplan"], dir);
    if (planRes.exitCode !== 0) {
      return {
        status: "FAIL",
        changes: [],
        destructive_changes: [],
        estimated_cost: null,
        risk: "LOW",
        output: planRes.stderr,
      };
    }
    const showRes = await this.runTerraform(["show", "-json", "plan.tfplan"], dir);
    const changes = this.parsePlanChanges(showRes.stdout);
    const destructive = changes.filter((c) => c.action === "DESTROY" || c.action === "REPLACE");
    const risk = this.classifyRisk(changes);
    return {
      status: "PASS",
      changes,
      destructive_changes: destructive,
      estimated_cost: null,
      risk,
      output: showRes.stdout,
    };
  }

  private parsePlanChanges(planJson: string): TerraformPlanChange[] {
    // Simplified parser for Terraform JSON plan
    try {
      const plan = JSON.parse(planJson);
      const resources = plan.resource_changes ?? [];
      const changes: TerraformPlanChange[] = [];
      for (const res of resources) {
        const action = res.change?.actions?.[0] ?? "NO_CHANGE";
        changes.push({
          resource: res.address ?? "unknown",
          action: action as TerraformPlanChange["action"],
          risk: "LOW",
          reason: res.change?.reason ?? null,
        });
      }
      return changes;
    } catch {
      return [];
    }
  }

  private classifyRisk(changes: TerraformPlanChange[]): TerraformPlanSummary["risk"] {
    if (changes.some((c) => c.action === "DESTROY" && c.resource.includes("aws_vpc"))) return "CRITICAL";
    if (changes.some((c) => c.action === "DESTROY" || c.action === "REPLACE")) return "HIGH";
    if (changes.some((c) => c.action === "CREATE")) return "MEDIUM";
    return "LOW";
  }
}