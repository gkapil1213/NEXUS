import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface SigningResult {
  status: "SIGNED" | "VERIFIED" | "BLOCKED" | "FAILED";
  image_ref: string;
  digest: string | null;
  signature: string | null;
  identity: string | null;
  issuer: string | null;
  reason: string | null;
}

class CosignService {
  private runCmd(command: string, args: string[], timeoutMs = 180000): Promise<{ exit_code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { shell: false, windowsHide: true });
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

  // Translate host-accessible registry refs to Docker-internal refs.
  private toDockerRegistryRef(imageRef: string): string {
    return imageRef
      .replace(/^localhost:/, "host.docker.internal:")
      .replace(/^127\.0\.0\.1:/, "host.docker.internal:");
  }

  private dockerCosignArgs(operation: 'sign' | 'verify' = 'verify'): string[] {
    if (operation === 'sign' && !process.env.COSIGN_PASSWORD) {
      throw new Error('COSIGN_PASSWORD environment variable is required for signing');
    }

    const password = process.env.COSIGN_PASSWORD ?? "";
    const cwd = process.cwd();

    return [
      "run", "--rm",
      "-e", `COSIGN_PASSWORD=${password}`,
      "-e", "SIGSTORE_NO_TUF=1",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${cwd}:/workspace`,
      "-w", "/workspace",
      "bitnami/cosign",
    ];
  }

  async sign(imageRef: string): Promise<SigningResult> {
    // Ensure a password exists for signing.
    process.env.COSIGN_PASSWORD = process.env.COSIGN_PASSWORD ?? "test123";

    const keyPath = path.join(process.cwd(), "cosign.key");
    const exists = await fs.access(keyPath).then(() => true).catch(() => false);
    if (!exists) {
      return { status: "BLOCKED", image_ref: imageRef, digest: null, signature: null, identity: null, issuer: null, reason: "cosign.key not found." };
    }

    const dockerImageRef = this.toDockerRegistryRef(imageRef);
    const args = [
      ...this.dockerCosignArgs('sign'),
      "sign",
      "--key", "/workspace/cosign.key",
      "--allow-insecure-registry",
      "--allow-http-registry",
      dockerImageRef,
    ];

    const res = await this.runCmd("docker", args);

    if (res.exit_code !== 0) {
      return { status: "FAILED", image_ref: imageRef, digest: null, signature: null, identity: "NOT_APPLICABLE", issuer: "NOT_APPLICABLE", reason: res.stderr.slice(0, 400) };
    }

    return {
      status: "SIGNED",
      image_ref: imageRef,
      digest: imageRef.split("@")[1] ?? null,
      signature: "cosign signature recorded",
      identity: "NOT_APPLICABLE",
      issuer: "NOT_APPLICABLE",
      reason: null,
    };
  }

  async verify(imageRef: string): Promise<SigningResult> {
    const pubPath = path.join(process.cwd(), "cosign.pub");
    const exists = await fs.access(pubPath).then(() => true).catch(() => false);
    if (!exists) {
      return { status: "BLOCKED", image_ref: imageRef, digest: null, signature: null, identity: null, issuer: null, reason: "cosign.pub not found." };
    }

    const dockerImageRef = this.toDockerRegistryRef(imageRef);
    const args = [
      ...this.dockerCosignArgs('verify'),
      "verify",
      "--key", "/workspace/cosign.pub",
      "--allow-insecure-registry",
      "--allow-http-registry",
      dockerImageRef,
    ];

    const res = await this.runCmd("docker", args);

    if (res.exit_code !== 0) {
      return { status: "FAILED", image_ref: imageRef, digest: null, signature: null, identity: "NOT_APPLICABLE", issuer: "NOT_APPLICABLE", reason: res.stderr.slice(0, 400) };
    }

    const match = res.stdout.match(/digest:\s*(sha256:[a-f0-9]+)/i);
    const digest = match ? match[1] : imageRef.split("@")[1] ?? null;

    return {
      status: "VERIFIED",
      image_ref: imageRef,
      digest,
      signature: "cosign signature verified",
      identity: "NOT_APPLICABLE",
      issuer: "NOT_APPLICABLE",
      reason: null,
    };
  }
}

export const artifactSigningService = new CosignService();
export { CosignService }; // add this line