// src/core/aws-traffic-router.ts
// Phase 230: real AWS ALB traffic cutover, rollback and reconciliation.
//
// The router modifies the actual ALB forwarding action (modify-rule when a
// rule controls the route; modify-listener when the listener default action
// controls it). It captures the previous forward configuration BEFORE any
// mutation so revert can restore the exact prior routing. Every operation
// is honest BLOCKED when AWS CLI, credentials, region, or required ARNs
// are unavailable. No credentials are read, logged, or stored.

import { spawn } from "node:child_process";
import type {
  TrafficRouter, TrafficRouterKind, CutoverRequest, CutoverResult, ActiveTarget,
  RouterTargetBinding, RouterHealthResult, RouterReconcileResult, RouterCapabilityReport,
} from "./traffic-router";

export interface AwsTrafficRouterConfig {
  region: string | null;
  loadBalancerArn: string | null;
  listenerArn: string | null;
  ruleArn: string | null;
  targetGroupArn: string | null;
  targetPort: number | null;
}

export function readAwsTrafficRouterConfig(env: NodeJS.ProcessEnv = process.env): AwsTrafficRouterConfig {
  return {
    region: env.NEXUS_AWS_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || null,
    loadBalancerArn: env.NEXUS_AWS_LOAD_BALANCER_ARN || null,
    listenerArn: env.NEXUS_AWS_LISTENER_ARN || null,
    ruleArn: env.NEXUS_AWS_RULE_ARN || null,
    targetGroupArn: env.NEXUS_AWS_TARGET_GROUP_ARN || null,
    targetPort: env.NEXUS_AWS_TARGET_PORT ? Number(env.NEXUS_AWS_TARGET_PORT) : null,
  };
}

export interface AwsCommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  reason: string | null;
}

/** Injected so tests can deterministically verify the exact AWS CLI
 *  commands a cutover/revert/discovery would issue without touching AWS. */
export interface AwsCliRunner {
  run(args: string[], timeoutMs?: number): Promise<AwsCommandResult>;
}

export class SpawnAwsCliRunner implements AwsCliRunner {
  async run(args: string[], timeoutMs = 30000): Promise<AwsCommandResult> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn("aws", args, { shell: false, windowsHide: true });
      } catch {
        return resolve({ ok: false, exitCode: -1, stdout: "", stderr: "", reason: "AWS_CLI_NOT_AVAILABLE" });
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
        resolve({ ok: false, exitCode: 1, stdout, stderr: msg, reason: /ENOENT|not found/i.test(msg) ? "AWS_CLI_NOT_AVAILABLE" : "AWS_CLI_ERROR" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const c = code ?? 1;
        if (c === 0) return resolve({ ok: true, exitCode: 0, stdout, stderr, reason: null });
        let reason = "AWS_CLI_FAILED";
        if (/NoCredentials|Unable to locate credentials/i.test(stderr)) reason = "AWS_CREDENTIALS_NOT_CONFIGURED";
        else if (/region/i.test(stderr) && /Missing|required/i.test(stderr)) reason = "AWS_REGION_NOT_CONFIGURED";
        else if (/not found|does not exist/i.test(stderr)) reason = "AWS_RESOURCE_NOT_FOUND";
        else if (/AccessDenied|Unauthorized|not authorized/i.test(stderr)) reason = "AWS_AUTHORIZATION_FAILED";
        resolve({ ok: false, exitCode: c, stdout, stderr, reason });
      });
    });
  }
}

export const AWS_REASON = {
  CREDENTIALS: "AWS_CREDENTIALS_NOT_CONFIGURED",
  REGION: "AWS_REGION_NOT_CONFIGURED",
  CONFIG: "AWS_TRAFFIC_CONFIG_NOT_CONFIGURED",
  CLI: "AWS_CLI_NOT_AVAILABLE",
  RESOURCE: "AWS_RESOURCE_NOT_FOUND",
  AUTH: "AWS_AUTHORIZATION_FAILED",
  ROUTING: "AWS_ROUTING_DISCOVERY_FAILED",
} as const;

/** Snapshot of the ALB forwarding state captured BEFORE any mutation. */
export interface AwsRoutingSnapshot {
  loadBalancerArn: string;
  listenerArn: string;
  ruleArn: string | null;
  forwardMode: "rule" | "listener-default";
  targetGroupArn: string;
  capturedAt: number;
}

