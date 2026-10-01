// src/core/aws-traffic-router.ts
// Phase 229: real AWS ELBv2 traffic router.
//
// Uses the AWS CLI via spawn(shell:false) matching the existing AWSProvider.
// Every operation honestly returns BLOCKED when aws CLI, credentials, region,
// or required ARNs are unavailable. No credentials are read, logged, or stored.

import { spawn } from "node:child_process";
import type {
  TrafficRouter, TrafficRouterKind, CutoverRequest, CutoverResult, ActiveTarget,
  RouterTargetBinding, RouterHealthResult, RouterReconcileResult, RouterCapabilityReport,
} from "./traffic-router";

export interface AwsTrafficRouterConfig {
  region: string | null;
  loadBalancerArn: string | null;
  listenerArn: string | null;
  targetGroupArn: string | null;
  targetPort: number | null;
}

export function readAwsTrafficRouterConfig(env: NodeJS.ProcessEnv = process.env): AwsTrafficRouterConfig {
  return {
    region: env.NEXUS_AWS_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || null,
    loadBalancerArn: env.NEXUS_AWS_LOAD_BALANCER_ARN || null,
    listenerArn: env.NEXUS_AWS_LISTENER_ARN || null,
    targetGroupArn: env.NEXUS_AWS_TARGET_GROUP_ARN || null,
    targetPort: env.NEXUS_AWS_TARGET_PORT ? Number(env.NEXUS_AWS_TARGET_PORT) : null,
  };
}

const CREDENTIALS_MISSING = "AWS_CREDENTIALS_NOT_CONFIGURED";
const REGION_MISSING = "AWS_REGION_NOT_CONFIGURED";
const CONFIG_MISSING = "AWS_TRAFFIC_CONFIG_NOT_CONFIGURED";
const CLI_MISSING = "AWS_CLI_NOT_AVAILABLE";

export class AWSTrafficRouter implements TrafficRouter {
  readonly kind: TrafficRouterKind = "load-balancer";

  constructor(private readonly config: AwsTrafficRouterConfig) {}

