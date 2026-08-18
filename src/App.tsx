import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { PIPELINE } from "./core/engine";
import type { RunSnapshot, StageState } from "./core/engine";
import { DEFAULT_PROMPT, SCENARIOS, WORKSPACE_FILES, buildWorkspace } from "./core/sample";
import type { Scenario } from "./core/sample";
import type { StageStatus } from "./core/types";
import { usePipeline } from "./usePipeline";
import { cx } from "./ui";

/* ---------------------------------- icons ---------------------------------- */

const ICONS = {
  play: <path d="M6 4l14 8-14 8V4z" />,
  box: (
    <>
      <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
      <path d="M3 8l9 5 9-5" />
      <path d="M12 13v8" />
    </>
  ),
  flask: (
    <>
      <path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 001.4 2h12.2a1.5 1.5 0 001.4-2L14 9V3" />
      <path d="M7 15h10" />
    </>
  ),
  shield: (
    <>
      <path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  layers: (
    <>
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 12l10 5 10-5" />
      <path d="M2 17l10 5 10-5" />
    </>
  ),
  scan: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.5-4.5" />
    </>
  ),
  file: (
    <>
      <path d="M6 2h8l5 5v15H6V2z" />
      <path d="M14 2v5h5" />
      <path d="M9 13h6M9 17h6" />
    </>
  ),
  package: (
    <>
      <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
      <path d="M3 8l9 5 9-5" />
      <path d="M12 13v8" />
      <path d="M7.5 5.5l9 5" />
    </>
  ),
  check: <path d="M4 12.5l5 5L20 6.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  alert: (
    <>
      <path d="M12 3l10 18H2L12 3z" />
      <path d="M12 10v4M12 17.5v.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="M6.5 9l3 3-3 3" />
      <path d="M12.5 15h5" />
    </>
  ),
  git: (
    <>
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 7.5v9" />
      <path d="M18 10.5c0 4-6 3.5-9.5 5.5" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="10" y="10" width="4" height="4" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4M6 2v2M18 2v2M6 20v2M18 20v2" />
    </>
  ),
  activity: <path d="M2 12h4l3-8 6 16 3-8h4" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
} as const;

type IconName = keyof typeof ICONS;

function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("shrink-0", className)}
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  );
}

/* ------------------------------- status meta ------------------------------- */

const STATUS_META: Record<StageStatus, { label: string; text: string; dot: string; chip: string }> = {
  PENDING: { label: "pending", text: "text-dim", dot: "bg-dim", chip: "border-edge text-dim" },
  RUNNING: { label: "running", text: "text-steel", dot: "bg-steel", chip: "border-steel/40 text-steel bg-steel/10" },
  SUCCEEDED: { label: "passed", text: "text-mint", dot: "bg-mint", chip: "border-mint/40 text-mint bg-mint/10" },
  FAILED: { label: "failed", text: "text-flame", dot: "bg-flame", chip: "border-flame/40 text-flame bg-flame/10" },
  BLOCKED: { label: "blocked", text: "text-gold", dot: "bg-gold", chip: "border-gold/40 text-gold bg-gold/10" },
  SKIPPED: { label: "skipped", text: "text-dim", dot: "bg-dim", chip: "border-edge text-dim" },
};

const STAGE_ICON: Record<string, IconName> = {
  PLANNING: "cpu",
  BUILDING: "box",
  TESTING: "flask",
  SECURITY_REVIEW: "shield",
  DOCKER_BUILD: "layers",
  IMAGE_SCAN: "scan",
  SBOM: "file",
  ARTIFACT: "package",
};

/* -------------------------------- utilities -------------------------------- */

function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ transitionDelay: `${delay}ms` }} className={cx("reveal", seen && "reveal-in", className)}>
      {children}
    </div>
  );
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