interface RuleDoc {
  Rules?: Array<{
    RuleArn?: string;
    IsDefault?: boolean;
    Conditions?: Array<{ Field?: string; Values?: string[] }>;
    Actions?: Array<{
      Type?: string;
      TargetGroupArn?: string;
      ForwardConfig?: {
        TargetGroups?: Array<{ TargetGroupArn?: string; Weight?: number }>;
      };
    }>;
  }>;
}

interface ListenerDoc {
  Listeners?: Array<{
    ListenerArn?: string;
    Port?: number;
    Protocol?: string;
    DefaultActions?: Array<{
      Type?: string;
      TargetGroupArn?: string;
      ForwardConfig?: {
        TargetGroups?: Array<{ TargetGroupArn?: string; Weight?: number }>;
      };
    }>;
  }>;
}

interface LoadBalancerDoc {
  LoadBalancers?: Array<{
    LoadBalancerArn?: string;
    DNSName?: string;
    State?: { Code?: string };
  }>;
}

interface TargetGroupDoc {
  TargetGroups?: Array<{
    TargetGroupArn?: string;
    TargetGroupName?: string;
    Protocol?: string;
    Port?: number;
  }>;
}

interface TargetHealthDoc {
  TargetHealthDescriptions?: Array<{
    Target?: { Id?: string; Port?: number };
    TargetHealth?: { State?: string; Reason?: string };
  }>;
}

export class AWSTrafficRouter implements TrafficRouter {
  readonly kind: TrafficRouterKind = "load-balancer";
  private readonly cli: AwsCliRunner;

  constructor(
    private readonly config: AwsTrafficRouterConfig,
    cli?: AwsCliRunner,
  ) {
    this.cli = cli ?? new SpawnAwsCliRunner();
  }

  private aws(args: string[], timeoutMs = 30000): Promise<AwsCommandResult> {
    return this.cli.run(args, timeoutMs);
  }

  private configComplete(): { ok: boolean; reason: string | null } {
    if (!this.config.region) return { ok: false, reason: AWS_REASON.REGION };
    if (!this.config.loadBalancerArn && !this.config.targetGroupArn) return { ok: false, reason: AWS_REASON.CONFIG };
    return { ok: true, reason: null };
  }

  private async identityOk(): Promise<{ ok: boolean; reason: string | null }> {
    const r = await this.aws(["sts", "get-caller-identity"]);
    if (r.ok) return { ok: true, reason: null };
    return { ok: false, reason: r.reason ?? AWS_REASON.CREDENTIALS };
  }

  /** discover the ALB, listener and (optionally) rule; return the current forward config */
  async discoverRouting(): Promise<{ ok: true; snapshot: AwsRoutingSnapshot } | { ok: false; reason: string }> {
    const cfg = this.configComplete();
    if (!cfg.ok) return { ok: false, reason: cfg.reason ?? AWS_REASON.CONFIG };
    const id = await this.identityOk();
    if (!id.ok) return { ok: false, reason: id.reason ?? AWS_REASON.CREDENTIALS };

    const lbArn = this.config.loadBalancerArn;
    if (!lbArn) return { ok: false, reason: AWS_REASON.CONFIG };
    const lb = await this.aws(["elbv2", "describe-load-balancers", "--load-balancer-arns", lbArn]);
    if (!lb.ok) return { ok: false, reason: lb.reason ?? AWS_REASON.RESOURCE };
    let lbDoc: LoadBalancerDoc = {};
    try { lbDoc = JSON.parse(lb.stdout) as LoadBalancerDoc; } catch { return { ok: false, reason: "AWS_MALFORMED_RESPONSE" }; }
    const found = (lbDoc.LoadBalancers ?? []).find((x) => x.LoadBalancerArn === lbArn);
    if (!found) return { ok: false, reason: AWS_REASON.RESOURCE };

    const listeners = await this.aws(["elbv2", "describe-listeners", "--load-balancer-arn", lbArn]);
    if (!listeners.ok) return { ok: false, reason: listeners.reason ?? AWS_REASON.RESOURCE };
    let lDoc: ListenerDoc = {};
    try { lDoc = JSON.parse(listeners.stdout) as ListenerDoc; } catch { return { ok: false, reason: "AWS_MALFORMED_RESPONSE" }; }
    const listenerArn = this.config.listenerArn
      ?? (lDoc.Listeners ?? [])[0]?.ListenerArn;
    if (!listenerArn) return { ok: false, reason: AWS_REASON.ROUTING };
    const listener = (lDoc.Listeners ?? []).find((x) => x.ListenerArn === listenerArn);
    if (!listener) return { ok: false, reason: AWS_REASON.RESOURCE };

    // If a rule ARN is configured, read rules and select it. Otherwise use the
    // listener default forward action.
    let ruleArn: string | null = this.config.ruleArn;
    let forwardMode: "rule" | "listener-default" = ruleArn ? "rule" : "listener-default";
    let activeTargetGroupArn: string | null = null;

    if (ruleArn) {
      const rules = await this.aws(["elbv2", "describe-rules", "--listener-arn", listenerArn]);
      if (!rules.ok) return { ok: false, reason: rules.reason ?? AWS_REASON.RESOURCE };
      let rDoc: RuleDoc = {};
      try { rDoc = JSON.parse(rules.stdout) as RuleDoc; } catch { return { ok: false, reason: "AWS_MALFORMED_RESPONSE" }; }
      const rule = (rDoc.Rules ?? []).find((x) => x.RuleArn === ruleArn);
      if (!rule) return { ok: false, reason: AWS_REASON.RESOURCE };
      const fwd = (rule.Actions ?? []).find((a) => a.Type === "forward");
      activeTargetGroupArn = fwd?.ForwardConfig?.TargetGroups?.[0]?.TargetGroupArn
        ?? fwd?.TargetGroupArn
        ?? null;
      if (!activeTargetGroupArn) return { ok: false, reason: AWS_REASON.ROUTING };
    } else {
      const fwd = (listener.DefaultActions ?? []).find((a) => a.Type === "forward");
      activeTargetGroupArn = fwd?.ForwardConfig?.TargetGroups?.[0]?.TargetGroupArn
        ?? fwd?.TargetGroupArn
        ?? null;
      if (!activeTargetGroupArn) return { ok: false, reason: AWS_REASON.ROUTING };
    }

    return {
      ok: true,
      snapshot: {
        loadBalancerArn: lbArn,
        listenerArn,
        ruleArn,
        forwardMode,
        targetGroupArn: activeTargetGroupArn,
        capturedAt: Date.now(),
      },
    };
  }

  async cutover(req: CutoverRequest): Promise<CutoverResult> {
    const cfg = this.configComplete();
    if (!cfg.ok) return { ok: false, reason: cfg.reason, activeTarget: null };
    const id = await this.identityOk();
    if (!id.ok) return { ok: false, reason: id.reason, activeTarget: null };

    const candidateTg = req.aws?.candidateTargetGroupArn ?? this.config.targetGroupArn;
    if (!candidateTg) return { ok: false, reason: AWS_REASON.CONFIG, activeTarget: null };

    // Discover current routing. Never mutate before knowing previous state.
    const discovery = await this.discoverRouting();
    if (!discovery.ok) return { ok: false, reason: discovery.reason, activeTarget: null };
    const previous = discovery.snapshot;

    // Skip mutation if AWS already routes to the candidate target group.
    if (previous.targetGroupArn === candidateTg) {
      return { ok: true, reason: null, activeTarget: previous.targetGroupArn };
    }

    // Perform the real ALB forward-action change.
    let mutationOk = false;
    let mutationReason: string | null = null;
    if (previous.forwardMode === "rule" && previous.ruleArn) {
      const forwardConfig = JSON.stringify({
        TargetGroups: [{ TargetGroupArn: candidateTg, Weight: 1 }],
      });
      const r = await this.aws([
        "elbv2", "modify-rule",
        "--rule-arn", previous.ruleArn,
        "--actions", "Type=forward,ForwardConfig=" + forwardConfig,
      ]);
      mutationOk = r.ok;
      mutationReason = r.reason;
    } else {
      const forwardConfig = JSON.stringify({
        TargetGroups: [{ TargetGroupArn: candidateTg, Weight: 1 }],
      });
      const r = await this.aws([
        "elbv2", "modify-listener",
        "--listener-arn", previous.listenerArn,
        "--default-actions", "Type=forward,ForwardConfig=" + forwardConfig,
      ]);
      mutationOk = r.ok;
      mutationReason = r.reason;
    }
    if (!mutationOk) return { ok: false, reason: mutationReason ?? "AWS_ROUTING_MUTATION_FAILED", activeTarget: null };

    // Re-read AWS to confirm the routing actually changed.
    const verify = await this.discoverRouting();
    if (!verify.ok) return { ok: false, reason: "AWS_ROUTING_VERIFICATION_FAILED:" + verify.reason, activeTarget: null };
    if (verify.snapshot.targetGroupArn !== candidateTg) {
      return { ok: false, reason: "AWS_ROUTING_DID_NOT_APPLY", activeTarget: verify.snapshot.targetGroupArn };
    }

    return { ok: true, reason: null, activeTarget: verify.snapshot.targetGroupArn };
  }

