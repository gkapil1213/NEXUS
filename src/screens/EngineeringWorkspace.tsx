/**
 * NEXUS — AI Engineering Workspace.
 *
 * A user-facing orchestration console. It is a PURE ORCHESTRATION LAYER over
 * the existing Phase 1/2/3 services — it never reimplements auth, RBAC, the
 * agent registry, the sandbox, audit, events or artifact management.
 *
 *   COMPOSE  → deterministic intent parsing (live, as you type)
 *   PLAN     → real detection + build-plan validation + honest capability probes
 *   EXECUTE  → existing NexusOrchestrator + devops PipelineEngine
 *   RESULT   → honest PASS/FAIL/BLOCKED per stage + recovery guidance
 *
 * RUNTIME TRUTH: build/test need a command runtime the browser lacks, so those
 * stages report BLOCKED — never a fabricated PASS. Detection, static security
 * review and source SBOM genuinely run in-browser against real workspace files.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNexus } from "../state";
import { parseIntent, generatePlan, executePlan } from "../core/engineering";
import type { EngineeringIntent, EngineeringPlan, EngRunResult, EngStageResult } from "../core/engineering";
import { detectCapabilities, executableHere } from "../core/capabilities";
import type { CapabilityReport } from "../core/capabilities";
import type { NexusEvent, Project } from "../core/types";
import { Badge, Button, Field, Icon, Reveal, SectionHead, TextArea, cx, fmtDuration, type IconName } from "../ui";

type Step = "compose" | "plan" | "run";

const SCOPE_TONE: Record<EngineeringIntent["scope"], "mint" | "gold" | "flame"> = { small: "mint", medium: "gold", large: "flame" };

const STAGE_ICON: Record<EngStageResult["outcome"], IconName> = {
  PASSED: "check",
  FAILED: "x",
  BLOCKED: "lock",
  SKIPPED: "chevronRight",
};

function StageTone({ outcome }: { outcome: EngStageResult["outcome"] }) {
  return (
    <Badge tone={outcome === "PASSED" ? "moss" : outcome === "FAILED" ? "flame" : outcome === "BLOCKED" ? "gold" : "mut"}>
      {outcome}
    </Badge>
  );
}

/* ------------------------------ capability strip --------------------------- */

function CapabilityStrip({ report }: { report: CapabilityReport | null }) {
  const exec = report ? executableHere(report) : null;
  const items: { label: string; ok: boolean }[] = exec
    ? [
        { label: "detect", ok: true },
        { label: "static security", ok: exec.security_static },
        { label: "source sbom", ok: exec.source_sbom },
        { label: "build / test", ok: false },
        { label: "docker", ok: exec.docker },
        { label: "smoke", ok: exec.smoke },
      ]
    : [];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[11px]">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span className={cx("h-1.5 w-1.5 rounded-full", it.ok ? "bg-moss" : "bg-gold")} />
          <span className={it.ok ? "text-mut" : "text-gold/80"}>{it.label}</span>
          <span className={it.ok ? "text-dim" : "text-gold/60"}>{it.ok ? "ready" : "blocked"}</span>
        </span>
      ))}
      <span className="ml-auto hidden items-center gap-1.5 text-dim sm:flex">
        <Icon name="shield" size={11} /> REAL EXECUTION ONLY — blocked stages are never faked
      </span>
    </div>
  );
}

/* --------------------------------- screen ---------------------------------- */