  private async aws(args: string[], timeoutMs = 30000): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string; reason: string | null }> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn("aws", args, { shell: false, windowsHide: true });
      } catch {
        return resolve({ ok: false, exitCode: -1, stdout: "", stderr: "", reason: CLI_MISSING });
      }
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, exitCode: 124, stdout, stderr: stderr + "\n[timeout]", reason: "AWS_CLI_TIMEOUT" });
      }, timeoutMs);
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        const msg = String(err);
        resolve({ ok: false, exitCode: 1, stdout, stderr: msg, reason: /ENOENT|not found/i.test(msg) ? CLI_MISSING : "AWS_CLI_ERROR" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const c = code ?? 1;
        if (c === 0) return resolve({ ok: true, exitCode: 0, stdout, stderr, reason: null });
        let reason = "AWS_CLI_FAILED";
        if (/NoCredentials|Unable to locate credentials/i.test(stderr)) reason = CREDENTIALS_MISSING;
        else if (/region/i.test(stderr) && /Missing|required/i.test(stderr)) reason = REGION_MISSING;
        else if (/not found|does not exist/i.test(stderr)) reason = "AWS_RESOURCE_NOT_FOUND";
        else if (/AccessDenied|Unauthorized|not authorized/i.test(stderr)) reason = "AWS_AUTHORIZATION_FAILED";
        resolve({ ok: false, exitCode: c, stdout, stderr, reason });
      });
    });
  }

  private configComplete(): { ok: boolean; reason: string | null } {
    if (!this.config.region) return { ok: false, reason: REGION_MISSING };
    if (!this.config.loadBalancerArn && !this.config.targetGroupArn) return { ok: false, reason: CONFIG_MISSING };
    return { ok: true, reason: null };
  }

  private async identityOk(): Promise<{ ok: boolean; reason: string | null }> {
    const r = await this.aws(["sts", "get-caller-identity"]);
    if (r.ok) return { ok: true, reason: null };
    return { ok: false, reason: r.reason ?? CREDENTIALS_MISSING };
  }

  async resolveActive(environment: string): Promise<ActiveTarget | null> {
    const cfg = this.configComplete();
    if (!cfg.ok) return null;
    const id = await this.identityOk();
    if (!id.ok) return null;
    if (!this.config.targetGroupArn) return null;
    const r = await this.aws(["elbv2", "describe-target-health", "--target-group-arn", this.config.targetGroupArn]);
    if (!r.ok) return null;
    try {
      const doc = JSON.parse(r.stdout) as { TargetHealthDescriptions?: Array<{ Target?: { Id?: string; Port?: number } }> };
      const list = doc.TargetHealthDescriptions ?? [];
      if (list.length === 0) return null;
      return { environment, targetName: this.config.targetGroupArn, containerId: null, imageId: null, imageDigest: null };
    } catch {
      return null;
    }
  }

  async resolveTarget(
    environment: string,
    _identity: { releaseId: string | null; imageDigest: string | null },
  ): Promise<RouterTargetBinding | null> {
    const cfg = this.configComplete();
    if (!cfg.ok) return null;
    const id = await this.identityOk();
    if (!id.ok) return null;
    if (!this.config.targetGroupArn) return null;
    const r = await this.aws(["elbv2", "describe-target-health", "--target-group-arn", this.config.targetGroupArn]);
    if (!r.ok) return null;
    try {
      const doc = JSON.parse(r.stdout) as { TargetHealthDescriptions?: Array<{ Target?: { Id?: string; Port?: number } }> };
      const list = doc.TargetHealthDescriptions ?? [];
      if (list.length === 0) return null;
      const t = list[0].Target ?? {};
      return {
        environment,
        provider: "load-balancer",
        providerTargetId: t.Id ?? this.config.targetGroupArn ?? "unknown",
        endpoint: null,
        releaseId: null,
        deploymentId: null,
        commitSha: null,
        imageRepository: null,
        imageTag: null,
        imageId: null,
        imageDigest: null,
        containerId: null,
        containerName: null,
        containerPort: t.Port ?? null,
        observedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async validateTarget(_target: RouterTargetBinding): Promise<{ valid: boolean; reason: string | null }> {
    const cfg = this.configComplete();
    if (!cfg.ok) return { valid: false, reason: cfg.reason };
    const id = await this.identityOk();
    if (!id.ok) return { valid: false, reason: id.reason };
    return { valid: true, reason: null };
  }

  async cutover(req: CutoverRequest): Promise<CutoverResult> {
    const cfg = this.configComplete();
    if (!cfg.ok) return { ok: false, reason: cfg.reason, activeTarget: null };
    const id = await this.identityOk();
    if (!id.ok) return { ok: false, reason: id.reason, activeTarget: null };
    if (!this.config.targetGroupArn) return { ok: false, reason: CONFIG_MISSING, activeTarget: null };
    const targetId = (req as unknown as { targetId?: string }).targetId;
    if (!targetId) return { ok: false, reason: "AWS_TARGET_ID_NOT_PROVIDED", activeTarget: null };
    const args = ["elbv2", "register-targets", "--target-group-arn", this.config.targetGroupArn, "--targets", "Id=" + targetId];
    if (this.config.targetPort !== null) args.push("Port=" + String(this.config.targetPort));
    const r = await this.aws(args);
    if (!r.ok) return { ok: false, reason: r.reason ?? "AWS_REGISTER_TARGETS_FAILED", activeTarget: null };
    return { ok: true, reason: null, activeTarget: this.config.targetGroupArn };
  }

  async revert(req: CutoverRequest): Promise<CutoverResult> {
    const cfg = this.configComplete();
    if (!cfg.ok) return { ok: false, reason: cfg.reason, activeTarget: null };
    const id = await this.identityOk();
    if (!id.ok) return { ok: false, reason: id.reason, activeTarget: null };
    if (!this.config.targetGroupArn) return { ok: false, reason: CONFIG_MISSING, activeTarget: null };
    const previousTargetId = req.previousContainerName;
    if (!previousTargetId) return { ok: false, reason: "AWS_PREVIOUS_TARGET_ID_NOT_PROVIDED", activeTarget: null };
    const args = ["elbv2", "register-targets", "--target-group-arn", this.config.targetGroupArn, "--targets", "Id=" + previousTargetId];
    if (this.config.targetPort !== null) args.push("Port=" + String(this.config.targetPort));
    const r = await this.aws(args);
    if (!r.ok) return { ok: false, reason: r.reason ?? "AWS_REGISTER_TARGETS_FAILED", activeTarget: null };
    return { ok: true, reason: null, activeTarget: this.config.targetGroupArn };
  }

  async health(targetId: string): Promise<RouterHealthResult> {
    const cfg = this.configComplete();
    if (!cfg.ok) return { verdict: "BLOCKED", targetId: null, reason: cfg.reason, probedAt: Date.now() };
    const id = await this.identityOk();
    if (!id.ok) return { verdict: "BLOCKED", targetId: null, reason: id.reason, probedAt: Date.now() };
    if (!this.config.targetGroupArn) return { verdict: "BLOCKED", targetId: null, reason: CONFIG_MISSING, probedAt: Date.now() };
    const r = await this.aws(["elbv2", "describe-target-health", "--target-group-arn", this.config.targetGroupArn, "--targets", "Id=" + targetId]);
    if (!r.ok) return { verdict: "UNKNOWN", targetId, reason: r.reason ?? "AWS_DESCRIBE_HEALTH_FAILED", probedAt: Date.now() };
    try {
      const doc = JSON.parse(r.stdout) as { TargetHealthDescriptions?: Array<{ TargetHealth?: { State?: string } }> };
      const state = doc.TargetHealthDescriptions?.[0]?.TargetHealth?.State ?? "unknown";
      if (state === "healthy") return { verdict: "HEALTHY", targetId, reason: null, probedAt: Date.now() };
      if (state === "unhealthy" || state === "unused" || state === "draining") return { verdict: "UNHEALTHY", targetId, reason: state, probedAt: Date.now() };
      return { verdict: "UNKNOWN", targetId, reason: state, probedAt: Date.now() };
    } catch {
      return { verdict: "UNKNOWN", targetId, reason: "AWS_MALFORMED_RESPONSE", probedAt: Date.now() };
    }
  }

  async reconcile(desired: RouterTargetBinding | null): Promise<RouterReconcileResult> {
    const cfg = this.configComplete();
    if (!cfg.ok) return { verdict: "PROVIDER_UNAVAILABLE", reason: cfg.reason, desiredTargetId: desired?.providerTargetId ?? null, observedTargetId: null, reconciledAt: Date.now() };
    const id = await this.identityOk();
    if (!id.ok) return { verdict: "AUTHENTICATION_BLOCKED", reason: id.reason, desiredTargetId: desired?.providerTargetId ?? null, observedTargetId: null, reconciledAt: Date.now() };
    const observed = await this.resolveTarget(desired?.environment ?? "unknown", { releaseId: desired?.releaseId ?? null, imageDigest: desired?.imageDigest ?? null });
    if (!observed) return { verdict: "TARGET_MISSING", reason: "AWS returned no targets", desiredTargetId: desired?.providerTargetId ?? null, observedTargetId: null, reconciledAt: Date.now() };
    const desiredId = desired?.providerTargetId ?? null;
    const observedId = observed.providerTargetId;
    if (desiredId && observedId && desiredId === observedId) return { verdict: "IN_SYNC", reason: null, desiredTargetId: desiredId, observedTargetId: observedId, reconciledAt: Date.now() };
    return { verdict: "DRIFT", reason: "observed does not match desired", desiredTargetId: desiredId, observedTargetId: observedId, reconciledAt: Date.now() };
  }

  async capabilities(): Promise<RouterCapabilityReport> {
    const cfg = this.configComplete();
    const id = cfg.ok ? await this.identityOk() : { ok: false, reason: cfg.reason };
    const enabled = cfg.ok && id.ok;
    return {
      kind: "load-balancer",
      canResolveActive: enabled,
      canResolveTarget: enabled,
      canValidateTarget: enabled,
      canCutover: enabled,
      canRevert: enabled,
      canHealthCheck: enabled,
      canReconcile: enabled,
      reason: enabled ? null : (id.reason ?? cfg.reason),
      probedAt: Date.now(),
    };
  }
}
