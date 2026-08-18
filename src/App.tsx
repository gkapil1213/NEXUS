/**
 * NEXUS Phase 1 — application shell.
 * Opens with the real kernel boot sequence; gates on an authenticated
 * identity (first run initializes the platform OWNER); routes between the
 * five control-plane areas. Responsive: sidebar on desktop, bottom bar on
 * mobile.
 */

import { useState } from "react";
import { NexusProvider, useNexus, type RouteName } from "./state";
import { CONFIG } from "./core/config";
import { Badge, Button, Field, Icon, TextInput, cx, type IconName } from "./ui";
import { DashboardScreen } from "./screens/Dashboard";
import { ProjectsScreen } from "./screens/Projects";
import { ExecutionsScreen } from "./screens/Executions";
import { AuditScreen } from "./screens/Audit";
import { ControlPlaneScreen } from "./screens/ControlPlane";

const NAV: { name: RouteName; label: string; icon: IconName }[] = [
  { name: "dashboard", label: "Dashboard", icon: "grid" },
  { name: "projects", label: "Projects", icon: "box" },
  { name: "executions", label: "Executions", icon: "play" },
  { name: "audit", label: "Audit", icon: "scroll" },
  { name: "control", label: "Control Plane", icon: "terminal" },
];

/* -------------------------------- boot screen ------------------------------ */

