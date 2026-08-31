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

interface CommandResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

class CosignService {
  private readonly DEFAULT_TIMEOUT_MS = 180_000;

  // Hard cap on accumulated stdout/stderr to avoid unbounded memory growth
  // from a runaway or unexpectedly chatty subprocess.
  private readonly MAX_BUFFER_BYTES = 5 * 1024 * 1024; // 5MB per stream

  /**
   * Execute a command without shell interpolation.
   *
   * Security properties:
   * - shell:false
   * - no command-string concatenation
   * - environment variables are passed through env
   * - timeout is handled exactly once
   */
  private runCmd(
    command: string,
    args: string[],
    timeoutMs = this.DEFAULT_TIMEOUT_MS,
    extraEnv?: Record<string, string>,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result: CommandResult) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const appendBounded = (
        current: string,
        chunk: string,
      ): string => {
        if (current.length >= this.MAX_BUFFER_BYTES) {
          return current;
        }

        return (current + chunk).slice(0, this.MAX_BUFFER_BYTES);
      };

      let child;

      try {
        child = spawn(command, args, {
          shell: false,
          windowsHide: true,
          env: {
            ...process.env,
            ...extraEnv,
          },
        });
      } catch (error) {
        finish({
          exit_code: 1,
          stdout,
          stderr: String(error),
          timed_out: false,
        });
        return;
      }

      const timer = setTimeout(() => {
        stderr += "\n[timeout]";

        try {
          child.kill();
        } catch {
          // Process may already have exited.
        }

        finish({
          exit_code: 124,
          stdout,
          stderr,
          timed_out: true,
        });
      }, timeoutMs);

      child.stdout?.on("data", (data: Buffer | string) => {
        stdout = appendBounded(stdout, data.toString());
      });

      child.stderr?.on("data", (data: Buffer | string) => {
        stderr = appendBounded(stderr, data.toString());
      });

      child.on("error", (error) => {
        // Includes ENOENT when the binary itself can't be found/executed.
        const code = (error as NodeJS.ErrnoException).code;

        finish({
          exit_code: 1,
          stdout,
          stderr: stderr + `[spawn_error:${code ?? "UNKNOWN"}] ${String(error)}`,
          timed_out: false,
        });
      });

