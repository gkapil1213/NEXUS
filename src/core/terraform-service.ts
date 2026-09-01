import { spawn } from "node:child_process";
import type {
  TerraformPlanSummary,
  TerraformPlanChange,
  CloudOperationResult,
} from "./cloud-types";
import { parsePlanChanges, classifyRisk } from "./infrastructure-plan";

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
    const res = await this.runTerraform(["fmt", "-check"], dir);
    return {
      status: res.exitCode === 0 ? "PASS" : "FAIL",
      operation: "fmt",
      provider: "aws",
      reason: res.exitCode === 0 ? null : res.stderr,
    };
  }

  async formatWrite(dir: string): Promise<CloudOperationResult> {
    const res = await this.runTerraform(["fmt"], dir);
    return {
      status: res.exitCode === 0 ? "PASS" : "FAIL",
      operation: "fmt",
      provider: "aws",
      reason: res.exitCode === 0 ? null : res.stderr,
    };
  }

  async init(dir: string): Promise<CloudOperationResult> {
    const res = await this.runTerraform(["init", "-backend=false"], dir, 120000);
    return {
      status: res.exitCode === 0 ? "PASS" : "FAIL",
      operation: "init",
      provider: "aws",
      reason: res.exitCode === 0 ? null : res.stderr,
    };
  }

  async validate(dir: string): Promise<CloudOperationResult> {
    const res = await this.runTerraform(["validate"], dir);
    return {
      status: res.exitCode === 0 ? "PASS" : "FAIL",
      operation: "validate",
      provider: "aws",
      reason: res.exitCode === 0 ? null : res.stderr,
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
    const planRes = await this.runTerraform(["plan", "-out", "plan.tfplan"], dir);
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
    const changes = parsePlanChanges(showRes.stdout) as TerraformPlanChange[];
    const destructive = changes.filter(c => c.action === "DELETE" || c.action === "REPLACE");
    const risk = classifyRisk(changes);
    return {
      status: "PASS",
      changes,
      destructive_changes: destructive,
      estimated_cost: null,
      risk,
      output: showRes.stdout,
    };
  }

  async show(dir: string): Promise<CloudOperationResult> {
    const res = await this.runTerraform(["show", "-json", "plan.tfplan"], dir);
    return {
      status: res.exitCode === 0 ? "PASS" : "FAIL",
      operation: "show",
      provider: "aws",
      reason: res.exitCode === 0 ? null : res.stderr,
      evidence: res.stdout,
    };
  }

  async apply(dir: string, planFile: string): Promise<CloudOperationResult> {
    const res = await this.runTerraform(["apply", planFile], dir, 300000);
    return {
      status: res.exitCode === 0 ? "PASS" : "FAIL",
      operation: "apply",
      provider: "aws",
      reason: res.exitCode === 0 ? null : res.stderr,
    };
  }
}
