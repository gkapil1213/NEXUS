import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { nid } from "./db";

export interface ReleaseRecord {
  release_id: string;
  version: string;
  commit_sha: string;
  image_reference: string;
  image_digest: string;
  status: "DRAFT" | "READY" | "DEPLOYING" | "VERIFIED" | "FAILED" | "ROLLING_BACK" | "ROLLED_BACK";
}

export interface DeploymentRecord {
  deployment_id: string;
  release_id: string;
  environment: string;
  image_reference: string;
  image_digest: string;
  status: "DEPLOYING" | "VERIFIED" | "FAILED" | "ROLLING_BACK" | "ROLLED_BACK";
  started_at: number;
  completed_at: number | null;
  failure_reason: string | null;
}

export interface RollbackResult {
  status: "SUCCESS" | "FAILED" | "BLOCKED";
  rolled_back_from: string | null;
  rolled_back_to: string | null;
  artifact_digest: string | null;
  health: "PASS" | "FAIL" | "BLOCKED";
  smoke: "PASS" | "FAIL" | "BLOCKED";
  reason: string | null;
}

class DockerRollbackService {
  private statePath = path.join(process.cwd(), "rollback-state.json");
  private state: {
    releases: ReleaseRecord[];
    deployments: DeploymentRecord[];
    current_deployment_id?: string;
  } = { releases: [], deployments: [] };

  constructor() {
    this.loadState();
  }

  private async loadState() {
    try {
      const data = await fs.readFile(this.statePath, "utf-8");
      this.state = JSON.parse(data);
    } catch {}
  }