      child.on("close", (code) => {
        finish({
          exit_code: code ?? 1,
          stdout,
          stderr,
          timed_out: false,
        });
      });
    });
  }

  /**
   * Translate host-accessible localhost registry references
   * to references reachable from a Docker container running
   * on the host.
   *
   * Example:
   *
   * localhost:5000/nexus/app@sha256:...
   *
   * becomes:
   *
   * host.docker.internal:5000/nexus/app@sha256:...
   *
   * NOTE: this rewrite only WORKS if the docker run invocation also
   * maps host.docker.internal to the host gateway (see
   * dockerCosignArgs). host.docker.internal resolves automatically on
   * Docker Desktop, but on native Linux Docker hosts it requires an
   * explicit --add-host mapping.
   */
  private toDockerRegistryRef(imageRef: string): string {
    return imageRef
      .replace(/^localhost:/, "host.docker.internal:")
      .replace(/^127\.0\.0\.1:/, "host.docker.internal:");
  }

  /**
   * Extract an immutable digest from an image reference.
   *
   * Expected:
   *
   * repository/image@sha256:<64 hex characters>
   */
  private extractDigest(imageRef: string): string | null {
    const match = imageRef.match(/@(sha256:[a-f0-9]{64})$/i);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Redact potentially sensitive environment-related information
   * before returning command errors.
   */
  private sanitizeError(message: string): string {
    return message
      .replace(/COSIGN_PASSWORD=[^\s]+/gi, "COSIGN_PASSWORD=[REDACTED]")
      .slice(0, 1000);
  }

  /**
   * Check whether Docker CLI and daemon are actually available.
   *
   * This prevents a missing Docker runtime from being reported
   * as a signing/verification failure.
   */
  private async checkDockerRuntime(): Promise<{
    available: boolean;
    reason: string | null;
  }> {
    const version = await this.runCmd("docker", ["version", "--format", "{{.Server.Version}}"], 15_000);

    if (version.exit_code !== 0) {
      // ENOENT (via the "error" event) covers "binary not found" on
      // Linux/macOS. The string patterns below cover the Windows-style
      // messages that show up when spawn falls back to cmd.exe lookup
      // behavior. Checking both keeps this cross-platform.
      const notFoundIndicators = [
        /spawn_error:ENOENT/i,
        /not recognized/i,
        /command not found/i,
        /cannot find the path/i,
        /no such file or directory/i,
      ];

      if (notFoundIndicators.some((pattern) => pattern.test(version.stderr))) {
        return {
          available: false,
          reason: "Docker CLI is not available.",
        };
      }

      return {
        available: false,
        reason:
          this.sanitizeError(
            version.stderr.trim() ||
              "Docker daemon is unavailable.",
          ),
      };
    }

    if (!version.stdout.trim()) {
      return {
        available: false,
        reason: "Docker daemon did not return a server version.",
      };
    }

    return {
      available: true,
      reason: null,
    };
  }

  /**
   * Build arguments for the cosign container.
   *
   * IMPORTANT:
   *
   * includePassword=true
   *   only for signing.
   *
   * includePassword=false
   *   for verification.
   *
   * The password is NOT placed in Docker command arguments.
   * It is passed through the container environment instead.
   *
   * NOTE: this intentionally does NOT mount the host Docker socket.
   * cosign sign/verify against a registry reference only needs
   * network access to that registry - it never talks to the Docker
   * daemon. Mounting /var/run/docker.sock would hand the container
   * root-equivalent control of the host for no functional benefit.
   */
  private dockerCosignArgs(includePassword = false): {
    args: string[];
    env: Record<string, string>;
  } {
    const args = [
      "run",
      "--rm",

      "-e",
      "SIGSTORE_NO_TUF=1",

      // Makes host.docker.internal resolvable from inside the
      // container on native Linux Docker hosts (Docker 20.10+).
      // Harmless no-op on Docker Desktop, where it already resolves.
      "--add-host",
      "host.docker.internal:host-gateway",

      "-v",
      `${process.cwd()}:/workspace`,

      "-w",
      "/workspace",
    ];

    const env: Record<string, string> = {};

    if (includePassword) {
      const password = process.env.COSIGN_PASSWORD;

      if (!password) {
        const error = new Error(
          "COSIGN_PASSWORD environment variable is required for signing",
        );

        (error as Error & { code?: string }).code = "CONFIG_MISSING";

        throw error;
      }

      /*
       * Pass the secret through the container environment.
       *
       * Do NOT append:
       *
       * -e COSIGN_PASSWORD=<secret>
       *
       * to the command arguments.
       */
      args.push("-e", "COSIGN_PASSWORD");

      env.COSIGN_PASSWORD = password;
    }

    args.push("bitnami/cosign");

    return {
      args,
      env,
    };
  }

  /**
   * Check whether the signing key exists.
   */
  private async hasSigningKey(): Promise<boolean> {
    const keyPath = path.join(process.cwd(), "cosign.key");

    return fs
      .access(keyPath)
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Check whether the public verification key exists.
   */
  private async hasPublicKey(): Promise<boolean> {
    const pubPath = path.join(process.cwd(), "cosign.pub");

    return fs
      .access(pubPath)
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Sign an immutable image reference.
   *
   * Signing requires:
   * - Docker CLI
   * - Docker daemon
   * - COSIGN_PASSWORD
   * - cosign.key
   * - immutable image digest
   */
  async sign(imageRef: string): Promise<SigningResult> {
    const digest = this.extractDigest(imageRef);

    if (!digest) {
      return {
        status: "BLOCKED",
        image_ref: imageRef,
        digest: null,
        signature: null,
        identity: null,
        issuer: null,
        reason:
          "Signing requires an immutable image reference containing a sha256 digest.",
      };
    }

    if (!process.env.COSIGN_PASSWORD) {
      return {
        status: "BLOCKED",
        image_ref: imageRef,
        digest,
        signature: null,
        identity: null,
        issuer: null,
        reason:
          "COSIGN_PASSWORD environment variable is required for signing.",
      };
    }

    const hasKey = await this.hasSigningKey();

    if (!hasKey) {
      return {
        status: "BLOCKED",
        image_ref: imageRef,
        digest,
        signature: null,
        identity: null,
        issuer: null,
        reason: "cosign.key not found.",
      };
    }

    const dockerRuntime = await this.checkDockerRuntime();

    if (!dockerRuntime.available) {
      return {
        status: "BLOCKED",
        image_ref: imageRef,
        digest,
        signature: null,
        identity: null,
        issuer: null,
        reason: dockerRuntime.reason ?? "Docker runtime unavailable.",
      };
    }

    const dockerImageRef = this.toDockerRegistryRef(imageRef);

    let cosign;

    try {
      cosign = this.dockerCosignArgs(true);
    } catch (error) {
      const err = error as Error & { code?: string };

      return {
        status: err.code === "CONFIG_MISSING" ? "BLOCKED" : "FAILED",
        image_ref: imageRef,
        digest,
        signature: null,
        identity: null,
        issuer: null,
        reason: this.sanitizeError(err.message),
      };
    }

    const args = [
      ...cosign.args,

      "sign",

      "--key",
      "/workspace/cosign.key",

      "--allow-insecure-registry",
      "--allow-http-registry",

      dockerImageRef,
    ];

    const result = await this.runCmd(
      "docker",
      args,
      this.DEFAULT_TIMEOUT_MS,
      cosign.env,
    );

    if (result.timed_out) {
      return {
        status: "FAILED",
        image_ref: imageRef,
        digest,
        signature: null,
        identity: "NOT_APPLICABLE",
        issuer: "NOT_APPLICABLE",
        reason: "Cosign signing timed out.",
      };
    }

    if (result.exit_code !== 0) {
      return {
        status: "FAILED",
        image_ref: imageRef,
        digest,
        signature: null,
        identity: "NOT_APPLICABLE",
        issuer: "NOT_APPLICABLE",
        reason: this.sanitizeError(
          result.stderr.trim() || "Cosign signing failed.",
        ),
      };
    }

    return {
      status: "SIGNED",
      image_ref: imageRef,
      digest,
      signature: "cosign signature recorded",
      identity: "NOT_APPLICABLE",
      issuer: "NOT_APPLICABLE",
      reason: null,
    };
  }

  /**
   * Verify an image signature.
   *
   * IMPORTANT:
   *
   * Verification does NOT require COSIGN_PASSWORD.
   *
   * This is intentional and fixes the regression where verification
   * incorrectly failed because the signing password was missing.
   */
  async verify(imageRef: string): Promise<SigningResult> {
    const digest = this.extractDigest(imageRef);

    if (!digest) {
      return {
        status: "BLOCKED",
        image_ref: imageRef,
        digest: null,
        signature: null,
        identity: null,
        issuer: null,
        reason:
          "Verification requires an immutable image reference containing a sha256 digest.",
      };
    }

    const hasPublicKey = await this.hasPublicKey();

    if (!hasPublicKey) {
      return {
        status: "BLOCKED",
        image_ref: imageRef,
        digest,
        signature: null,
        identity: null,
        issuer: null,
        reason: "cosign.pub not found.",
      };
    }

    const dockerRuntime = await this.checkDockerRuntime();

    if (!dockerRuntime.available) {
      return {
        status: "BLOCKED",
        image_ref: imageRef,
        digest,
        signature: null,
        identity: null,
        issuer: null,
        reason: dockerRuntime.reason ?? "Docker runtime unavailable.",
      };
    }

    const dockerImageRef = this.toDockerRegistryRef(imageRef);

    let cosign;

    try {
      /*
       * FALSE is critical here.
       *
       * Verification does NOT need COSIGN_PASSWORD.
       */
      cosign = this.dockerCosignArgs(false);
    } catch (error) {
      const err = error as Error & { code?: string };

      return {
        status: "FAILED",
        image_ref: imageRef,
        digest,
        signature: null,
        identity: "NOT_APPLICABLE",
        issuer: "NOT_APPLICABLE",
        reason: this.sanitizeError(err.message),
      };
    }

    const args = [
      ...cosign.args,

      "verify",

      "--key",
      "/workspace/cosign.pub",

      "--allow-insecure-registry",
      "--allow-http-registry",

      dockerImageRef,
    ];

    const result = await this.runCmd(
      "docker",
      args,
      this.DEFAULT_TIMEOUT_MS,
      cosign.env,
    );

    if (result.timed_out) {
      return {
        status: "FAILED",
        image_ref: imageRef,
        digest,
        signature: null,
        identity: "NOT_APPLICABLE",
        issuer: "NOT_APPLICABLE",
        reason: "Cosign verification timed out.",
      };
    }

    if (result.exit_code !== 0) {
      return {
        status: "FAILED",
        image_ref: imageRef,
        digest,
        signature: null,
        identity: "NOT_APPLICABLE",
        issuer: "NOT_APPLICABLE",
        reason: this.sanitizeError(
          result.stderr.trim() || "Cosign signature verification failed.",
        ),
      };
    }

    /*
     * Verification succeeded against the exact immutable image
     * reference supplied to cosign.
     *
     * We intentionally use the digest from imageRef rather than
     * trusting human-readable CLI output.
     */
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

export { CosignService };