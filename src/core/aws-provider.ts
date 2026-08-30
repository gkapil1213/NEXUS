import { spawn } from "node:child_process";
import { CloudProvider } from "./cloud-provider";
import type {
  CloudIdentity,
  CloudOperationResult,
  CloudProviderName,
} from "./cloud-types";

export class AWSProvider extends CloudProvider {
  readonly name: CloudProviderName = "aws";

  private async runAws(args: string[], timeoutMs = 30000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn("aws", args, { shell: false, windowsHide: true });
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

  async getIdentity(): Promise<CloudOperationResult<CloudIdentity>> {
    const res = await this.runAws(["sts", "get-caller-identity"]);
    if (res.exitCode !== 0) {
      return {
        status: "BLOCKED",
        operation: "getIdentity",
        provider: this.name,
        reason: res.stderr.trim() || "AWS CLI unavailable or credentials missing",
      };
    }
    try {
      const identity = JSON.parse(res.stdout);
      return {
        status: "PASS",
        operation: "getIdentity",
        provider: this.name,
        evidence: {
          provider: this.name,
          account_id: identity.Account,
          arn: identity.Arn,
          user_id: identity.UserId,
        },
      };
    } catch {
      return {
        status: "FAIL",
        operation: "getIdentity",
        provider: this.name,
        reason: "Invalid AWS STS response",
      };
    }
  }

  async getRegion(): Promise<CloudOperationResult<string>> {
    const res = await this.runAws(["configure", "get", "region"]);
    if (res.exitCode !== 0 || !res.stdout.trim()) {
      return {
        status: "BLOCKED",
        operation: "getRegion",
        provider: this.name,
        reason: res.stderr.trim() || "No region configured",
      };
    }
    return {
      status: "PASS",
      operation: "getRegion",
      provider: this.name,
      evidence: res.stdout.trim(),
    };
  }

  async listRepositories(): Promise<CloudOperationResult> {
    const res = await this.runAws(["ecr", "describe-repositories"]);
    return {
      status: res.exitCode === 0 ? "PASS" : "BLOCKED",
      operation: "listRepositories",
      provider: this.name,
      reason: res.exitCode === 0 ? null : res.stderr,
    };
  }

  async getRepository(name: string): Promise<CloudOperationResult> {
    const res = await this.runAws(["ecr", "describe-repositories", "--repository-names", name]);
    return {
      status: res.exitCode === 0 ? "PASS" : "BLOCKED",
      operation: "getRepository",
      provider: this.name,
      reason: res.exitCode === 0 ? null : res.stderr,
    };
  }

  async listClusters(): Promise<CloudOperationResult> {
    const res = await this.runAws(["ecs", "list-clusters"]);
    return {
      status: res.exitCode === 0 ? "PASS" : "BLOCKED",
      operation: "listClusters",
      provider: this.name,
      reason: res.exitCode === 0 ? null : res.stderr,
    };
  }

  async listServices(cluster: string): Promise<CloudOperationResult> {
    const res = await this.runAws(["ecs", "list-services", "--cluster", cluster]);
    return {
      status: res.exitCode === 0 ? "PASS" : "BLOCKED",
      operation: "listServices",
      provider: this.name,
      reason: res.exitCode === 0 ? null : res.stderr,
    };
  }

  async listLoadBalancers(): Promise<CloudOperationResult> {
    const res = await this.runAws(["elbv2", "describe-load-balancers"]);
    return {
      status: res.exitCode === 0 ? "PASS" : "BLOCKED",
      operation: "listLoadBalancers",
      provider: this.name,
      reason: res.exitCode === 0 ? null : res.stderr,
    };
  }

  async listLogGroups(): Promise<CloudOperationResult> {
    const res = await this.runAws(["logs", "describe-log-groups"]);
    return {
      status: res.exitCode === 0 ? "PASS" : "BLOCKED",
      operation: "listLogGroups",
      provider: this.name,
      reason: res.exitCode === 0 ? null : res.stderr,
    };
  }

  async getSecretMetadata(secretId: string): Promise<CloudOperationResult> {
    const res = await this.runAws(["secretsmanager", "describe-secret", "--secret-id", secretId]);
    return {
      status: res.exitCode === 0 ? "PASS" : "BLOCKED",
      operation: "getSecretMetadata",
      provider: this.name,
      reason: res.exitCode === 0 ? null : res.stderr,
    };
  }
}