function useCountUp(target: number, duration = 700) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (target === 0) {
      setValue(0);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      setValue(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMs(ms: number | null) {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function shortDigest(d: string) {
  return d.replace("sha256:", "").slice(0, 14) + "…";
}

/* --------------------------------- atoms ---------------------------------- */

function SectionHead({ kicker, title, sub, right }: { kicker: string; title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="mono-label mb-1.5 flex items-center gap-2">
          <span className="h-px w-6 bg-mint/60" />
          {kicker}
        </div>
        <h2 className="font-display text-2xl font-bold tracking-tight text-fg sm:text-3xl">{title}</h2>
        {sub ? <p className="mt-1 max-w-2xl text-sm text-mut">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

function StatusChip({ status }: { status: StageStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider", m.chip)}>
      <span className={cx("h-1.5 w-1.5 rounded-full", m.dot, status === "RUNNING" && "pulse-dot")} />
      {m.label}
    </span>
  );
}

function Metric({ label, value, suffix, tone }: { label: string; value: number; suffix?: string; tone: string }) {
  const v = useCountUp(value);
  return (
    <div className="panel px-4 py-3.5 transition-transform duration-200 hover:-translate-y-0.5">
      <div className={cx("font-display text-3xl font-bold tabular-nums leading-none", tone)}>
        {v}
        {suffix ? <span className="ml-0.5 text-base font-semibold text-dim">{suffix}</span> : null}
      </div>
      <div className="mono-label mt-1.5">{label}</div>
    </div>
  );
}

/* ------------------------------ pipeline rail ------------------------------ */

function StageNode({ state, index }: { state: StageState; index: number }) {
  const m = STATUS_META[state.status];
  const running = state.status === "RUNNING";
  return (
    <div className="relative flex items-start gap-3">
      {/* connector */}
      {index < PIPELINE.length - 1 && (
        <span
          className={cx(
            "absolute left-[15px] top-8 h-[calc(100%-16px)] w-px",
            state.status === "SUCCEEDED" ? "bg-mint/50" : "bg-edge",
          )}
        />
      )}
      <div
        className={cx(
          "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-all duration-300",
          running && "border-steel/60 bg-steel/15 text-steel shadow-[0_0_16px_-2px_rgba(95,168,220,0.5)]",
          state.status === "SUCCEEDED" && "border-mint/50 bg-mint/10 text-mint",
          state.status === "FAILED" && "border-flame/50 bg-flame/10 text-flame",
          state.status === "BLOCKED" && "border-gold/50 bg-gold/10 text-gold",
          (state.status === "PENDING" || state.status === "SKIPPED") && "border-edge bg-ink-850 text-dim",
        )}
      >
        {running ? <Icon name={STAGE_ICON[state.stage]} size={15} className="pulse-dot" /> : <Icon name={STAGE_ICON[state.stage]} size={15} />}
      </div>
      <div className="min-w-0 flex-1 pb-4">
        <div className="flex items-center justify-between gap-2">
          <span className={cx("font-display text-sm font-semibold", running ? "text-steel" : state.status === "PENDING" ? "text-dim" : "text-fg")}>
            {PIPELINE[index].label}
          </span>
          <StatusChip status={state.status} />
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className={cx("truncate font-mono text-[10px]", m.text)}>{state.detail || "\u00a0"}</p>
          {state.duration_ms !== null && <span className="shrink-0 font-mono text-[10px] text-dim">{fmtMs(state.duration_ms)}</span>}
        </div>
      </div>
    </div>
  );
}

function PipelineRail({ snap }: { snap: RunSnapshot }) {
  return (
    <div className="panel p-5">
      <div className="mono-label mb-4 flex items-center justify-between">
        <span>pipeline</span>
        <span className={cx("flex items-center gap-1.5", snap.status === "RUNNING" ? "text-steel" : "text-dim")}>
          <span className={cx("h-1.5 w-1.5 rounded-full", snap.status === "RUNNING" ? "pulse-dot bg-steel" : "bg-dim")} />
          {snap.status === "RUNNING" ? "executing" : snap.status.toLowerCase()}
        </span>
      </div>
      <div>
        {PIPELINE.map((p, i) => (
          <StageNode key={p.stage} state={snap.stages[p.stage]} index={i} />
        ))}
      </div>
    </div>
  );
}

/* --------------------------------- terminal -------------------------------- */

const LOG_COLOR: Record<string, string> = {
  dim: "text-dim",
  info: "text-steel",
  ok: "text-mint",
  warn: "text-gold",
  err: "text-flame",
};

function Terminal({ snap, running }: { snap: RunSnapshot; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap.logs.length]);
  return (
    <div className="panel flex h-full min-h-[280px] flex-col overflow-hidden">
      <div className="scanlines pointer-events-none absolute inset-0 opacity-40" />
      <div className="relative flex items-center justify-between border-b border-edge px-4 py-2.5">
        <div className="mono-label flex items-center gap-2">
          <Icon name="terminal" size={12} />
          execution stream
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-flame/70" />
          <span className="h-2 w-2 rounded-full bg-gold/70" />
          <span className="h-2 w-2 rounded-full bg-mint/70" />
        </div>
      </div>
      <div ref={ref} className="relative flex-1 overflow-y-auto bg-[#060a0f] px-4 py-3 font-mono text-[11px] leading-relaxed">
        {snap.logs.length === 0 ? (
          <p className="text-dim">
            awaiting run — press <span className="text-mint">Start Engineering</span>
            <span className="caret" />
          </p>
        ) : (
          <>
            {snap.logs.map((l) => (
              <div key={l.id} className={cx("whitespace-pre-wrap break-words", LOG_COLOR[l.kind])}>
                <span className="mr-2 select-none text-dim/60">{new Date(l.at).toLocaleTimeString(undefined, { hour12: false })}</span>
                {l.text}
              </div>
            ))}
            {running && <span className="caret text-mint" />}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------- stage detail ------------------------------ */

function StageDetail({ state, label }: { state: StageState; label: string }) {
  const [open, setOpen] = useState(false);
  const hasEvidence = Object.keys(state.evidence).length > 0;
  const m = STATUS_META[state.status];
  return (
    <div className={cx("panel overflow-hidden transition-colors", open && "border-edge-2")}>
      <button
        onClick={() => hasEvidence && setOpen(!open)}
        className={cx("flex w-full items-center gap-3 px-4 py-3 text-left", hasEvidence && "hover:bg-ink-800/50")}
      >
        <Icon name={STAGE_ICON[state.stage]} size={16} className={m.text} />
        <span className="flex-1 font-display text-sm font-semibold text-fg">{label}</span>
        <span className={cx("hidden font-mono text-[10px] sm:block", m.text)}>{fmtMs(state.duration_ms)}</span>
        <StatusChip status={state.status} />
      </button>
      {open && hasEvidence && (
        <div className="anim-fade border-t border-edge/70 bg-ink-900/70 px-4 py-3">
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-mut">
            {JSON.stringify(state.evidence, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ artifact table ----------------------------- */

const TYPE_ICON: Record<string, IconName> = {
  build_package: "box",
  test_report: "flask",
  security_report: "shield",
  sbom: "file",
  dockerfile: "layers",
  detection: "cpu",
  docker_image: "package",
  log: "terminal",
};

function ArtifactTable({ snap }: { snap: RunSnapshot }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(id);
    window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
  };
  return (
    <div className="panel overflow-hidden">
      <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-2.5">
        <Icon name="package" size={12} />
        artifact ledger · {snap.artifacts.length}
      </div>
      {snap.artifacts.length === 0 ? (
        <p className="px-4 py-8 text-center font-mono text-xs text-dim">no artifacts registered yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left">
            <thead>
              <tr className="border-b border-edge font-mono text-[9px] uppercase tracking-widest text-dim">
                <th className="px-4 py-2">name</th>
                <th className="px-3 py-2">type</th>
                <th className="px-3 py-2">digest</th>
                <th className="px-3 py-2 text-right">size</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {snap.artifacts.map((a) => (
                <tr key={a.id} className="border-b border-edge/60 transition-colors last:border-0 hover:bg-ink-800/40">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Icon name={TYPE_ICON[a.type] ?? "file"} size={13} className="text-steel" />
                      <span className="font-mono text-xs text-fg">{a.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[10px] text-mut">{a.type}</td>
                  <td className="px-3 py-2.5 font-mono text-[10px] text-mint">{shortDigest(a.digest)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-[10px] text-mut">{fmtBytes(a.size)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => copy(a.id, a.digest)}
                      className="inline-flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 font-mono text-[9px] text-dim transition-colors hover:border-mint/50 hover:text-mint"
                    >
                      <Icon name={copied === a.id ? "check" : "copy"} size={10} />
                      {copied === a.id ? "copied" : "digest"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- main console ------------------------------ */

export default function App() {
  const { snap, running, run, reset } = usePipeline();
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [scenario, setScenario] = useState<Scenario>("clean");
  const [activeFile, setActiveFile] = useState<string>("src/index.ts");
  const clock = useClock();

  const workspace = useMemo(() => buildWorkspace(scenario), [scenario]);
  const files = useMemo(() => {
    const keys = Object.keys(workspace);
    return WORKSPACE_FILES.filter((f) => keys.includes(f)).concat(keys.filter((k) => !WORKSPACE_FILES.includes(k)));
  }, [workspace]);

  const counts = useMemo(() => {
    const stages = Object.values(snap.stages);
    return {
      passed: stages.filter((s) => s.status === "SUCCEEDED").length,
      blocked: stages.filter((s) => s.status === "BLOCKED").length,
      failed: stages.filter((s) => s.status === "FAILED").length,
      artifacts: snap.artifacts.length,
    };
  }, [snap]);

  const totalMs = snap.started_at && snap.finished_at ? snap.finished_at - snap.started_at : null;

  const start = () => {
    if (running) return;
    void run(scenario, prompt.trim() || DEFAULT_PROMPT);
  };

  return (
    <div className="min-h-screen pb-16">
      {/* ------------------------------- header ------------------------------- */}
      <header className="sticky top-0 z-40 border-b border-edge/70 bg-ink-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 lg:px-8">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-mint/40 bg-mint/10">
            <span className="font-display text-lg font-bold text-mint">N</span>
          </div>
          <div className="min-w-0">
            <div className="font-display text-base font-bold leading-none tracking-tight text-fg">
              NEXUS<span className="text-mint">_</span>
            </div>
            <div className="mono-label mt-0.5">engineering control plane</div>
          </div>
          <div className="ml-auto flex items-center gap-2.5">
            <span className="hidden items-center gap-1.5 rounded border border-steel/40 bg-steel/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-steel sm:flex">
              <Icon name="git" size={11} />
              phase 3 · pass 1
            </span>
            <span className="hidden items-center gap-1.5 rounded border border-edge px-2 py-1 font-mono text-[10px] text-mut md:flex">
              <Icon name="database" size={11} />
              sandbox-workspace
            </span>
            <span className="flex items-center gap-1.5 rounded border border-edge px-2 py-1 font-mono text-[10px] tabular-nums text-mut">
              <Icon name="clock" size={11} />
              {clock.toLocaleTimeString(undefined, { hour12: false })}
            </span>
            <span
              className={cx(
                "flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider",
                snap.status === "RUNNING" && "border-steel/40 bg-steel/10 text-steel",
                snap.status === "COMPLETED" && "border-mint/40 bg-mint/10 text-mint",
                snap.status === "BLOCKED" && "border-gold/40 bg-gold/10 text-gold",
                snap.status === "FAILED" && "border-flame/40 bg-flame/10 text-flame",
                snap.status === "IDLE" && "border-edge text-dim",
              )}
            >
              <span
                className={cx(
                  "h-1.5 w-1.5 rounded-full",
                  snap.status === "RUNNING" && "pulse-dot bg-steel",
                  snap.status === "COMPLETED" && "bg-mint",
                  snap.status === "BLOCKED" && "bg-gold",
                  snap.status === "FAILED" && "bg-flame",
                  snap.status === "IDLE" && "bg-dim",
                )}
              />
              {snap.status.toLowerCase()}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 lg:px-8">
        {/* --------------------- opener: request console + rail --------------------- */}
        <section className="grid gap-5 pt-8 lg:grid-cols-[1.15fr_1fr]">
          <Reveal>
            <div className="flex h-full flex-col">
              <div className="mono-label mb-2 flex items-center gap-2">
                <span className="h-px w-6 bg-mint/60" />
                engineering request
              </div>
              <h1 className="font-display text-3xl font-bold leading-tight tracking-tight text-fg sm:text-4xl">
                What do you want <span className="text-mint">to build?</span>
              </h1>
              <p className="mt-2 max-w-xl text-sm text-mut">
                Submit one natural-language requirement. NEXUS runs the real in-browser pipeline — detect, build, test,
                security, SBOM and artifact registration — and reports Docker / deployment honestly as{" "}
                <span className="text-gold">BLOCKED</span> where the runtime has no daemon.
              </p>

              <div className="panel mt-5 flex flex-1 flex-col overflow-hidden">
                <div className="mono-label flex items-center justify-between border-b border-edge px-4 py-2.5">
                  <span>prompt</span>
                  <span className="tabular-nums">{prompt.length} chars</span>
                </div>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  className="w-full flex-1 resize-none bg-transparent px-4 py-3 font-mono text-xs leading-relaxed text-fg outline-none placeholder:text-dim"
                  placeholder="Describe the application…"
                />
                <div className="border-t border-edge px-4 py-3">
                  <div className="mono-label mb-2">scenario · inject a real defect</div>
                  <div className="flex flex-wrap gap-2">
                    {SCENARIOS.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => setScenario(s.id)}
                        title={s.hint}
                        className={cx(
                          "rounded-md border px-3 py-1.5 font-mono text-[11px] transition-all duration-150",
                          scenario === s.id
                            ? s.id === "clean"
                              ? "border-mint/60 bg-mint/15 text-mint"
                              : "border-flame/60 bg-flame/15 text-flame"
                            : "border-edge text-mut hover:border-edge-2 hover:text-fg",
                        )}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-3">
                <button
                  onClick={start}
                  disabled={running}
                  className={cx(
                    "inline-flex items-center gap-2 rounded-lg px-5 py-3 font-display text-sm font-bold transition-all duration-150",
                    running
                      ? "cursor-not-allowed bg-ink-700 text-dim"
                      : "bg-mint text-ink-950 shadow-[0_0_24px_-6px_rgba(43,212,167,0.7)] hover:bg-[#4ce0b8] active:scale-[0.98]",
                  )}
                >
                  {running ? <Icon name="activity" size={16} className="spin" /> : <Icon name="play" size={16} />}
                  {running ? "Engineering…" : "Start Engineering"}
                </button>
                {snap.status !== "IDLE" && !running && (
                  <button onClick={reset} className="rounded-lg border border-edge px-4 py-3 font-display text-sm font-semibold text-mut transition-colors hover:border-edge-2 hover:text-fg">
                    Reset
                  </button>
                )}
              </div>

              {/* workspace file browser */}
              <div className="panel mt-5 overflow-hidden">
                <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-2.5">
                  <Icon name="database" size={12} />
                  workspace · ws://{scenario}
                </div>
                <div className="flex flex-wrap gap-1.5 border-b border-edge/70 px-4 py-2.5">
                  {files.map((f) => (
                    <button
                      key={f}
                      onClick={() => setActiveFile(f)}
                      className={cx(
                        "rounded border px-2 py-1 font-mono text-[10px] transition-colors",
                        activeFile === f ? "border-steel/50 bg-steel/10 text-steel" : "border-edge text-mut hover:border-edge-2 hover:text-fg",
                      )}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <pre className="max-h-44 overflow-auto bg-[#060a0f] px-4 py-3 font-mono text-[10px] leading-relaxed text-mut">
                  {workspace[activeFile] ?? "// file not in this scenario"}
                </pre>
              </div>
            </div>
          </Reveal>

          <Reveal delay={120}>
            <PipelineRail snap={snap} />
          </Reveal>
        </section>

        {/* ------------------------------ metric strip ------------------------------ */}
        <Reveal delay={80}>
          <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Metric label="stages passed" value={counts.passed} tone="text-mint" />
            <Metric label="stages blocked" value={counts.blocked} tone="text-gold" />
            <Metric label="stages failed" value={counts.failed} tone="text-flame" />
            <Metric label="artifacts" value={counts.artifacts} tone="text-steel" />
            <div className="panel px-4 py-3.5 transition-transform duration-200 hover:-translate-y-0.5">
              <div className="font-display text-3xl font-bold tabular-nums leading-none text-fg">{fmtMs(totalMs)}</div>
              <div className="mono-label mt-1.5">run duration</div>
            </div>
          </section>
        </Reveal>

        {/* ------------------------- terminal + stage detail ------------------------- */}
        <section className="mt-10">
          <SectionHead
            kicker="observability"
            title="Execution stream & stage evidence"
            sub="Every line is a real event from the pipeline; expand a stage for its structured evidence."
          />
          <div className="grid gap-5 lg:grid-cols-2">
            <Reveal>
              <Terminal snap={snap} running={running} />
            </Reveal>
            <Reveal delay={100}>
              <div className="space-y-2.5">
                {PIPELINE.map((p) => (
                  <StageDetail key={p.stage} state={snap.stages[p.stage]} label={p.label} />
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* ------------------------------ artifact ledger ----------------------------- */}
        <section className="mt-10">
          <SectionHead
            kicker="supply chain"
            title="Artifact ledger"
            sub="Real SHA-256 digests over the bytes the pipeline actually produced — nothing invented."
          />
          <Reveal>
            <ArtifactTable snap={snap} />
          </Reveal>
        </section>

        {/* ------------------------- capability + environment ------------------------- */}
        <section className="mt-10">
          <SectionHead
            kicker="honesty"
            title="Capability matrix"
            sub="What genuinely runs here versus what is blocked — the console never reports a fake PASS."
          />
          <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <Reveal>
              <div className="panel overflow-hidden">
                <div className="mono-label border-b border-edge px-4 py-2.5">capability</div>
                {[
                  { name: "Project detection", state: "REAL", note: "grounds language/runtime/deps from real files", tone: "mint" },
                  { name: "Build (TS/JS)", state: "REAL", note: "in-browser bundler, real digest", tone: "mint" },
                  { name: "Test (spec assertions)", state: "REAL", note: "nexus.tests.json evaluated against build output", tone: "mint" },
                  { name: "Security review (static)", state: "REAL", note: "secrets / unsafe-config / unpinned deps", tone: "mint" },
                  { name: "SBOM (CycloneDX)", state: "REAL", note: "components from detection + artifacts", tone: "mint" },
                  { name: "Artifact registry", state: "REAL", note: "sha256 digests over real bytes", tone: "mint" },
                  { name: "Docker build", state: "BLOCKED", note: "no Docker daemon in browser runtime", tone: "gold" },
                  { name: "Container image scan", state: "BLOCKED", note: "no image + no scanner adapter", tone: "gold" },
                  { name: "OSV dependency feed", state: "BLOCKED", note: "external network feed not queried here", tone: "gold" },
                  { name: "Deployment / rollback", state: "BLOCKED", note: "no deployment target configured", tone: "gold" },
                ].map((c) => (
                  <div key={c.name} className="flex items-center gap-3 border-b border-edge/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-ink-800/40">
                    <span
                      className={cx(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded border",
                        c.tone === "mint" ? "border-mint/40 bg-mint/10 text-mint" : "border-gold/40 bg-gold/10 text-gold",
                      )}
                    >
                      <Icon name={c.tone === "mint" ? "check" : "lock"} size={12} />
                    </span>
                    <span className="flex-1 font-display text-sm font-semibold text-fg">{c.name}</span>
                    <span className="hidden font-mono text-[10px] text-dim sm:block">{c.note}</span>
                    <StatusChip status={c.tone === "mint" ? "SUCCEEDED" : "BLOCKED"} />
                  </div>
                ))}
              </div>
            </Reveal>
            <Reveal delay={100}>
              <div className="space-y-3">
                <div className="panel p-4">
                  <div className="mono-label mb-2">environment facts</div>
                  <div className="space-y-1.5 font-mono text-[11px]">
                    <div className="flex justify-between gap-2"><span className="text-dim">workspace</span><span className="text-fg">sandbox-workspace</span></div>
                    <div className="flex justify-between gap-2"><span className="text-dim">phase 1/2 source</span><span className="text-gold">NOT ATTACHED</span></div>
                    <div className="flex justify-between gap-2"><span className="text-dim">runtime</span><span className="text-fg">browser (no shell)</span></div>
                    <div className="flex justify-between gap-2"><span className="text-dim">persistence</span><span className="text-fg">in-memory session</span></div>
                    <div className="flex justify-between gap-2"><span className="text-dim">docker daemon</span><span className="text-gold">unavailable</span></div>
                  </div>
                </div>
                <div className="panel border-gold/30 p-4">
                  <div className="mono-label mb-2 flex items-center gap-2 text-gold">
                    <Icon name="alert" size={12} />
                    integrity note
                  </div>
                  <p className="text-xs leading-relaxed text-mut">
                    Stages that cannot execute in this runtime report <span className="font-mono text-gold">BLOCKED</span> with the
                    true reason. No digest, image ID, scan finding or deployment result is ever fabricated to turn a stage green.
                  </p>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------------------------------- footer ---------------------------------- */}
        <footer className="mt-14 border-t border-edge/60 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[10px] text-dim">
            <span>
              NEXUS · AI Engineering OS — phase 3 · pass 1 <span className="text-mint">▮</span>
            </span>
            <span>detect → build → test → security → docker → scan → sbom → artifact</span>
            <span>honest BLOCKED over fake SUCCESS</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
