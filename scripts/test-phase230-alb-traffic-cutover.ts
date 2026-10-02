// scripts/test-phase230-alb-traffic-cutover.ts
// Phase 230 - real AWS ALB traffic cutover, verification and rollback.
//
// The AwsCliRunner interface allows deterministic verification of the exact
// AWS CLI commands a cutover/revert/discovery would issue without touching
// AWS. Real AWS integration is BLOCKED (credentials not configured).

import { NexusKernel } from "../src/core/kernel";
import { AWSTrafficRouter, type AwsCliRunner, type AwsCommandResult, readAwsTrafficRouterConfig } from "../src/core/aws-traffic-router";
import { discoverTrafficRouter } from "../src/core/traffic-router-factory";
import { createNodeBridge } from "./host-bridge-node";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

type R = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
const rows: { id: string; name: string; r: R; n: string }[] = [];
function rec(id: string, name: string, r: R, n: string) {
  rows.push({ id, name, r, n });
  const m = r === "PASS" ? "[PASS]" : r === "FAIL" ? "[FAIL]" : r === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${m} ${id} ${name} -- ${n}`);
}
function ok(c: boolean, m: string) { if (!c) throw new Error(m); }
function rid(p: string) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/** Spy runner that records every command and returns scripted responses. */
class SpyRunner implements AwsCliRunner {
  calls: string[][] = [];
  private handlers: Array<{ match: (args: string[]) => boolean; respond: (args: string[]) => AwsCommandResult }> = [];

  when(match: (args: string[]) => boolean, respond: (args: string[]) => AwsCommandResult): this {
    this.handlers.push({ match, respond });
    return this;
  }

  async run(args: string[]): Promise<AwsCommandResult> {
    this.calls.push(args);
    for (const h of this.handlers) {
      if (h.match(args)) return h.respond(args);
    }
    return { ok: false, exitCode: 1, stdout: "", stderr: "NO_HANDLER", reason: "SPY_NO_HANDLER" };
  }

  commandsMatching(prefix: string[]): string[][] {
    return this.calls.filter((c) => prefix.every((p, i) => c[i] === p));
  }
}

function okCmd(args: string[], stdout = ""): AwsCommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", reason: null };
}
function failCmd(reason: string): AwsCommandResult {
  return { ok: false, exitCode: 1, stdout: "", stderr: reason, reason };
}

const STS_OK = JSON.stringify({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/test", UserId: "AIDA" });
const LB_OK = JSON.stringify({ LoadBalancers: [{ LoadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", DNSName: "prod.example.com", State: { Code: "active" } }] });
const LISTENERS_OK = JSON.stringify({ Listeners: [{ ListenerArn: "arn:aws:elb:us-east-1:123456789012:listener/app/prod/abc/def", Port: 443, Protocol: "HTTPS", DefaultActions: [{ Type: "forward", TargetGroupArn: "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-default/111" }] }] });
const RULES_OK = JSON.stringify({ Rules: [{ RuleArn: "arn:aws:elb:us-east-1:123456789012:listener-rule/app/prod/abc/def/ghi", IsDefault: false, Conditions: [], Actions: [{ Type: "forward", TargetGroupArn: "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-old/222" }] }] });
const TG_OK = JSON.stringify({ TargetGroups: [{ TargetGroupArn: "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-new/333", TargetGroupName: "tg-new", Protocol: "HTTP", Port: 8080 }] });
const HEALTH_HEALTHY = JSON.stringify({ TargetHealthDescriptions: [{ Target: { Id: "10.0.0.1", Port: 8080 }, TargetHealth: { State: "healthy" } }] });
const HEALTH_UNHEALTHY = JSON.stringify({ TargetHealthDescriptions: [{ Target: { Id: "10.0.0.1", Port: 8080 }, TargetHealth: { State: "unhealthy", Reason: "Target.FailedHealthChecks" } }] });

async function main() {
  const bridgeRoot = path.join(os.tmpdir(), "nexus-phase230-" + Date.now());
  (globalThis as any).window = { __NEXUS_HOST__: createNodeBridge(bridgeRoot) };
  // 230A: kernel wiring
  let svc: Awaited<ReturnType<NexusKernel["boot"]>> | undefined;
  try {
    const k = new NexusKernel();
    svc = await k.boot();
    ok(!!svc.deploymentActivationService, "activation service missing");
    rec("230A", "kernel wiring", "PASS", `activation=${typeof svc.deploymentActivationService}`);
  } catch (e) { rec("230A", "kernel wiring", "FAIL", String(e)); }

  // 230B: factory preserves AWS-selected-blocked with real reason
  try {
    const env = {
      ...process.env,
      NEXUS_AWS_REGION: "us-east-1",
      NEXUS_AWS_TARGET_GROUP_ARN: "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-new/333",
      NEXUS_AWS_LOAD_BALANCER_ARN: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc",
    };
    const d = await discoverTrafficRouter(env);
    // aws config present -> router kind is load-balancer even if credentials missing
    ok(d.routerKind === "load-balancer", `expected load-balancer, got ${d.routerKind}`);
    ok(d.kind === "aws-selected" || d.kind === "aws-selected-blocked",
       `expected aws-selected*, got ${d.kind}`);
    rec("230B", "factory preserves AWS visibility", "PASS",
        `kind=${d.kind} routerKind=${d.routerKind} reason=${(d.reason ?? "").slice(0, 50)}`);
  } catch (e) { rec("230B", "factory preserves AWS visibility", "FAIL", String(e)); }

  // 230C: missing credentials -> BLOCKED
  try {
    const spy = new SpyRunner().when((a) => a[0] === "sts", () => failCmd("AWS_CREDENTIALS_NOT_CONFIGURED"));
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:lb", listenerArn: null, ruleArn: null, targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    const out = await aws.cutover({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
      aws: { loadBalancerArn: "arn:lb", listenerArn: "arn:l", ruleArn: null, candidateTargetGroupArn: "arn:tg", previousTargetGroupArn: null, targetId: null, targetPort: null },
    });
    ok(out.ok === false, "expected BLOCKED");
    ok(out.reason === "AWS_CREDENTIALS_NOT_CONFIGURED", `reason=${out.reason}`);
    rec("230C", "missing credentials -> BLOCKED", "PASS", `reason=${out.reason}`);
  } catch (e) { rec("230C", "missing credentials -> BLOCKED", "FAIL", String(e)); }

  // 230D: missing region -> BLOCKED
  try {
    const spy = new SpyRunner();
    const cfg = { region: null, loadBalancerArn: "arn:lb", listenerArn: null, ruleArn: null, targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    const out = await aws.cutover({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
      aws: { loadBalancerArn: "arn:lb", listenerArn: "arn:l", ruleArn: null, candidateTargetGroupArn: "arn:tg", previousTargetGroupArn: null, targetId: null, targetPort: null },
    });
    ok(out.ok === false, "expected BLOCKED");
    ok(out.reason === "AWS_REGION_NOT_CONFIGURED", `reason=${out.reason}`);
    rec("230D", "missing region -> BLOCKED", "PASS", `reason=${out.reason}`);
  } catch (e) { rec("230D", "missing region -> BLOCKED", "FAIL", String(e)); }

  // 230E: missing ALB config -> BLOCKED
  try {
    const spy = new SpyRunner();
    const cfg = { region: "us-east-1", loadBalancerArn: null, listenerArn: null, ruleArn: null, targetGroupArn: null, targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    const out = await aws.cutover({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
      aws: undefined,
    });
    ok(out.ok === false, "expected BLOCKED");
    ok(out.reason === "AWS_TRAFFIC_CONFIG_NOT_CONFIGURED", `reason=${out.reason}`);
    rec("230E", "missing ALB config -> BLOCKED", "PASS", `reason=${out.reason}`);
  } catch (e) { rec("230E", "missing ALB config -> BLOCKED", "FAIL", String(e)); }

  // 230F: describe-load-balancers command construction
  try {
    const spy = new SpyRunner()
      .when((a) => a[0] === "sts", () => okCmd([], STS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-load-balancers", () => okCmd([], LB_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-listeners", () => okCmd([], LISTENERS_OK));
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", listenerArn: null, ruleArn: null, targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    await aws.discoverRouting();
    const calls = spy.commandsMatching(["elbv2", "describe-load-balancers"]);
    ok(calls.length === 1, `expected 1 describe-load-balancers call, got ${calls.length}`);
    const c = calls[0];
    ok(c.includes("--load-balancer-arns"), "missing --load-balancer-arns");
    ok(c.includes(cfg.loadBalancerArn), "wrong ARN value");
    rec("230F", "describe-load-balancers command", "PASS", `args=${c.join(" ")}`);
  } catch (e) { rec("230F", "describe-load-balancers command", "FAIL", String(e)); }

  // 230G: describe-listeners command construction
  try {
    const spy = new SpyRunner()
      .when((a) => a[0] === "sts", () => okCmd([], STS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-load-balancers", () => okCmd([], LB_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-listeners", () => okCmd([], LISTENERS_OK));
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", listenerArn: null, ruleArn: null, targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    await aws.discoverRouting();
    const calls = spy.commandsMatching(["elbv2", "describe-listeners"]);
    ok(calls.length === 1, `expected 1 describe-listeners call, got ${calls.length}`);
    ok(calls[0].includes("--load-balancer-arn"), "missing --load-balancer-arn");
    rec("230G", "describe-listeners command", "PASS", `args=${calls[0].join(" ")}`);
  } catch (e) { rec("230G", "describe-listeners command", "FAIL", String(e)); }

  // 230H: describe-rules command construction (rule mode)
  try {
    const spy = new SpyRunner()
      .when((a) => a[0] === "sts", () => okCmd([], STS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-load-balancers", () => okCmd([], LB_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-listeners", () => okCmd([], LISTENERS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-rules", () => okCmd([], RULES_OK));
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", listenerArn: "arn:aws:elb:us-east-1:123456789012:listener/app/prod/abc/def", ruleArn: "arn:aws:elb:us-east-1:123456789012:listener-rule/app/prod/abc/def/ghi", targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    await aws.discoverRouting();
    const calls = spy.commandsMatching(["elbv2", "describe-rules"]);
    ok(calls.length === 1, `expected 1 describe-rules call, got ${calls.length}`);
    ok(calls[0].includes("--listener-arn"), "missing --listener-arn");
    rec("230H", "describe-rules command", "PASS", `args=${calls[0].join(" ")}`);
  } catch (e) { rec("230H", "describe-rules command", "FAIL", String(e)); }

  // 230I: describe-target-groups command construction
  try {
    const spy = new SpyRunner()
      .when((a) => a[0] === "sts", () => okCmd([], STS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-target-groups", () => okCmd([], TG_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-target-health", () => okCmd([], HEALTH_HEALTHY));
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:lb", listenerArn: null, ruleArn: null, targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    await aws.validateTarget({
      environment: "t", provider: "load-balancer",
      providerTargetId: "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-new/333",
      endpoint: null, releaseId: null, deploymentId: null, commitSha: null,
      imageRepository: null, imageTag: null, imageId: null, imageDigest: null,
      containerId: null, containerName: null, containerPort: null, observedAt: 0,
    });
    const calls = spy.commandsMatching(["elbv2", "describe-target-groups"]);
    ok(calls.length === 1, `expected 1 describe-target-groups call, got ${calls.length}`);
    rec("230I", "describe-target-groups command", "PASS", `args=${calls[0].join(" ")}`);
  } catch (e) { rec("230I", "describe-target-groups command", "FAIL", String(e)); }

  // 230J: describe-target-health command construction
  try {
    const spy = new SpyRunner()
      .when((a) => a[0] === "sts", () => okCmd([], STS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-target-health", () => okCmd([], HEALTH_HEALTHY));
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:lb", listenerArn: null, ruleArn: null, targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    await aws.health("arn:aws:elb:us-east-1:123456789012:targetgroup/tg-new/333");
    const calls = spy.commandsMatching(["elbv2", "describe-target-health"]);
    ok(calls.length === 1, `expected 1 describe-target-health call, got ${calls.length}`);
    ok(calls[0].includes("--target-group-arn"), "missing --target-group-arn");
    rec("230J", "describe-target-health command", "PASS", `args=${calls[0].join(" ")}`);
  } catch (e) { rec("230J", "describe-target-health command", "FAIL", String(e)); }
  // 230K: modify-listener command construction (listener-default mode)
  try {
    const spy = new SpyRunner()
      .when((a) => a[0] === "sts", () => okCmd([], STS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-load-balancers", () => okCmd([], LB_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-listeners", () => okCmd([], LISTENERS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "modify-listener", () => okCmd([], "{}"));
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", listenerArn: null, ruleArn: null, targetGroupArn: "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-new/333", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    await aws.cutover({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
      aws: { loadBalancerArn: cfg.loadBalancerArn, listenerArn: null, ruleArn: null, candidateTargetGroupArn: cfg.targetGroupArn, previousTargetGroupArn: null, targetId: null, targetPort: null },
    });
    const calls = spy.commandsMatching(["elbv2", "modify-listener"]);
    ok(calls.length === 1, `expected 1 modify-listener call, got ${calls.length}`);
    ok(calls[0].includes("--listener-arn"), "missing --listener-arn");
    ok(calls[0].includes("--default-actions"), "missing --default-actions");
    ok(calls[0].some((x) => x.includes("tg-new/333")), "missing candidate TG in default-actions");
    rec("230K", "modify-listener command", "PASS", `args=${calls[0].join(" ").slice(0, 100)}`);
  } catch (e) { rec("230K", "modify-listener command", "FAIL", String(e)); }

  // 230L: modify-rule command construction (rule mode)
  try {
    const spy = new SpyRunner()
      .when((a) => a[0] === "sts", () => okCmd([], STS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-load-balancers", () => okCmd([], LB_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-listeners", () => okCmd([], LISTENERS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-rules", () => okCmd([], RULES_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "modify-rule", () => okCmd([], "{}"));
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", listenerArn: null, ruleArn: "arn:aws:elb:us-east-1:123456789012:listener-rule/app/prod/abc/def/ghi", targetGroupArn: "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-new/333", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    await aws.cutover({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
      aws: { loadBalancerArn: cfg.loadBalancerArn, listenerArn: null, ruleArn: cfg.ruleArn, candidateTargetGroupArn: cfg.targetGroupArn, previousTargetGroupArn: null, targetId: null, targetPort: null },
    });
    const calls = spy.commandsMatching(["elbv2", "modify-rule"]);
    ok(calls.length === 1, `expected 1 modify-rule call, got ${calls.length}`);
    ok(calls[0].includes("--rule-arn"), "missing --rule-arn");
    ok(calls[0].includes("--actions"), "missing --actions");
    rec("230L", "modify-rule command", "PASS", `args=${calls[0].join(" ").slice(0, 100)}`);
  } catch (e) { rec("230L", "modify-rule command", "FAIL", String(e)); }

  // 230M: cutover is a no-op when AWS already routes to candidate
  try {
    const spy = new SpyRunner()
      .when((a) => a[0] === "sts", () => okCmd([], STS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-load-balancers", () => okCmd([], LB_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-listeners", () => okCmd([], LISTENERS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "modify-listener", () => failCmd("SHOULD_NOT_BE_CALLED"));
    // Default action forwards to tg-default/111 already
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", listenerArn: null, ruleArn: null, targetGroupArn: "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-default/111", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    const out = await aws.cutover({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
      aws: { loadBalancerArn: cfg.loadBalancerArn, listenerArn: null, ruleArn: null, candidateTargetGroupArn: cfg.targetGroupArn, previousTargetGroupArn: null, targetId: null, targetPort: null },
    });
    ok(out.ok === true, `expected ok=true, got reason=${out.reason}`);
    ok(spy.commandsMatching(["elbv2", "modify-listener"]).length === 0, "modify-listener must not be called");
    rec("230M", "cutover no-op when already routed", "PASS", "AWS already at candidate; no mutation issued");
  } catch (e) { rec("230M", "cutover no-op when already routed", "FAIL", String(e)); }

  // 230N: cutover BLOCKED with real SpawnAwsCliRunner (no credentials)
  try {
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", listenerArn: null, ruleArn: null, targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg);
    const out = await aws.cutover({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
      aws: { loadBalancerArn: cfg.loadBalancerArn, listenerArn: null, ruleArn: null, candidateTargetGroupArn: "arn:tg", previousTargetGroupArn: null, targetId: null, targetPort: null },
    });
    ok(out.ok === false, "expected BLOCKED");
    ok(out.reason === "AWS_CREDENTIALS_NOT_CONFIGURED" || out.reason === "AWS_CLI_FAILED" || (out.reason ?? "").startsWith("AWS_"),
       `reason=${out.reason}`);
    rec("230N", "cutover BLOCKED without credentials", "BLOCKED", `reason=${out.reason}`);
  } catch (e) { rec("230N", "cutover BLOCKED without credentials", "FAIL", String(e)); }

  // 230O: revert BLOCKED with real SpawnAwsCliRunner
  try {
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", listenerArn: null, ruleArn: null, targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg);
    const out = await aws.revert({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
      aws: { loadBalancerArn: cfg.loadBalancerArn, listenerArn: null, ruleArn: null, candidateTargetGroupArn: null, previousTargetGroupArn: "arn:tg-old", targetId: null, targetPort: null },
    });
    ok(out.ok === false, "expected BLOCKED");
    rec("230O", "revert BLOCKED without credentials", "BLOCKED", `reason=${out.reason}`);
  } catch (e) { rec("230O", "revert BLOCKED without credentials", "FAIL", String(e)); }

  // 230P: revert restores previous TG via modify-listener (stateful spy).
  // The describe-listeners handler emits the CURRENT default action, which
  // the modify-listener handler updates on the fly, so post-revert
  // verification observes the change.
  try {
    let currentDefault = "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-default/111";
    const renderListeners = () => JSON.stringify({
      Listeners: [{
        ListenerArn: "arn:aws:elb:us-east-1:123456789012:listener/app/prod/abc/def",
        Port: 443, Protocol: "HTTPS",
        DefaultActions: [{ Type: "forward", TargetGroupArn: currentDefault }],
      }],
    });
    const spy = new SpyRunner()
      .when((a) => a[0] === "sts", () => okCmd([], STS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-load-balancers", () => okCmd([], LB_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-listeners", () => okCmd([], renderListeners()))
      .when((a) => a[0] === "elbv2" && a[1] === "modify-listener", (a) => {
        const fwdArg = a.find((x) => x.includes("ForwardConfig"));
        if (fwdArg) {
          const m = fwdArg.match(/TargetGroupArn[^,}]*?(arn:[^"']+)/);
          if (m) currentDefault = m[1];
        }
        return okCmd([], "{}");
      });
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", listenerArn: null, ruleArn: null, targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    const out = await aws.revert({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
      aws: { loadBalancerArn: cfg.loadBalancerArn, listenerArn: null, ruleArn: null, candidateTargetGroupArn: null, previousTargetGroupArn: "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-old/999", targetId: null, targetPort: null },
    });
    const calls = spy.commandsMatching(["elbv2", "modify-listener"]);
    ok(calls.length === 1, `expected 1 modify-listener call, got ${calls.length}`);
    ok(calls[0].some((x) => x.includes("tg-old/999")), "missing previous TG in default-actions");
    ok(out.ok === true, `expected revert ok, got reason=${out.reason}`);
    rec("230P", "revert restores previous TG", "PASS", `args=${calls[0].join(" ").slice(0, 100)}`);
  } catch (e) { rec("230P", "revert restores previous TG", "FAIL", String(e)); }

  // 230Q: reconcile IN_SYNC when AWS routing matches desired
  try {
    const spy = new SpyRunner()
      .when((a) => a[0] === "sts", () => okCmd([], STS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-load-balancers", () => okCmd([], LB_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-listeners", () => okCmd([], LISTENERS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-target-health", () => okCmd([], HEALTH_HEALTHY));
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", listenerArn: null, ruleArn: null, targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    const r = await aws.reconcile({
      environment: "t", provider: "load-balancer",
      providerTargetId: "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-default/111",
      endpoint: null, releaseId: null, deploymentId: null, commitSha: null,
      imageRepository: null, imageTag: null, imageId: null, imageDigest: null,
      containerId: null, containerName: null, containerPort: null, observedAt: 0,
    });
    ok(r.verdict === "IN_SYNC", `expected IN_SYNC, got ${r.verdict}`);
    rec("230Q", "reconcile IN_SYNC", "PASS", `verdict=${r.verdict}`);
  } catch (e) { rec("230Q", "reconcile IN_SYNC", "FAIL", String(e)); }

  // 230R: reconcile DRIFT when AWS routing differs
  try {
    const spy = new SpyRunner()
      .when((a) => a[0] === "sts", () => okCmd([], STS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-load-balancers", () => okCmd([], LB_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-listeners", () => okCmd([], LISTENERS_OK));
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", listenerArn: null, ruleArn: null, targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    const r = await aws.reconcile({
      environment: "t", provider: "load-balancer",
      providerTargetId: "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-different/999",
      endpoint: null, releaseId: null, deploymentId: null, commitSha: null,
      imageRepository: null, imageTag: null, imageId: null, imageDigest: null,
      containerId: null, containerName: null, containerPort: null, observedAt: 0,
    });
    ok(r.verdict === "DRIFT", `expected DRIFT, got ${r.verdict}`);
    rec("230R", "reconcile DRIFT", "PASS", `verdict=${r.verdict}`);
  } catch (e) { rec("230R", "reconcile DRIFT", "FAIL", String(e)); }
  // 230S: capability semantics
  try {
    const spy = new SpyRunner().when((a) => a[0] === "sts", () => okCmd([], STS_OK));
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:lb", listenerArn: null, ruleArn: null, targetGroupArn: "arn:tg", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    const cap = await aws.capabilities();
    ok(cap.canCutover === true, `expected canCutover=true when identity ok, got ${cap.canCutover}`);
    ok(cap.kind === "load-balancer", `kind=${cap.kind}`);
    // Missing region -> capabilities false
    const aws2 = new AWSTrafficRouter({ ...cfg, region: null }, spy);
    const cap2 = await aws2.capabilities();
    ok(cap2.canCutover === false, `expected canCutover=false without region, got ${cap2.canCutover}`);
    ok(cap2.reason === "AWS_REGION_NOT_CONFIGURED", `reason=${cap2.reason}`);
    rec("230S", "capability semantics", "PASS", `enabled=${cap.canCutover} disabled=${cap2.canCutover}`);
  } catch (e) { rec("230S", "capability semantics", "FAIL", String(e)); }

  // 230T: no fake ACTIVE without provider confirmation
  try {
    // Real kernel service with real (blocked) router — activation must not reach ACTIVE
    const inp = {
      releaseId: rid("rel230T-"),
      executionId: rid("exec230T-"),
      attemptId: rid("att230T-"),
      artifactId: "art230T",
      artifactDigest: "sha256:" + "a".repeat(64),
      commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      environment: "phase230-test-T",
      projectId: "phase230-proj",
      imageRepository: "nexus-app",
      imageTag: "version-a",
      imageId: null,
      imageDigest: "sha256:" + "b".repeat(64),
      containerName: "nexus-230-T",
      containerPort: 8080,
    };
    const r = await svc!.releaseIntents!.getOrCreateAsync(inp as any);
    const key = r.intent.intentKey;
    const w = rid("w230T-");
    await svc!.releaseIntents!.acquireLeaseAsync(key, w);
    await svc!.releaseIntents!.transitionIfOwnedAsync(key, "DEPLOYING", w, {}, ["DEPLOYMENT_INTENT_CREATED"]);
    await svc!.releaseIntents!.transitionIfOwnedAsync(key, "HEALTH_CHECKING", w, {}, ["DEPLOYING"]);
    await svc!.releaseIntents!.transitionIfOwnedAsync(key, "SMOKE_TESTING", w, {}, ["HEALTH_CHECKING"]);
    await svc!.releaseIntents!.transitionIfOwnedAsync(key, "KNOWN_GOOD", w, {}, ["SMOKE_TESTING"]);
    await svc!.releaseIntents!.releaseLeaseAsync(key, w);
    const act = await svc!.deploymentActivationService!.activate(key, rid("w230Tact-"));
    const after = await svc!.releaseIntents!.getAsync(key);
    ok(after?.status !== "ACTIVE", `intent reached ACTIVE without provider: ${after?.status}`);
    rec("230T", "no fake ACTIVE without provider", "PASS", `act=${act.status} intent=${after?.status}`);
  } catch (e) { rec("230T", "no fake ACTIVE without provider", "FAIL", String(e)); }

  // 230U: previous routing snapshot captured before mutation
  try {
    const spy = new SpyRunner()
      .when((a) => a[0] === "sts", () => okCmd([], STS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-load-balancers", () => okCmd([], LB_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "describe-listeners", () => okCmd([], LISTENERS_OK))
      .when((a) => a[0] === "elbv2" && a[1] === "modify-listener", () => okCmd([], "{}"));
    const cfg = { region: "us-east-1", loadBalancerArn: "arn:aws:elb:us-east-1:123456789012:loadbalancer/app/prod/abc", listenerArn: null, ruleArn: null, targetGroupArn: "arn:aws:elb:us-east-1:123456789012:targetgroup/tg-new/333", targetPort: null };
    const aws = new AWSTrafficRouter(cfg, spy);
    await aws.cutover({
      environment: "t", intentKey: "k", releaseId: "r", commitSha: "c",
      imageRepository: "x", imageTag: "y", imageId: null, imageDigest: null,
      containerName: "n", containerPort: 0, previousContainerName: null,
      aws: { loadBalancerArn: cfg.loadBalancerArn, listenerArn: null, ruleArn: null, candidateTargetGroupArn: cfg.targetGroupArn, previousTargetGroupArn: null, targetId: null, targetPort: null },
    });
    // Verify order: describe-* must come before modify-listener
    const describeIdx = spy.calls.findIndex((c) => c[0] === "elbv2" && c[1] === "describe-listeners");
    const modifyIdx = spy.calls.findIndex((c) => c[0] === "elbv2" && c[1] === "modify-listener");
    ok(describeIdx >= 0 && modifyIdx >= 0, `describe=${describeIdx} modify=${modifyIdx}`);
    ok(describeIdx < modifyIdx, "describe-listeners must precede modify-listener");
    rec("230U", "previous routing captured before mutation", "PASS",
        `describe@${describeIdx} modify@${modifyIdx}`);
  } catch (e) { rec("230U", "previous routing captured before mutation", "FAIL", String(e)); }

  // 230V: real AWS integration
  try {
    const cfg = readAwsTrafficRouterConfig(process.env);
    const aws = new AWSTrafficRouter(cfg);
    const cap = await aws.capabilities();
    if (cap.canCutover) {
      rec("230V", "real AWS ALB cutover", "NOT EXECUTED",
          "AWS configured; test disabled without NEXUS_AWS_TEST_MODE=1");
    } else {
      rec("230V", "real AWS ALB cutover", "BLOCKED", `cannot execute: ${cap.reason}`);
    }
  } catch (e) { rec("230V", "real AWS ALB cutover", "FAIL", String(e)); }

  // 230W: TypeScript compiles
  try {
    execSync("npx tsc --noEmit", { stdio: "pipe", timeout: 120_000 });
    rec("230W", "typecheck", "PASS", "tsc --noEmit exit=0");
  } catch (e: any) {
    rec("230W", "typecheck", "FAIL", String(e).slice(0, 120));
  }

  finish();
}

function finish() {
  console.log("");
  console.log("===== Phase 230 summary =====");
  const pass = rows.filter(r => r.r === "PASS").length;
  const fail = rows.filter(r => r.r === "FAIL").length;
  const blk  = rows.filter(r => r.r === "BLOCKED").length;
  const ne   = rows.filter(r => r.r === "NOT EXECUTED").length;
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fail}`);
  console.log(`BLOCKED: ${blk}`);
  console.log(`NOT EXECUTED: ${ne}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });