/**
 * NEXUS Control Plane — kernel truth: boot sequence, subsystem health,
 * configuration (safe values only), agent registry and the real Phase 1
 * verification suite runner.
 */

import { useCallback, useEffect, useState } from "react";
import { useNexus } from "../state";
import { runPhase1Suite } from "../core/tests";
import { CONFIG } from "../core/config";
import { detectCapabilities } from "../core/capabilities";
import type { CapabilityReport } from "../core/capabilities";
import { GATE_STAGES } from "../core/runtime";
import type { GateEvidence, GateStage, RuntimeStatus, SmokeRunResult } from "../core/runtime";
import { Badge, Button, Icon, Reveal, SectionHead, Skeleton, StatusPill, cx, fmtDuration, timeAgo } from "../ui";
import type { HealthReport, QualityGateResult, SuiteReport } from "../core/types";

export function ControlPlaneScreen() {
  const { kernel, services, bootSteps } = useNexus();
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [suite, setSuite] = useState<SuiteReport | null>(null);
  const [running, setRunning] = useState(false);
  const [openTest, setOpenTest] = useState<string | null>(null);
  const [caps, setCaps] = useState<CapabilityReport | null>(null);

  const refresh = useCallback(async () => {
    if (kernel) setHealth(await kernel.health());
  }, [kernel]);

  useEffect(() => {
    void refresh();
    const iv = window.setInterval(() => void refresh(), 6000);
    return () => window.clearInterval(iv);
  }, [refresh]);

  // Real runtime capability detection — probes by attempting execution and
  // reports AVAILABLE / UNAVAILABLE / BLOCKED / UNKNOWN. Never infers from
  // package names. Runs once on mount and when the user re-scans.
  const [scanning, setScanning] = useState(false);
  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setCaps(await detectCapabilities());
    } finally {
      setScanning(false);
    }
  }, []);
  useEffect(() => {
    void scan();
  }, [scan]);

  const runSuite = async () => {
    setRunning(true);
    setSuite(null);
    try {
      const report = await runPhase1Suite();
      setSuite(report);
    } catch (e) {
      setSuite({ results: [{ name: "suite startup", category: "kernel", status: "FAILED", duration_ms: 0, evidence: null, error: (e as Error).message, timestamp: Date.now() }], passed: 0, failed: 1, blocked: 0, duration_ms: 0, ran_at: Date.now(), engine: services?.engine.kind ?? "unknown" });
    } finally {
      setRunning(false);
    }
  };

  const agents = services?.registry.list() ?? [];
  const config = kernel?.configView() ?? {};

  /* ---- Runtime bridge: real capability detection + smoke + quality gate ---- */
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [stagingUrl, setStagingUrl] = useState("http://localhost:8080");
  const [healthUrl, setHealthUrl] = useState("");
  const [smokeRunning, setSmokeRunning] = useState(false);
  const [smokeResult, setSmokeResult] = useState<SmokeRunResult | null>(null);
  const [gate, setGate] = useState<Partial<Record<GateStage, GateEvidence>>>({});
  const [gateResult, setGateResult] = useState<QualityGateResult | null>(null);

  const detectRuntime = useCallback(async () => {
    if (!services) return;
    setDetecting(true);
    try {
      setRuntime(await services.runtime.detect());
    } finally {
      setDetecting(false);
    }
  }, [services]);
  useEffect(() => {
    void detectRuntime();
  }, [detectRuntime]);

  const runSmoke = async () => {
    if (!services || !stagingUrl.trim()) return;
    setSmokeRunning(true);
    setSmokeResult(null);
    try {
      const res = await services.runtime.smoke.run({
        execution_id: null,
        staging_url: stagingUrl.trim(),
        health_url: healthUrl.trim() || undefined,
      });
      setSmokeResult(res);
      // Populate HEALTH + SMOKE gate entries from the REAL result.
      const healthStatus: GateEvidence["status"] = res.health.ok
        ? "PASS"
        : res.health.status_code === null && res.health.response_time_ms === null
          ? "BLOCKED"
          : "FAIL";
      const smokeStatus: GateEvidence["status"] = res.smoke.status === "PASSED" ? "PASS" : res.smoke.status === "FAILED" ? "FAIL" : "BLOCKED";
      setGate((g) => ({
        ...g,
        HEALTH: { status: healthStatus, reason: res.health.error },
        SMOKE: { status: smokeStatus, reason: res.smoke.status === "PASSED" ? null : res.smoke.detail },
      }));
    } finally {
      setSmokeRunning(false);
    }
  };

  const evaluateGate = async () => {
    if (!services) return;
    setGateResult(await services.runtime.qualityGate.evaluate(null, gate));
  };

  const capChip = (name: string, status: string | undefined) => {
    const tone = status === "AVAILABLE" ? "moss" : status === "BLOCKED" ? "gold" : status === "UNAVAILABLE" ? "flame" : "mut";
    return (
      <span className="flex items-center justify-between gap-2 rounded-md border border-edge bg-ink-850 px-2.5 py-1.5">
        <span className="font-mono text-[11px] text-mut">{name}</span>
        <Badge tone={tone as never}>{status ?? "—"}</Badge>
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <SectionHead
        kicker="kernel truth"
        title="Control Plane"
        sub="Live platform state — boot order, subsystem probes, configuration and the real verification suite. Nothing here is simulated."
        right={
          health ? (
            <span className="flex items-center gap-2">
              <span className={cx("h-2 w-2 rounded-full", health.status === "healthy" ? "bg-moss pulse-dot" : health.status === "degraded" ? "bg-gold" : "bg-flame")} />
              <span className="font-mono text-xs uppercase text-mut">{health.status}</span>
            </span>
          ) : null
        }
      />

      <div className="grid lg:grid-cols-2 gap-4">
        {/* boot sequence */}
        <Reveal>
          <div className="panel overflow-hidden">
            <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-3"><Icon name="terminal" size={11} /> kernel boot sequence</div>
            <div className="scanlines pointer-events-none relative">
              {bootSteps.map((s, i) => (
                <div key={s.id} className="flex items-center gap-3 border-b border-edge/50 px-4 py-2.5 last:border-0">
                  <span className="font-mono text-[10px] text-dim tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                  <span className={cx("flex w-4 justify-center", s.status === "ok" ? "text-moss" : s.status === "fail" ? "text-flame" : s.status === "running" ? "text-gold" : "text-dim")}>
                    {s.status === "ok" ? <Icon name="check" size={13} /> : s.status === "fail" ? <Icon name="x" size={13} /> : s.status === "running" ? <span className="h-1.5 w-1.5 animate-ping rounded-full bg-gold" /> : <span className="h-1 w-1 rounded-full bg-dim" />}
                  </span>
                  <span className={cx("font-mono text-xs", s.status === "pending" ? "text-dim" : "text-fg")}>{s.label}</span>
                  <span className="ml-auto truncate font-mono text-[10px] text-dim">{s.detail ?? ""}</span>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        {/* subsystem health */}
        <Reveal delay={70}>
          <div className="panel overflow-hidden">
            <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-3"><Icon name="pulse" size={11} /> subsystem probes · real round-trips</div>
            {!health ? (
              <div className="space-y-2 p-4"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
            ) : (
              <>
                {health.subsystems.map((s) => (
                  <div key={s.name} className="flex items-center gap-3 border-b border-edge/50 px-4 py-2.5 last:border-0">
                    <span className={cx("h-1.5 w-1.5 rounded-full", s.status === "healthy" ? "bg-moss" : s.status === "degraded" ? "bg-gold" : "bg-flame")} />
                    <span className="w-24 font-mono text-xs text-fg">{s.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-dim">{s.detail}</span>
                    {s.latency_ms !== null ? <span className="shrink-0 font-mono text-[10px] text-mut tabular-nums">{s.latency_ms}ms</span> : null}
                    <StatusPill status={s.status} />
                  </div>
                ))}
                <p className="px-4 py-2.5 font-mono text-[10px] text-dim">
                  version {health.version} · engine <span className="text-mut">{health.engine}</span>
                  {health.engine === "memory" ? " · PERSISTENCE RUNTIME: non-browser fallback — durability not verified" : " · durable IndexedDB persistence"}
                </p>
              </>
            )}
          </div>
        </Reveal>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* configuration */}
        <Reveal delay={110}>
          <div className="panel overflow-hidden">
            <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-3"><Icon name="shield" size={11} /> configuration state · safe values only</div>
            <div className="grid grid-cols-2 gap-2 p-4">
              {Object.entries(config).map(([k, v]) => (
                <div key={k} className="panel-inset p-2.5">
                  <span className="mono-label block">{k}</span>
                  <span className="mt-0.5 block truncate font-mono text-xs text-mut">
                    {Array.isArray(v) ? (v.length ? v.join(" · ") : "no issues") : String(v)}
                  </span>
                </div>
              ))}
            </div>
            <p className="border-t border-edge/60 px-4 py-2.5 font-mono text-[10px] text-dim">
              secrets are never echoed: keys, passwords and tokens live only in the environment or the secret provider
            </p>
          </div>
        </Reveal>

        {/* agents */}
        <Reveal delay={150}>
          <div className="panel overflow-hidden">
            <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-3"><Icon name="cpu" size={11} /> agent registry · {agents.length}</div>
            {agents.map((a) => (
              <div key={a.id} className="border-b border-edge/50 px-4 py-3 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-mint">{a.id}</span>
                  <Badge tone="mut">v{a.version}</Badge>
                  <span className="ml-auto flex gap-1">{a.capabilities.map((c) => <Badge key={c} tone="sky">{c}</Badge>)}</span>
                </div>
                <p className="mt-1 text-xs text-mut">{a.description}</p>
              </div>
            ))}
            <p className="px-4 py-2.5 font-mono text-[10px] text-dim">
              Phase 1 ships the foundation + one reference agent; capable agents arrive in later phases behind this same contract
            </p>
          </div>
        </Reveal>
      </div>

      {/* runtime capability detection */}
      <Reveal delay={170}>
        <div className="panel overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-3">
            <span className="mono-label flex items-center gap-2"><Icon name="cpu" size={11} /> runtime capability detection · execution-based</span>
            <span className="font-mono text-[10px] text-dim">probes attempt real execution — AVAILABLE only when it genuinely works here; shell-bound tooling in this browser is reported honestly</span>
            <span className="ml-auto flex items-center gap-2">
              {caps ? (
                <span className="flex gap-1.5 font-mono text-[10px]">
                  <Badge tone="moss">{caps.summary.AVAILABLE} avail</Badge>
                  <Badge tone="mut">{caps.summary.UNAVAILABLE} unavail</Badge>
                  <Badge tone="gold">{caps.summary.BLOCKED} blocked</Badge>
                </span>
              ) : null}
              <Button variant="outline" size="sm" icon="refresh" loading={scanning} onClick={() => void scan()}>
                {scanning ? "scanning…" : "rescan"}
              </Button>
            </span>
          </div>

          {!caps ? (
            <div className="space-y-2 p-4"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
          ) : (
            <div className="grid md:grid-cols-2">
              {caps.probes.map((p) => (
                <div key={p.name} className="flex items-center gap-3 border-b border-edge/50 px-4 py-2.5">
                  <span
                    className={cx(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      p.status === "AVAILABLE" ? "bg-moss" : p.status === "UNAVAILABLE" ? "bg-dim" : p.status === "BLOCKED" ? "bg-gold" : "bg-sky",
                    )}
                  />
                  <span className="w-44 shrink-0 truncate font-mono text-xs text-fg">{p.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-dim" title={p.detail}>{p.detail}</span>
                  {p.latency_ms !== null ? <span className="shrink-0 font-mono text-[10px] text-mut tabular-nums">{p.latency_ms}ms</span> : null}
                  <StatusPill status={p.status === "AVAILABLE" ? "healthy" : p.status === "UNAVAILABLE" ? "absent" : p.status === "BLOCKED" ? "degraded" : "unknown"} />
                </div>
              ))}
            </div>
          )}
          <p className="border-t border-edge/60 px-4 py-2.5 font-mono text-[10px] leading-relaxed text-dim">
            Docker build, container scanning, image SBOM, staging, health and Playwright smoke all require a real container/browser
            runtime that this sandbox cannot spawn — they remain <span className="text-gold">BLOCKED</span> here and are never reported PASS.
            Source SBOM and static security run in-browser from real manifests. environment <span className="text-mut">{caps?.environment ?? "…"}</span>
          </p>
        </div>
      </Reveal>

      {/* verification suite */}
      <Reveal delay={190}>
        <div className="panel overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-3">
            <span className="mono-label flex items-center gap-2"><Icon name="flask" size={11} /> phase 1 verification suite</span>
            <span className="font-mono text-[10px] text-dim">runs the real kernel, services and persistence in this browser — PASSED / FAILED / BLOCKED, never faked</span>
            <span className="ml-auto flex gap-2">
              {suite ? (
                <Button
                  variant="outline"
                  size="sm"
                  icon="copy"
                  onClick={() => {
                    const blob = new Blob([JSON.stringify(suite, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `nexus-phase1-verification-${Date.now()}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  export
                </Button>
              ) : null}
              <Button size="sm" icon="play" loading={running} onClick={() => void runSuite()}>
                {running ? "verifying…" : "run verification"}
              </Button>
            </span>
          </div>

          {!suite && !running ? (
            <p className="px-4 py-8 text-center font-mono text-[11px] text-dim">
              NOT EXECUTED — run the suite to produce real evidence. Build success alone is never reported as verification.
            </p>
          ) : null}

          {suite ? (
            <>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-edge/60 px-4 py-3 font-mono text-xs">
                <span className="text-fg">total <span className="tabular-nums">{suite.results.length}</span></span>
                <span className="text-moss">passed <span className="tabular-nums">{suite.passed}</span></span>
                <span className="text-flame">failed <span className="tabular-nums">{suite.failed}</span></span>
                <span className="text-gold">blocked <span className="tabular-nums">{suite.blocked}</span></span>
                <span className="text-dim">{fmtDuration(suite.duration_ms)} · engine {suite.engine} · {timeAgo(suite.ran_at)}</span>
                <Badge tone={suite.failed === 0 ? "moss" : "flame"} className="ml-auto">{suite.failed === 0 ? "all real checks passed" : `${suite.failed} genuine failure(s)`}</Badge>
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                {suite.results.map((r) => (
                  <div key={r.name} className="border-b border-edge/50 last:border-0">
                    <button onClick={() => setOpenTest(openTest === r.name ? null : r.name)} className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-ink-800/40">
                      <StatusPill status={r.status} />
                      <span className="min-w-0 flex-1 truncate text-xs text-fg">{r.name}</span>
                      <Badge tone="mut">{r.category}</Badge>
                      <span className="shrink-0 font-mono text-[10px] text-dim tabular-nums">{r.duration_ms}ms</span>
                      <Icon name="chevronDown" size={12} className={cx("shrink-0 text-dim transition-transform", openTest === r.name && "rotate-180")} />
                    </button>
                    {openTest === r.name ? (
                      <div className="anim-fade space-y-1.5 border-t border-edge/50 bg-ink-900/60 px-4 py-2.5 font-mono text-[11px]">
                        {r.evidence ? <p className="text-moss">evidence: {r.evidence}</p> : null}
                        {r.error ? <p className="whitespace-pre-wrap text-flame">error: {r.error}</p> : null}
                        {!r.evidence && !r.error ? <p className="text-dim">no additional detail</p> : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </Reveal>

      {/* runtime bridge */}
      <Reveal delay={210}>
        <div className="panel overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-3">
            <span className="mono-label flex items-center gap-2"><Icon name="cpu" size={11} /> runtime bridge · process execution</span>
            <span className="font-mono text-[10px] text-dim">real capability probes — BLOCKED is an honest state, never a fake pass</span>
            <span className="ml-auto flex items-center gap-2">
              {runtime ? (
                <Badge tone={runtime.runtime === "EXTERNAL_HOST_RUNTIME" ? "moss" : "gold"}>{runtime.runtime}</Badge>
              ) : null}
              <Button size="sm" variant="outline" icon="refresh" loading={detecting} onClick={() => void detectRuntime()}>
                re-detect
              </Button>
            </span>
          </div>

          {!runtime ? (
            <div className="space-y-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 border-b border-edge/60 px-4 py-3 sm:grid-cols-4 lg:grid-cols-8">
                {capChip("process", runtime.processExecution)}
                {capChip("docker", runtime.docker)}
                {capChip("trivy", runtime.trivy)}
                {capChip("playwright", runtime.playwright)}
                {capChip("chromium", runtime.chromium)}
                {capChip("node", runtime.node)}
                {capChip("npm", runtime.npm)}
                {capChip("git", runtime.git)}
              </div>
              <div className="border-b border-edge/60 px-4 py-2 font-mono text-[10px] text-dim">
                platform <span className="text-mut">{runtime.platform}</span>
                {runtime.capabilities.filter((c) => c.reason).slice(0, 2).map((c) => (
                  <span key={c.name} className="ml-3">{c.name}: {c.reason}</span>
                ))}
              </div>

              {/* smoke test runner */}
              <div className="border-b border-edge/60 px-4 py-3">
                <div className="mono-label mb-2">staging smoke test · real health + browser check</div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex-1 min-w-[180px]">
                    <span className="mb-1 block font-mono text-[10px] text-dim">staging url</span>
                    <input value={stagingUrl} onChange={(e) => setStagingUrl(e.target.value)} className="w-full rounded-md border border-edge bg-ink-850 px-2.5 py-1.5 font-mono text-xs text-fg focus:border-mint/50 focus:outline-none" placeholder="http://localhost:8080" />
                  </label>
                  <label className="flex-1 min-w-[180px]">
                    <span className="mb-1 block font-mono text-[10px] text-dim">health endpoint (optional)</span>
                    <input value={healthUrl} onChange={(e) => setHealthUrl(e.target.value)} className="w-full rounded-md border border-edge bg-ink-850 px-2.5 py-1.5 font-mono text-xs text-fg focus:border-mint/50 focus:outline-none" placeholder="/health" />
                  </label>
                  <Button size="sm" icon="play" loading={smokeRunning} onClick={() => void runSmoke()}>run smoke</Button>
                </div>
                {smokeResult ? (
                  <div className="anim-fade mt-2 rounded-md border border-edge bg-ink-850 px-3 py-2 font-mono text-[11px]">
                    <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="text-mut">verdict <Badge tone={smokeResult.verdict === "PASS" ? "moss" : smokeResult.verdict === "FAIL" ? "flame" : "gold"}>{smokeResult.verdict}</Badge></span>
                      <span className="text-mut">health {smokeResult.health.ok ? "ok" : "fail"} {smokeResult.health.status_code !== null ? `· HTTP ${smokeResult.health.status_code}` : ""} {smokeResult.health.response_time_ms !== null ? `· ${smokeResult.health.response_time_ms}ms` : ""}</span>
                      <span className="text-mut">smoke <Badge tone={smokeResult.smoke.status === "PASSED" ? "moss" : smokeResult.smoke.status === "FAILED" ? "flame" : "gold"}>{smokeResult.smoke.status}</Badge></span>
                    </span>
                    {smokeResult.reason ? <p className="mt-1 text-gold">{smokeResult.reason}</p> : null}
                    <p className="mt-1 text-dim">{smokeResult.smoke.detail}</p>
                  </div>
                ) : null}
              </div>

              {/* quality gate */}
              <div className="px-4 py-3">
                <div className="mono-label mb-2">quality gate · evidence-based (blocked never becomes pass)</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
                  {GATE_STAGES.map((stage) => {
                    const val = gate[stage]?.status ?? "BLOCKED";
                    return (
                      <label key={stage} className="flex flex-col gap-1">
                        <span className="font-mono text-[10px] text-dim">{stage}</span>
                        <select
                          value={val}
                          onChange={(e) => setGate((g) => ({ ...g, [stage]: { status: e.target.value as GateEvidence["status"], reason: g[stage]?.reason ?? null } }))}
                          className="rounded-md border border-edge bg-ink-850 px-1.5 py-1 font-mono text-[11px] text-fg focus:border-mint/50 focus:outline-none"
                        >
                          <option value="PASS">PASS</option>
                          <option value="FAIL">FAIL</option>
                          <option value="BLOCKED">BLOCKED</option>
                        </select>
                      </label>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" icon="shield" onClick={() => void evaluateGate()}>evaluate gate</Button>
                  {gateResult ? (
                    <Badge tone={gateResult.verdict === "VERIFIED" ? "moss" : gateResult.verdict === "FAILED" ? "flame" : "gold"}>
                      {gateResult.verdict} · {gateResult.required_passed}/{gateResult.required_total}
                    </Badge>
                  ) : null}
                </div>
                {gateResult && gateResult.blocking_stages.length > 0 ? (
                  <p className="mt-1.5 font-mono text-[10px] text-gold">
                    blocking: {gateResult.blocking_stages.map((b) => `${b.stage}:${b.status}`).join(", ")}
                  </p>
                ) : null}
              </div>
            </>
          )}
        </div>
      </Reveal>

      <p className="font-mono text-[10px] leading-relaxed text-dim">
        environment {CONFIG.env} · build {CONFIG.build} · regression gate: <span className="text-mut">node scripts/verify-phase1.mjs</span> (compilation + build; the in-browser suite above covers runtime behaviour)
      </p>
    </div>
  );
}