  async revert(req: CutoverRequest): Promise<CutoverResult> {
    const cfg = this.configComplete();
    if (!cfg.ok) return { ok: false, reason: cfg.reason, activeTarget: null };
    const id = await this.identityOk();
    if (!id.ok) return { ok: false, reason: id.reason, activeTarget: null };

    const previousTg = req.aws?.previousTargetGroupArn;
    if (!previousTg) return { ok: false, reason: "AWS_PREVIOUS_TARGET_GROUP_NOT_PROVIDED", activeTarget: null };

    const discovery = await this.discoverRouting();
    if (!discovery.ok) return { ok: false, reason: discovery.reason, activeTarget: null };
    const current = discovery.snapshot;

    if (current.targetGroupArn === previousTg) {
      return { ok: true, reason: null, activeTarget: current.targetGroupArn };
    }

    const forwardConfig = JSON.stringify({
      TargetGroups: [{ TargetGroupArn: previousTg, Weight: 1 }],
    });
    let mutationOk = false;
    let mutationReason: string | null = null;
    if (current.forwardMode === "rule" && current.ruleArn) {
      const r = await this.aws([
        "elbv2", "modify-rule",
        "--rule-arn", current.ruleArn,
        "--actions", "Type=forward,ForwardConfig=" + forwardConfig,
      ]);
      mutationOk = r.ok;
      mutationReason = r.reason;
    } else {
      const r = await this.aws([
        "elbv2", "modify-listener",
        "--listener-arn", current.listenerArn,
        "--default-actions", "Type=forward,ForwardConfig=" + forwardConfig,
      ]);
      mutationOk = r.ok;
      mutationReason = r.reason;
    }
    if (!mutationOk) return { ok: false, reason: mutationReason ?? "AWS_ROUTING_REVERT_FAILED", activeTarget: null };

    const verify = await this.discoverRouting();
    if (!verify.ok) return { ok: false, reason: "AWS_ROUTING_REVERT_VERIFICATION_FAILED:" + verify.reason, activeTarget: null };
    if (verify.snapshot.targetGroupArn !== previousTg) {
      return { ok: false, reason: "AWS_ROUTING_REVERT_DID_NOT_APPLY", activeTarget: verify.snapshot.targetGroupArn };
    }

    return { ok: true, reason: null, activeTarget: verify.snapshot.targetGroupArn };
  }

  async resolveActive(environment: string): Promise<ActiveTarget | null> {
    const d = await this.discoverRouting();
    if (!d.ok) return null;
    return {
      environment,
      targetName: d.snapshot.targetGroupArn,
      containerId: null,
      imageId: null,
      imageDigest: null,
    };
  }

  async resolveTarget(
    environment: string,
    _identity: { releaseId: string | null; imageDigest: string | null },
  ): Promise<RouterTargetBinding | null> {
    const d = await this.discoverRouting();
    if (!d.ok) return null;
    return {
      environment,
      provider: "load-balancer",
      providerTargetId: d.snapshot.targetGroupArn,
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
      containerPort: null,
      observedAt: d.snapshot.capturedAt,
    };
  }

  async validateTarget(target: RouterTargetBinding): Promise<{ valid: boolean; reason: string | null }> {
    const cfg = this.configComplete();
    if (!cfg.ok) return { valid: false, reason: cfg.reason };
    const id = await this.identityOk();
    if (!id.ok) return { valid: false, reason: id.reason };
    const tgs = await this.aws(["elbv2", "describe-target-groups"]);
    if (!tgs.ok) return { valid: false, reason: tgs.reason ?? AWS_REASON.RESOURCE };
    let doc: TargetGroupDoc = {};
    try { doc = JSON.parse(tgs.stdout) as TargetGroupDoc; } catch { return { valid: false, reason: "AWS_MALFORMED_RESPONSE" }; }
    const tgExists = (doc.TargetGroups ?? []).some((g) => g.TargetGroupArn === target.providerTargetId);
    if (!tgExists) return { valid: false, reason: AWS_REASON.RESOURCE };
    const h = await this.health(target.providerTargetId);
    if (h.verdict !== "HEALTHY") return { valid: false, reason: "TARGET_NOT_HEALTHY:" + h.verdict };
    return { valid: true, reason: null };
  }

  async health(targetId: string): Promise<RouterHealthResult> {
    const cfg = this.configComplete();
    if (!cfg.ok) return { verdict: "BLOCKED", targetId: null, reason: cfg.reason, probedAt: Date.now() };
    const id = await this.identityOk();
    if (!id.ok) return { verdict: "BLOCKED", targetId: null, reason: id.reason, probedAt: Date.now() };
    const r = await this.aws(["elbv2", "describe-target-health", "--target-group-arn", targetId]);
    if (!r.ok) return { verdict: "UNKNOWN", targetId, reason: r.reason ?? "AWS_DESCRIBE_HEALTH_FAILED", probedAt: Date.now() };
    try {
      const doc = JSON.parse(r.stdout) as TargetHealthDoc;
      const list = doc.TargetHealthDescriptions ?? [];
      if (list.length === 0) return { verdict: "UNKNOWN", targetId, reason: "NO_TARGETS", probedAt: Date.now() };
      const healthy = list.filter((x) => x.TargetHealth?.State === "healthy").length;
      const unhealthy = list.filter((x) => x.TargetHealth?.State === "unhealthy").length;
      if (healthy > 0 && unhealthy === 0) return { verdict: "HEALTHY", targetId, reason: null, probedAt: Date.now() };
      if (unhealthy > 0) return { verdict: "UNHEALTHY", targetId, reason: `unhealthy=${unhealthy}`, probedAt: Date.now() };
      return { verdict: "UNKNOWN", targetId, reason: "INSUFFICIENT_HEALTH_DATA", probedAt: Date.now() };
    } catch {
      return { verdict: "UNKNOWN", targetId, reason: "AWS_MALFORMED_RESPONSE", probedAt: Date.now() };
    }
  }

  async reconcile(desired: RouterTargetBinding | null): Promise<RouterReconcileResult> {
    const cfg = this.configComplete();
    if (!cfg.ok) return { verdict: "PROVIDER_UNAVAILABLE", reason: cfg.reason, desiredTargetId: desired?.providerTargetId ?? null, observedTargetId: null, reconciledAt: Date.now() };
    const id = await this.identityOk();
    if (!id.ok) return { verdict: "AUTHENTICATION_BLOCKED", reason: id.reason, desiredTargetId: desired?.providerTargetId ?? null, observedTargetId: null, reconciledAt: Date.now() };
    const d = await this.discoverRouting();
    if (!d.ok) return { verdict: "PROVIDER_UNAVAILABLE", reason: d.reason, desiredTargetId: desired?.providerTargetId ?? null, observedTargetId: null, reconciledAt: Date.now() };
    const desiredTg = desired?.providerTargetId ?? null;
    const observedTg = d.snapshot.targetGroupArn;
    if (desiredTg && desiredTg === observedTg) {
      const h = await this.health(observedTg);
      if (h.verdict === "UNHEALTHY") return { verdict: "HEALTH_DEGRADED", reason: h.reason, desiredTargetId: desiredTg, observedTargetId: observedTg, reconciledAt: Date.now() };
      return { verdict: "IN_SYNC", reason: null, desiredTargetId: desiredTg, observedTargetId: observedTg, reconciledAt: Date.now() };
    }
    if (!desiredTg) return { verdict: "TARGET_MISSING", reason: "no desired target group", desiredTargetId: null, observedTargetId: observedTg, reconciledAt: Date.now() };
    return { verdict: "DRIFT", reason: "observed forward target differs from desired", desiredTargetId: desiredTg, observedTargetId: observedTg, reconciledAt: Date.now() };
  }

  async capabilities(): Promise<RouterCapabilityReport> {
    // Adapter support is fixed: this class implements the full routing model.
    // Runtime readiness is a separate probe.
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