function BootScreen() {
  const { bootSteps, bootError, retryBoot } = useNexus();
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md anim-rise">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-mint/40 bg-mint/10 font-display text-lg font-bold text-mint">N</span>
          <div>
            <div className="font-display text-xl font-bold tracking-tight">NEXUS<span className="caret text-mint">_</span></div>
            <div className="mono-label">engineering control platform</div>
          </div>
        </div>
        <div className="panel overflow-hidden">
          <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-3">
            <Icon name="terminal" size={11} /> kernel boot
          </div>
          <div className="scanlines">
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
        {bootError ? (
          <div className="mt-4 rounded-md border border-flame/30 bg-flame/10 p-4">
            <p className="font-mono text-xs text-flame">{bootError}</p>
            <Button variant="danger" className="mt-3" icon="refresh" onClick={retryBoot}>Retry boot</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------ identity gate ------------------------------ */

function IdentityGate() {
  const { initializing, bootstrap, login, toasts } = useNexus();
  const [mode, setMode] = useState<"bootstrap" | "login">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  void toasts;

  const actualMode = initializing ? "bootstrap" : mode;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (actualMode === "bootstrap") await bootstrap(email, name, password);
      else await login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md anim-rise">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-mint/40 bg-mint/10 font-display text-lg font-bold text-mint">N</span>
          <div>
            <div className="font-display text-xl font-bold tracking-tight">NEXUS<span className="caret text-mint">_</span></div>
            <div className="mono-label">engineering control platform</div>
          </div>
        </div>

        {initializing ? (
          <div className="mb-4 flex items-start gap-2.5 rounded-md border border-gold/30 bg-gold/[0.07] px-3.5 py-3">
            <Icon name="key" size={15} className="mt-0.5 shrink-0 text-gold" />
            <p className="text-xs leading-relaxed text-mut">
              <span className="font-medium text-gold">First boot.</span> No identities exist in the database. Initialize the
              platform operator — it becomes the <span className="text-fg">OWNER</span> and is recorded in the audit trail.
              Credentials are PBKDF2-hashed; plaintext never persists.
            </p>
          </div>
        ) : null}

        <div className="panel overflow-hidden">
          <div className="grid grid-cols-2 border-b border-edge font-mono text-xs uppercase tracking-[0.18em]">
            {(["login", "bootstrap"] as const).map((m) => (
              <button
                key={m}
                disabled={initializing}
                onClick={() => setMode(m)}
                className={cx("py-3 transition-colors disabled:opacity-40", actualMode === m ? "bg-ink-800 text-mint" : "text-dim hover:text-mut")}
              >
                {m === "login" ? "Sign in" : "Initialize"}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="space-y-4 p-6">
            {error ? (
              <p className="flex items-start gap-2 rounded-md border border-flame/30 bg-flame/10 px-3 py-2.5 text-sm text-flame anim-pop">
                <Icon name="alert" size={15} className="mt-0.5 shrink-0" />{error}
              </p>
            ) : null}
            {actualMode === "bootstrap" ? (
              <Field label="Operator name">
                <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoComplete="name" required />
              </Field>
            ) : null}
            <Field label="Email">
              <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="operator@nexus.local" autoComplete="email" required />
            </Field>
            <Field label="Password" hint={actualMode === "bootstrap" ? "min 8 chars, letters + digits — hashed with PBKDF2 before storage" : undefined}>
              <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={actualMode === "bootstrap" ? "new-password" : "current-password"} required />
            </Field>
            <Button type="submit" loading={busy} className="w-full" icon={actualMode === "bootstrap" ? "key" : "lock"}>
              {actualMode === "bootstrap" ? "Initialize platform identity" : "Authenticate"}
            </Button>
            <p className="text-center font-mono text-[10px] text-dim">
              sessions expire after {Math.round(CONFIG.sessionTtlMs / 3_600_000)}h · every authentication event is audited
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- shell ---------------------------------- */

function Shell() {
  const { user, route, navigate, logout, liveEvents } = useNexus();
  const latest = liveEvents[0];

  return (
    <div className="flex min-h-screen">
      {/* sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-edge/70 bg-ink-900/60 md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md border border-mint/40 bg-mint/10 font-display text-sm font-bold text-mint">N</span>
          <div>
            <div className="font-display text-[15px] font-bold leading-none tracking-tight">NEXUS<span className="text-mint">_</span></div>
            <div className="mono-label mt-1">phase 1 foundation</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
          {NAV.map((item) => {
            const active = route === item.name;
            return (
              <button
                key={item.name}
                onClick={() => navigate(item.name)}
                className={cx(
                  "flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-all",
                  active
                    ? "border-mint/25 bg-mint/[0.09] text-mint shadow-[inset_2px_0_0_0_#2bd4a7]"
                    : "border-transparent text-mut hover:bg-ink-800/70 hover:text-fg",
                )}
              >
                <Icon name={item.icon} size={15} />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="border-t border-edge/70 p-3">
          <div className="flex items-center gap-2.5 rounded-md border border-edge bg-ink-850 px-3 py-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-edge bg-ink-800 font-display text-xs font-bold text-mint">
              {user?.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-fg">{user?.name}</div>
              <div className="font-mono text-[10px] text-gold">{user?.role}</div>
            </div>
            <button onClick={() => void logout()} className="text-dim transition-colors hover:text-flame" title="Sign out">
              <Icon name="logout" size={15} />
            </button>
          </div>
        </div>
      </aside>

      {/* main column */}
      <div className="flex min-w-0 flex-1 flex-col pb-16 md:pb-0">
        <header className="sticky top-0 z-30 border-b border-edge/70 bg-ink-950/80 backdrop-blur">
          <div className="flex items-center gap-3 px-4 py-3 lg:px-8">
            <span className="font-display text-sm font-bold md:hidden">NEXUS<span className="text-mint">_</span></span>
            <span className="hidden font-mono text-[11px] text-dim md:block">
              {NAV.find((n) => n.name === route)?.label}
            </span>
            <div className="ml-auto flex items-center gap-2.5">
              {latest ? (
                <span className="hidden items-center gap-2 font-mono text-[10px] text-dim lg:flex">
                  <span className="h-1.5 w-1.5 rounded-full bg-mint pulse-dot" />
                  {latest.type} <span className="text-dim/60">#{latest.seq}</span>
                </span>
              ) : null}
              <Badge tone={CONFIG.env === "PRODUCTION" ? "flame" : CONFIG.env === "STAGING" ? "gold" : "sky"}>{CONFIG.env}</Badge>
              <Badge tone="mut">v{CONFIG.version}</Badge>
              <button onClick={() => void logout()} className="rounded-md border border-edge p-1.5 text-dim transition-colors hover:border-flame/40 hover:text-flame md:hidden" title="Sign out">
                <Icon name="logout" size={14} />
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 lg:px-8">
          <div key={route} className="anim-fade">
            {route === "dashboard" ? <DashboardScreen /> : null}
            {route === "projects" ? <ProjectsScreen /> : null}
            {route === "executions" ? <ExecutionsScreen /> : null}
            {route === "audit" ? <AuditScreen /> : null}
            {route === "control" ? <ControlPlaneScreen /> : null}
          </div>
        </main>

        <footer className="border-t border-edge/50 px-4 py-3 lg:px-8">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-dim">
            <span>NEXUS · AI engineering control platform</span>
            <span>phase 1 production foundation</span>
            <span className="ml-auto">RBAC-enforced · audit-logged · secrets redacted</span>
          </div>
        </footer>
      </div>

      {/* bottom nav (mobile) */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-edge bg-ink-900/95 backdrop-blur md:hidden">
        {NAV.map((item) => {
          const active = route === item.name;
          return (
            <button
              key={item.name}
              onClick={() => navigate(item.name)}
              className={cx("flex flex-1 flex-col items-center gap-1 py-2.5 text-[9px] font-mono uppercase tracking-wider transition-colors", active ? "text-mint" : "text-dim")}
            >
              <Icon name={item.icon} size={17} />
              {item.label.split(" ")[0]}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/* ---------------------------------- toasts --------------------------------- */

function ToastHost() {
  const { toasts, dismissToast } = useNexus();
  return (
    <div className="pointer-events-none fixed bottom-20 right-4 z-[90] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2 md:bottom-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "anim-toast pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-ink-850/95 px-3.5 py-3 shadow-xl backdrop-blur",
            t.kind === "ok" && "border-moss/40",
            t.kind === "err" && "border-flame/40",
            t.kind === "info" && "border-sky/40",
          )}
        >
          <Icon name={t.kind === "ok" ? "check" : t.kind === "err" ? "alert" : "bolt"} size={15} className={cx("mt-0.5 shrink-0", t.kind === "ok" ? "text-moss" : t.kind === "err" ? "text-flame" : "text-sky")} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">{t.title}</div>
            {t.detail ? <div className="mt-0.5 break-words font-mono text-[11px] text-mut">{t.detail}</div> : null}
          </div>
          <button onClick={() => dismissToast(t.id)} className="text-dim transition-colors hover:text-fg" aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function Root() {
  const { booting, user } = useNexus();
  return (
    <>
      {booting ? <BootScreen /> : user ? <Shell /> : <IdentityGate />}
      <ToastHost />
    </>
  );
}

export default function App() {
  return (
    <NexusProvider>
      <Root />
    </NexusProvider>
  );
}
