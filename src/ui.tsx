/**
 * NEXUS Phase 1 — design system.
 * Space Grotesk display · IBM Plex Sans body · IBM Plex Mono data.
 */

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------------------------------- icons --------------------------------- */

const ICONS = {
  grid: (<><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>),
  box: (<><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" /><path d="M3 8l9 5 9-5" /><path d="M12 13v8" /></>),
  play: (<><circle cx="12" cy="12" r="9" /><path d="M10 8.5l6 3.5-6 3.5v-7z" /></>),
  shield: (<><path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3z" /><path d="M9 12l2 2 4-4" /></>),
  terminal: (<><rect x="2.5" y="4" width="19" height="16" rx="2" /><path d="M6.5 9l3 3-3 3" /><path d="M12.5 15h5" /></>),
  pulse: (<path d="M2 12h4l3-8 6 16 3-8h4" />),
  clock: (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>),
  check: (<path d="M4 12.5l5 5L20 6.5" />),
  x: (<path d="M6 6l12 12M18 6L6 18" />),
  alert: (<><path d="M12 3l10 18H2L12 3z" /><path d="M12 10v4M12 17.5v.5" /></>),
  lock: (<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></>),
  key: (<><circle cx="8" cy="15" r="4.5" /><path d="M11.2 11.8L20 3M17 6l2.5 2.5M14.5 8.5l2 2" /></>),
  user: (<><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1-3.5 3.7-5.5 7-5.5s6 2 7 5.5" /></>),
  database: (<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>),
  layers: (<><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 12l10 5 10-5" /><path d="M2 17l10 5 10-5" /></>),
  bolt: (<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />),
  file: (<><path d="M6 2h8l5 5v15H6V2z" /><path d="M14 2v5h5" /></>),
  plus: (<path d="M12 5v14M5 12h14" />),
  archive: (<><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 001 1h12a1 1 0 001-1V9" /><path d="M10 13h4" /></>),
  chevronDown: (<path d="M6 9l6 6 6-6" />),
  chevronRight: (<path d="M9 6l6 6-6 6" />),
  logout: (<><path d="M9 21H6a2 2 0 01-2-2V5a2 2 0 012-2h3" /><path d="M15 16l4-4-4-4" /><path d="M19 12H9" /></>),
  cpu: (<><rect x="6" y="6" width="12" height="12" rx="1.5" /><rect x="10" y="10" width="4" height="4" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>),
  refresh: (<><path d="M20 12a8 8 0 10-2.3 5.6" /><path d="M20 21v-5h-5" /></>),
  copy: (<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></>),
  branch: (<><circle cx="6" cy="5" r="2.5" /><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 7.5v9" /><path d="M18 10.5c0 4-6 3.5-9.5 5.5" /></>),
  flask: (<><path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 001.4 2h12.2a1.5 1.5 0 001.4-2L14 9V3" /><path d="M7 15h10" /></>),
  scroll: (<><path d="M8 21h9a3 3 0 003-3V6a3 3 0 00-3-3H8" /><path d="M8 3a3 3 0 00-3 3v12a3 3 0 003 3 3 3 0 003-3V6a3 3 0 00-3-3z" /><path d="M11 8h5M11 12h5" /></>),
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cx("shrink-0", className)} aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

/* --------------------------------- controls -------------------------------- */

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cx("animate-spin", className)} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

type BtnVariant = "solid" | "outline" | "ghost" | "danger" | "gold";

export function Button({
  variant = "solid",
  size = "md",
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md"; loading?: boolean; icon?: IconName }) {
  const base =
    "inline-flex items-center justify-center gap-1.5 font-medium rounded-md transition-all duration-150 select-none " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mint " +
    "active:scale-[0.98] disabled:opacity-45 disabled:pointer-events-none";
  const sizes = size === "sm" ? "text-xs px-2.5 h-7" : "text-sm px-3.5 h-9";
  const variants: Record<BtnVariant, string> = {
    solid: "bg-mint text-ink-950 hover:bg-[#4ce0b8] shadow-[0_0_18px_-6px_rgba(43,212,167,0.55)]",
    outline: "border border-edge-2 text-fg hover:border-mint/60 hover:text-mint bg-ink-800/40",
    ghost: "text-mut hover:text-fg hover:bg-ink-700/60",
    danger: "bg-flame/15 text-flame border border-flame/30 hover:bg-flame/25",
    gold: "bg-gold/15 text-gold border border-gold/30 hover:bg-gold/25",
  };
  return (
    <button className={cx(base, sizes, variants[variant], className)} disabled={disabled || loading} {...rest}>
      {loading ? <Spinner size={size === "sm" ? 12 : 14} /> : icon ? <Icon name={icon} size={size === "sm" ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

export type Tone = "mint" | "gold" | "flame" | "moss" | "sky" | "mut";

const TONES: Record<Tone, string> = {
  mint: "text-mint border-mint/30 bg-mint/10",
  gold: "text-gold border-gold/30 bg-gold/10",
  flame: "text-flame border-flame/30 bg-flame/10",
  moss: "text-moss border-moss/30 bg-moss/10",
  sky: "text-sky border-sky/30 bg-sky/10",
  mut: "text-mut border-edge-2 bg-ink-700/50",
};

export function Badge({ tone = "mut", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider", TONES[tone], className)}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "moss", PAUSED: "gold", ARCHIVED: "mut",
  QUEUED: "sky", RUNNING: "gold", SUCCEEDED: "moss", FAILED: "flame", CANCELLED: "mut",
  PASSED: "moss", BLOCKED: "gold", NOT_EXECUTED: "mut",
  healthy: "moss", degraded: "gold", blocked: "flame",
  allow: "moss", deny: "flame", error: "flame", info: "sky",
};

export function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "mut";
  const live = status === "RUNNING" || status === "QUEUED";
  return (
    <Badge tone={tone}>
      <span className={cx("h-1.5 w-1.5 rounded-full bg-current", live && "pulse-dot")} />
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

export function Field({ label, error, hint, children }: { label: string; error?: string | null; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mono-label block mb-1.5">{label}</span>
      {children}
      {error ? (
        <span className="mt-1.5 flex items-center gap-1.5 text-xs text-flame"><Icon name="alert" size={12} />{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-xs text-dim">{hint}</span>
      ) : null}
    </label>
  );
}

const inputBase =
  "w-full bg-ink-850 border border-edge rounded-md px-3 text-sm text-fg placeholder:text-dim " +
  "focus:outline-none focus:border-mint/60 focus:ring-2 focus:ring-mint/15 transition-colors";

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(inputBase, "h-9", className)} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(inputBase, "py-2 min-h-[96px]", className)} {...rest} />;
}

/* --------------------------------- layout ---------------------------------- */

export function SectionHead({ kicker, title, sub, right }: { kicker?: string; title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        {kicker ? <div className="mono-label text-mint mb-1.5">{kicker}</div> : null}
        <h2 className="font-display text-xl sm:text-2xl font-bold tracking-tight">{title}</h2>
        {sub ? <p className="text-sm text-mut mt-1 max-w-2xl">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function Stat({ label, value, tone = "text-fg", icon }: { label: string; value: number | string; tone?: string; icon?: IconName }) {
  const display = useCountUp(typeof value === "number" ? value : null);
  return (
    <div className="panel panel-hover p-4">
      <div className="flex items-center justify-between">
        <span className="mono-label">{label}</span>
        {icon ? <Icon name={icon} size={14} className="text-dim" /> : null}
      </div>
      <div className={cx("mt-2 font-display text-3xl font-bold tabular-nums tracking-tight", tone)}>
        {typeof value === "number" ? display : value}
      </div>
    </div>
  );
}

export function useCountUp(target: number | null, duration = 700): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (target === null) return;
    if (target === 0) { setV(0); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      setV(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return v;
}

export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { threshold: 0.08 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ transitionDelay: `${delay}ms` }} className={cx("reveal", seen && "reveal-in", className)}>
      {children}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="panel border-dashed !bg-ink-900/50 px-6 py-12 text-center anim-fade">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-edge bg-ink-800 text-mint">
        <Icon name={icon} size={22} />
      </div>
      <h3 className="font-display text-lg font-semibold">{title}</h3>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-mut">{body}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Modal({ open, onClose, title, subtitle, children, width = "max-w-lg" }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode; width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto p-4 pt-[10vh]">
      <div className="fixed inset-0 bg-[#03060a]/75 backdrop-blur-[2px] anim-fade" onClick={onClose} />
      <div className={cx("relative w-full rounded-xl border border-edge-2 bg-ink-850 shadow-2xl anim-pop", width)}>
        <div className="flex items-start justify-between gap-4 border-b border-edge px-5 py-4">
          <div>
            <h3 className="font-display text-base font-semibold">{title}</h3>
            {subtitle ? <p className="mt-0.5 text-xs text-mut">{subtitle}</p> : null}
          </div>
          <button onClick={onClose} className="rounded p-1 text-mut transition-colors hover:bg-ink-700 hover:text-fg" aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded bg-ink-700/70", className)} />;
}

export function CopyBtn({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="inline-flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 font-mono text-[10px] text-dim transition-colors hover:border-mint/50 hover:text-mint"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); } catch { /* unavailable */ }
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
      title={value}
    >
      <Icon name={done ? "check" : "copy"} size={10} />
      {done ? "copied" : label ?? value.slice(0, 10)}
    </button>
  );
}

/* -------------------------------- formatting ------------------------------- */

export function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