export function EngineeringWorkspaceScreen() {
  const { services, user, liveEvents, toast, navigate } = useNexus();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [caps, setCaps] = useState<CapabilityReport | null>(null);

  const [request, setRequest] = useState("");
  const [projectId, setProjectId] = useState("");
  const [scaffold, setScaffold] = useState(true);

  const [step, setStep] = useState<Step>("compose");
  const [plan, setPlan] = useState<EngineeringPlan | null>(null);
  const [result, setResult] = useState<EngRunResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [stream, setStream] = useState<NexusEvent[]>([]);
  const execIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!services || !user) return;
    void services.projects.list(user).then((p) => {
      setProjects(p);
      if (p.length && !projectId) setProjectId(p[0].id);
    });
    void detectCapabilities().then(setCaps);
  }, [services, user, projectId]);

  // Live event stream for the current execution.
  useEffect(() => {
    if (!services) return;
    const off = services.events.on((e) => {
      if (execIdRef.current && e.execution_id === execIdRef.current) setStream((s) => [...s.slice(-30), e]);
    });
    return off;
  }, [services]);

  const intent = useMemo<EngineeringIntent | null>(() => (request.trim().length >= 4 ? parseIntent(request) : null), [request]);

  const project = useMemo(() => projects?.find((p) => p.id === projectId) ?? null, [projects, projectId]);

  const onGenerate = useCallback(async () => {
    if (!services || !user || !project || !intent) return;
    setGenerating(true);
    setError(null);
    try {
      const p = await generatePlan(services, user, project, intent, { scaffold });
      setPlan(p);
      setResult(null);
      setStep("plan");
      toast("ok", "Plan generated", `${p.stages.length} stages · ${p.readyCount} ready · ${p.blockedCount} blocked`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [services, user, project, intent, scaffold, toast]);

  const onExecute = useCallback(async () => {
    if (!services || !user || !plan) return;
    setExecuting(true);
    setError(null);
    setStream([]);
    setStep("run");
    try {
      const res = await executePlan(services, user, plan);
      execIdRef.current = res.execution.id;
      setResult(res);
      const verb = res.verdict === "PASSED" ? "ok" : res.verdict === "FAILED" ? "err" : "info";
      toast(verb, `Execution ${res.verdict.toLowerCase()}`, `${res.passed} passed · ${res.failed} failed · ${res.blocked} blocked`);
    } catch (e) {
      setError((e as Error).message);
      setStep("plan");
    } finally {
      setExecuting(false);
    }
  }, [services, user, plan, toast]);

  const reset = useCallback(() => {
    setStep("compose");
    setPlan(null);
    setResult(null);
    setStream([]);
    execIdRef.current = null;
  }, []);

  return (
    <div className="space-y-6">
      <SectionHead
        kicker="ai engineering workspace"
        title="Describe it. NEXUS plans and runs it."
        sub="An orchestration layer over the existing kernel — intent → plan → isolated workspace → detect → security → SBOM. Authorization, audit, events and artifacts all reuse Phase 1/2/3 services."
        right={
          <Badge tone="mut" className="font-mono">
            <Icon name="terminal" size={11} /> orchestration layer
          </Badge>
        }
      />

      {caps ? (
        <Reveal>
          <div className="panel px-4 py-3">
            <CapabilityStrip report={caps} />
          </div>
        </Reveal>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-12">
        {/* ------------------------------ left: input ------------------------------ */}
        <div className="space-y-6 lg:col-span-5">
          <Reveal>
            <div className="panel overflow-hidden">
              <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-3">
                <Icon name="terminal" size={11} /> 01 · compose request
              </div>
              <div className="space-y-4 p-4">
                <Field label="What do you want to build?" hint="Parsed deterministically into signals — no black-box AI.">
                  <TextArea
                    rows={5}
                    value={request}
                    onChange={(e) => setRequest(e.target.value)}
                    placeholder="e.g. Build a realtime analytics dashboard with auth, a REST API, Postgres persistence and Docker deployment…"
                    className="font-mono text-[13px]"
                  />
                </Field>

                {intent ? (
                  <div className="anim-fade space-y-2.5 rounded-md border border-mint/20 bg-mint/[0.04] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-display text-sm font-semibold text-fg">“{intent.subject}”</span>
                      <Badge tone={SCOPE_TONE[intent.scope]}>{intent.scope}</Badge>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {intent.signals.length ? (
                        intent.signals.map((s) => (
                          <Badge key={s.id} tone="sky">
                            {s.label}
                          </Badge>
                        ))
                      ) : (
                        <span className="font-mono text-[11px] text-dim">no capability signals detected yet</span>
                      )}
                    </div>
                    <p className="font-mono text-[10px] text-dim">
                      {intent.words} words · {intent.signals.length} signal{intent.signals.length === 1 ? "" : "s"}
                    </p>
                  </div>
                ) : null}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Target project">
                    <select
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      className="h-9 w-full rounded-md border border-edge bg-ink-850 px-3 font-mono text-xs text-fg focus:border-mint/60 focus:outline-none"
                    >
                      {projects === null ? (
                        <option value="">loading…</option>
                      ) : projects.length === 0 ? (
                        <option value="">no projects</option>
                      ) : (
                        projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))
                      )}
                    </select>
                  </Field>
                  <Field label="Workspace scaffold" hint="Write a real starting scaffold into an isolated workspace.">
                    <button
                      onClick={() => setScaffold((s) => !s)}
                      className={cx(
                        "flex h-9 w-full items-center justify-between rounded-md border px-3 font-mono text-xs transition-colors",
                        scaffold ? "border-mint/50 bg-mint/10 text-mint" : "border-edge bg-ink-850 text-dim",
                      )}
                    >
                      <span>{scaffold ? "scaffold on" : "scaffold off"}</span>
                      <Icon name={scaffold ? "check" : "x"} size={12} />
                    </button>
                  </Field>
                </div>

                {projects !== null && projects.length === 0 ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-gold/25 bg-gold/[0.06] px-3 py-2.5">
                    <p className="font-mono text-[11px] text-gold">No ACTIVE project. Create one first.</p>
                    <Button size="sm" variant="outline" icon="plus" onClick={() => navigate("projects")}>
                      Projects
                    </Button>
                  </div>
                ) : null}

                {error ? <p className="rounded-md border border-flame/30 bg-flame/10 px-3 py-2 font-mono text-[11px] text-flame">{error}</p> : null}

                <div className="flex gap-2">
                  <Button
                    icon="bolt"
                    loading={generating}
                    disabled={!intent || !project || generating}
                    onClick={() => void onGenerate()}
                    className="flex-1"
                  >
                    Generate plan
                  </Button>
                  {step !== "compose" ? (
                    <Button variant="ghost" icon="refresh" onClick={reset}>
                      Reset
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </Reveal>

          {/* --------------------------- plan preview --------------------------- */}
          {plan ? (
            <Reveal delay={60}>
              <div className="panel overflow-hidden">
                <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-3">
                  <Icon name="layers" size={11} /> 02 · plan preview
                  <span className="ml-auto font-mono text-[10px] text-dim">
                    {plan.readyCount} ready · {plan.blockedCount} blocked
                  </span>
                </div>
                <div className="space-y-3 p-4">
                  <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                    <div className="rounded-md border border-edge bg-ink-850 px-3 py-2">
                      <span className="mono-label block">language</span>
                      <span className="text-fg">{plan.detection.language}</span>
                    </div>
                    <div className="rounded-md border border-edge bg-ink-850 px-3 py-2">
                      <span className="mono-label block">runtime</span>
                      <span className="text-fg">{plan.detection.runtime ?? "—"}</span>
                    </div>
                    <div className="rounded-md border border-edge bg-ink-850 px-3 py-2">
                      <span className="mono-label block">package mgr</span>
                      <span className="text-fg">{plan.detection.package_manager ?? "—"}</span>
                    </div>
                    <div className="rounded-md border border-edge bg-ink-850 px-3 py-2">
                      <span className="mono-label block">confidence</span>
                      <span className="text-fg">{Math.round(plan.detection.confidence * 100)}%</span>
                    </div>
                  </div>

                  <div className="rounded-md border border-edge bg-ink-850 px-3 py-2 font-mono text-[11px]">
                    <span className="mono-label block">build command</span>
                    <span className={plan.buildValidation.ok ? "text-moss" : "text-flame"}>
                      {plan.buildPlan.build_command ?? "—"} {!plan.buildValidation.ok ? `· rejected (${plan.buildValidation.rejected.length})` : ""}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {plan.stages.map((s, i) => (
                      <div key={s.id} className="flex items-start gap-2.5 rounded-md border border-edge/60 bg-ink-850/60 px-3 py-2">
                        <span className="mt-0.5 font-mono text-[10px] text-dim tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-xs font-medium text-fg">{s.label}</span>
                            <Badge tone={s.availability === "ready" ? "moss" : "gold"}>{s.availability}</Badge>
                          </div>
                          <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-dim">{s.service}</p>
                          {s.blockedReason ? <p className="mt-0.5 font-mono text-[10px] text-gold/80">{s.blockedReason}</p> : null}
                        </div>
                      </div>
                    ))}
                  </div>

                  <Button icon="play" loading={executing} disabled={executing} onClick={() => void onExecute()} className="w-full">
                    Execute plan
                  </Button>
                  <p className="text-center font-mono text-[10px] text-dim">
                    runs via the existing orchestrator + pipeline engine — authorized, audited, evented
                  </p>
                </div>
              </div>
            </Reveal>
          ) : null}
        </div>

        {/* ------------------------------ right: output ----------------------------- */}
        <div className="space-y-6 lg:col-span-7">
          {/* execution timeline */}
          <Reveal delay={90}>
            <div className="panel overflow-hidden">
              <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-3">
                <Icon name="pulse" size={11} /> 03 · execution
                {result ? (
                  <span className="ml-auto">
                    <Badge tone={result.verdict === "PASSED" ? "moss" : result.verdict === "FAILED" ? "flame" : "gold"}>{result.verdict}</Badge>
                  </span>
                ) : executing ? (
                  <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] text-gold">
                    <span className="h-1.5 w-1.5 animate-ping rounded-full bg-gold" /> running…
                  </span>
                ) : null}
              </div>

              {!result && !executing ? (
                <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-lg border border-edge bg-ink-850 text-dim">
                    <Icon name="play" size={20} />
                  </span>
                  <p className="max-w-sm font-mono text-[11px] leading-relaxed text-dim">
                    Generate a plan, then execute it. Each stage reports an honest PASS / FAIL / BLOCKED — build and test stages
                    are BLOCKED here because the browser sandbox has no command runtime.
                  </p>
                </div>
              ) : (
                <div className="p-4">
                  {result ? (
                    <>
                      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <SummaryStat label="passed" value={result.passed} tone="text-moss" />
                        <SummaryStat label="failed" value={result.failed} tone="text-flame" />
                        <SummaryStat label="blocked" value={result.blocked} tone="text-gold" />
                        <SummaryStat label="artifacts" value={result.artifacts} tone="text-sky" />
                      </div>

                      <div className="space-y-1.5">
                        {result.stages.map((s, i) => (
                          <div key={s.stageId} className={cx("anim-rise flex items-center gap-3 rounded-md border px-3 py-2", borderFor(s.outcome))} style={{ animationDelay: `${i * 60}ms` }}>
                            <span className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded-full border", iconTone(s.outcome))}>
                              <Icon name={STAGE_ICON[s.outcome]} size={12} />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-xs font-medium text-fg">{s.label}</span>
                                <StageTone outcome={s.outcome} />
                              </div>
                              {s.blockedReason ? <p className="mt-0.5 truncate font-mono text-[10px] text-gold/80">{s.blockedReason}</p> : null}
                              {s.detail && s.outcome === "FAILED" ? <p className="mt-0.5 truncate font-mono text-[10px] text-flame/90">{s.detail}</p> : null}
                            </div>
                            {s.durationMs !== null ? <span className="shrink-0 font-mono text-[10px] text-dim tabular-nums">{fmtDuration(s.durationMs)}</span> : null}
                          </div>
                        ))}
                      </div>

                      {result.agentSummary ? (
                        <div className="mt-4 rounded-md border border-sky/20 bg-sky/[0.05] px-3 py-2.5">
                          <span className="mono-label block">agent outcome</span>
                          <p className="mt-1 font-mono text-[11px] leading-relaxed text-mut">{result.agentSummary}</p>
                        </div>
                      ) : null}

                      <div className="mt-4 rounded-md border border-edge bg-ink-850 px-3 py-2.5">
                        <span className="mono-label block">recovery</span>
                        <ul className="mt-1.5 space-y-1">
                          {result.recovery.map((r, i) => (
                            <li key={i} className="flex items-start gap-2 font-mono text-[11px] leading-relaxed text-mut">
                              <Icon name="chevronRight" size={11} className="mt-0.5 shrink-0 text-mint" />
                              {r}
                            </li>
                          ))}
                        </ul>
                      </div>

                      <p className="mt-3 text-center font-mono text-[10px] text-dim">
                        execution {result.execution.id} · run {result.runId} · status {result.execution.status}
                      </p>
                    </>
                  ) : (
                    <div className="space-y-1.5">
                      {(plan?.stages ?? []).map((s, i) => (
                        <div key={s.id} className="flex items-center gap-3 rounded-md border border-edge/60 px-3 py-2">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-edge text-dim">
                            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-gold" style={{ animationDelay: `${i * 120}ms` }} />
                          </span>
                          <span className="text-xs text-mut">{s.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Reveal>

          {/* event stream */}
          <Reveal delay={120}>
            <div className="panel overflow-hidden">
              <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-3">
                <Icon name="bolt" size={11} /> event stream
                <span className="ml-auto font-mono text-[10px] text-dim">{stream.length} events</span>
              </div>
              {stream.length === 0 ? (
                <p className="px-4 py-6 text-center font-mono text-[11px] text-dim">execution events appear here in real time</p>
              ) : (
                <div className="scanlines max-h-64 overflow-y-auto">
                  {[...stream].reverse().map((e) => (
                    <div key={e.id} className="flex items-center gap-3 border-b border-edge/40 px-4 py-1.5 last:border-0">
                      <span className="font-mono text-[10px] text-dim tabular-nums">{new Date(e.timestamp).toLocaleTimeString()}</span>
                      <span className="truncate font-mono text-[11px] text-mint">{e.type}</span>
                      <span className="ml-auto truncate font-mono text-[10px] text-dim">{e.source}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Reveal>
        </div>
      </div>

      <p className="font-mono text-[10px] leading-relaxed text-dim">
        The workspace never reimplements authentication, RBAC, the agent registry, the sandbox, audit, events or artifact
        management — it orchestrates the existing Phase 1/2/3 services. Stages without an available runtime report BLOCKED,
        never a fabricated PASS.
      </p>
    </div>
  );
}

/* --------------------------------- helpers --------------------------------- */

function SummaryStat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-md border border-edge bg-ink-850 px-3 py-2.5">
      <div className={cx("font-display text-2xl font-bold tabular-nums", tone)}>{value}</div>
      <div className="mono-label mt-0.5">{label}</div>
    </div>
  );
}

function borderFor(outcome: EngStageResult["outcome"]): string {
  return outcome === "PASSED"
    ? "border-moss/25 bg-moss/[0.04]"
    : outcome === "FAILED"
      ? "border-flame/25 bg-flame/[0.05]"
      : outcome === "BLOCKED"
        ? "border-gold/25 bg-gold/[0.04]"
        : "border-edge/60 bg-ink-850/40";
}

function iconTone(outcome: EngStageResult["outcome"]): string {
  return outcome === "PASSED"
    ? "border-moss/40 text-moss"
    : outcome === "FAILED"
      ? "border-flame/40 text-flame"
      : outcome === "BLOCKED"
        ? "border-gold/40 text-gold"
        : "border-edge text-dim";
}