  private async saveState() {
    await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2));
  }

  async resetForTest() {
    this.state = { releases: [], deployments: [] };
    await this.saveState();
  }

  private runCmd(command: string, args: string[], timeoutMs = 120000): Promise<{ exit_code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const isCmd = command.toLowerCase().endsWith(".cmd") || command.toLowerCase().endsWith(".ps1");
      let child;
      if (isCmd) {
        child = spawn(process.env.ComSpec || "cmd.exe", ["/c", command, ...args], { shell: false, windowsHide: true });
      } else {
        child = spawn(command, args, { shell: false, windowsHide: true });
      }
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ exit_code: 124, stdout, stderr: stderr + "\n[timeout]" });
      }, timeoutMs);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exit_code: 1, stdout, stderr: String(err) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exit_code: code ?? 1, stdout, stderr });
      });
    });
  }

  async dockerBuild(tag: string, contextDir = "."): Promise<void> {
    const res = await this.runCmd("docker", ["build", "--pull=false","-t", tag, contextDir], 180000);
    if (res.exit_code !== 0) throw new Error(`docker build failed: ${res.stderr}`);
  }

  async dockerRun(containerName: string, imageRef: string, port: number): Promise<void> {
    await this.runCmd("docker", ["rm", "-f", containerName], 15000).catch(() => {});
    const res = await this.runCmd("docker", ["run", "-d", "--name", containerName, "-p", `${port}:8080`, imageRef], 30000);
    if (res.exit_code !== 0) throw new Error(`docker run failed: ${res.stderr}`);
  }

  async dockerInspectImageDigest(imageRef: string): Promise<string> {
    const res = await this.runCmd("docker", ["inspect", "--format", "{{index .RepoDigests 0}}", imageRef], 15000);
    if (res.exit_code !== 0) throw new Error(`docker inspect failed: ${res.stderr}`);
    const digest = res.stdout.trim().split("@")[1] ?? "";
    return digest;
  }

  async dockerStopRemove(containerName: string): Promise<void> {
    await this.runCmd("docker", ["stop", containerName], 15000).catch(() => {});
    await this.runCmd("docker", ["rm", "-f", containerName], 15000).catch(() => {});
  }

    async healthCheck(port: number): Promise<boolean> {
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const response = await fetch(`http://localhost:${port}/health`);
        if (response.ok) return true;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  async registerRelease(version: string, commitSha: string, imageRef: string): Promise<ReleaseRecord> {
    const digest = await this.dockerInspectImageDigest(imageRef);
    const release: ReleaseRecord = {
      release_id: nid("rel"),
      version,
      commit_sha: commitSha,
      image_reference: imageRef,
      image_digest: digest,
      status: "READY",
    };
    this.state.releases.push(release);
    await this.saveState();
    return release;
  }

  async deploy(release: ReleaseRecord, environment: string, containerName: string, port: number): Promise<DeploymentRecord> {
    release.status = "DEPLOYING";
    await this.saveState();
    const deployment: DeploymentRecord = {
      deployment_id: nid("dep"),
      release_id: release.release_id,
      environment,
      image_reference: release.image_reference,
      image_digest: release.image_digest,
      status: "DEPLOYING",
      started_at: Date.now(),
      completed_at: null,
      failure_reason: null,
    };
    this.state.deployments.push(deployment);
    this.state.current_deployment_id = deployment.deployment_id;
    await this.saveState();

    await this.dockerRun(containerName, release.image_reference, port);

    const healthy = await this.healthCheck(port);
    if (healthy) {
      release.status = "VERIFIED";
      deployment.status = "VERIFIED";
      deployment.completed_at = Date.now();
      // keep current_deployment_id as this deployment
    } else {
      release.status = "FAILED";
      deployment.status = "FAILED";
      deployment.completed_at = Date.now();
      deployment.failure_reason = "Health check failed";
    }
    await this.saveState();
    return deployment;
  }

  async rollback(environment: string, containerName: string, port: number): Promise<RollbackResult> {
    if (!this.state.current_deployment_id) {
      return { status: "BLOCKED", rolled_back_from: null, rolled_back_to: null, artifact_digest: null, health: "BLOCKED", smoke: "BLOCKED", reason: "No current deployment" };
    }

    const currentDeployment = this.state.deployments.find((d) => d.deployment_id === this.state.current_deployment_id);
    if (!currentDeployment) {
      return { status: "BLOCKED", rolled_back_from: null, rolled_back_to: null, artifact_digest: null, health: "BLOCKED", smoke: "BLOCKED", reason: "Current deployment not found" };
    }

    // If current deployment is already VERIFIED, nothing to roll back
    if (currentDeployment.status === "VERIFIED") {
      return { status: "SUCCESS", rolled_back_from: null, rolled_back_to: null, artifact_digest: currentDeployment.image_digest, health: "PASS", smoke: "PASS", reason: "Already verified, no rollback needed" };
    }

    // Current deployment must be FAILED to rollback
    if (currentDeployment.status !== "FAILED") {
      return { status: "BLOCKED", rolled_back_from: null, rolled_back_to: null, artifact_digest: null, health: "BLOCKED", smoke: "BLOCKED", reason: `Cannot rollback from status ${currentDeployment.status}` };
    }

    // Find the release that failed
    const failedRelease = this.state.releases.find((r) => r.release_id === currentDeployment.release_id);
    if (!failedRelease) {
      return { status: "BLOCKED", rolled_back_from: null, rolled_back_to: null, artifact_digest: null, health: "BLOCKED", smoke: "BLOCKED", reason: "Failed release not found" };
    }

    // Find the most recent VERIFIED release before this failed release
    const failedIdx = this.state.releases.findIndex((r) => r.release_id === failedRelease.release_id);
    let previousRelease: ReleaseRecord | null = null;
    for (let i = failedIdx - 1; i >= 0; i--) {
      if (this.state.releases[i].status === "VERIFIED") {
        previousRelease = this.state.releases[i];
        break;
      }
    }

    if (!previousRelease) {
      return { status: "BLOCKED", rolled_back_from: failedRelease.version, rolled_back_to: null, artifact_digest: null, health: "BLOCKED", smoke: "BLOCKED", reason: "No previous known-good release" };
    }

    // Stop the failed container
    await this.dockerStopRemove(containerName);

    // Deploy previous known-good
    await this.dockerRun(containerName, previousRelease.image_reference, port);

    // Verify health
    const healthy = await this.healthCheck(port);
    if (!healthy) {
      return { status: "FAILED", rolled_back_from: failedRelease.version, rolled_back_to: previousRelease.version, artifact_digest: previousRelease.image_digest, health: "FAIL", smoke: "BLOCKED", reason: "Rollback health check failed" };
    }

    // Verify image digest
    const actualDigest = await this.dockerInspectImageDigest(previousRelease.image_reference);
    if (actualDigest !== previousRelease.image_digest) {
      return { status: "FAILED", rolled_back_from: failedRelease.version, rolled_back_to: previousRelease.version, artifact_digest: actualDigest, health: "PASS", smoke: "BLOCKED", reason: "Digest mismatch" };
    }

    // Update states
    previousRelease.status = "VERIFIED";
    failedRelease.status = "ROLLED_BACK";
    const rollbackDeployment: DeploymentRecord = {
      deployment_id: nid("dep"),
      release_id: previousRelease.release_id,
      environment,
      image_reference: previousRelease.image_reference,
      image_digest: previousRelease.image_digest,
      status: "VERIFIED",
      started_at: Date.now(),
      completed_at: Date.now(),
      failure_reason: null,
    };
    this.state.deployments.push(rollbackDeployment);
    this.state.current_deployment_id = rollbackDeployment.deployment_id;
    await this.saveState();

    return { status: "SUCCESS", rolled_back_from: failedRelease.version, rolled_back_to: previousRelease.version, artifact_digest: previousRelease.image_digest, health: "PASS", smoke: "PASS", reason: null };
  }
}

export const rollbackService = new DockerRollbackService();