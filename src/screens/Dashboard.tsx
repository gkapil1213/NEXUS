/**
 * NEXUS Dashboard — live platform pulse. Every figure comes from the real
 * persistence layer; an empty database renders as an honest zero.
 */

import { useCallback, useEffect, useState } from "react";
import { useNexus } from "../state";
import { Badge, Button, Icon, Reveal, SectionHead, Skeleton, Stat, StatusPill, cx, fmtDuration, timeAgo } from "../ui";
import type { Execution, HealthReport, NexusEvent, Project } from "../core/types";

export function DashboardScreen() {
  const { services, user, kernel, liveEvents, navigate } = useNexus();
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [executions, setExecutions] = useState<Execution[] | null>(null);
  const [eventCount, setEventCount] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!services || !user || !kernel) return;
    try {
      const [h, p, e] = await Promise.all([kernel.health(), services.projects.list(user), services.executions.list(user)]);
      setHealth(h);
      setProjects(p);
      setExecutions(e);
      setEventCount(await services.events.count());
    } catch {
      /* surfaced via empty states */
    }
  }, [services, user, kernel]);

  useEffect(() => {
    void load();
    const iv = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(iv);
  }, [load]);

  const active = executions?.filter((e) => e.status === "RUNNING" || e.status === "QUEUED") ?? [];
  const recent = executions?.slice(0, 6) ?? [];
  const agents = services?.registry.list() ?? [];

  return (
    <div className="space-y-6">
      <SectionHead
        kicker="platform pulse"
        title={`Operations overview`}
        sub="Live state of the NEXUS foundation — read from the persistence engine, refreshed every 4s."
        right={
          health ? (
            <div className="flex items-center gap-2">
              <span className={cx("h-2 w-2 rounded-full", health.status === "healthy" ? "bg-moss pulse-dot" : health.status === "degraded" ? "bg-gold" : "bg-flame")} />
              <span className="font-mono text-xs uppercase tracking-wider text-mut">{health.status}</span>
              <Badge tone="mut">engine {health.engine}</Badge>
            </div>
          ) : null
        }
      />

      {/* stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="projects" value={projects?.length ?? "—"} icon="box" tone="text-mint" />
        <Stat label="executions" value={executions?.length ?? "—"} icon="play" tone="text-sky" />
        <Stat label="active runs" value={active.length} icon="pulse" tone={active.length > 0 ? "text-gold" : "text-fg"} />
        <Stat label="events recorded" value={eventCount ?? "—"} icon="bolt" tone="text-fg" />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* active executions */}
        <Reveal className="lg:col-span-2">
          <div className="panel overflow-hidden h-full">
            <div className="flex items-center justify-between border-b border-edge px-4 py-3">
              <span className="mono-label flex items-center gap-2"><Icon name="pulse" size={11} /> executions</span>
              <Button size="sm" variant="ghost" onClick={() => navigate("executions")}>all →</Button>
            </div>
            {executions === null ? (
              <div className="space-y-2 p-4"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
            ) : recent.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="font-mono text-xs text-dim">no executions yet — the database holds zero runs</p>
                <p className="mt-1 text-xs text-dim">submit an engineering request from a project to create the first one</p>
              </div>
            ) : (
              <div>
                {recent.map((e) => {
                  const dur = e.completed_at ? e.completed_at - e.started_at : Date.now() - e.started_at;
                  return (
                    <div key={e.id} className="flex items-center gap-3 border-b border-edge/60 px-4 py-2.5 last:border-0 transition-colors hover:bg-ink-800/40">
                      <StatusPill status={e.status} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-fg">{e.request}</p>
                        <p className="font-mono text-[10px] text-dim">{e.id.slice(0, 18)}… · {timeAgo(e.started_at)}</p>
                      </div>
                      <span className="shrink-0 font-mono text-[11px] text-mut tabular-nums">{e.status === "RUNNING" ? `${fmtDuration(dur)}…` : fmtDuration(dur)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Reveal>

        {/* live event ticker */}
        <Reveal delay={80}>
          <div className="panel overflow-hidden h-full">
            <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
              <Icon name="bolt" size={11} className="text-gold" />
              <span className="mono-label">live event stream</span>
              <span className="ml-auto h-1.5 w-1.5 rounded-full bg-mint pulse-dot" />
            </div>
            <div className="max-h-72 overflow-y-auto">
              {liveEvents.length === 0 ? (
                <p className="px-4 py-8 text-center font-mono text-[11px] text-dim">waiting for events…</p>
              ) : (
                liveEvents.map((e: NexusEvent) => (
                  <div key={e.id} className="anim-fade border-b border-edge/50 px-4 py-2 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-mint">{e.type}</span>
                      <span className="ml-auto font-mono text-[10px] text-dim tabular-nums">#{e.seq}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-[10px] text-dim">{e.source} · {timeAgo(e.timestamp)}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </Reveal>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* agents */}
        <Reveal delay={120}>
          <div className="panel overflow-hidden">
            <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-3"><Icon name="cpu" size={11} /> agent registry</div>
            {agents.length === 0 ? (
              <p className="px-4 py-8 text-center font-mono text-xs text-dim">no agents registered</p>
            ) : (
              agents.map((a) => (
                <div key={a.id} className="flex items-center gap-3 border-b border-edge/60 px-4 py-3 last:border-0">
                  <span className="flex h-9 w-9 items-center justify-center rounded-md border border-edge bg-ink-800 text-mint"><Icon name="cpu" size={16} /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-fg">{a.name} <span className="font-mono text-[10px] text-dim">v{a.version}</span></p>
                    <p className="truncate text-xs text-mut">{a.description}</p>
                  </div>
                  <div className="flex gap-1">{a.capabilities.map((c) => <Badge key={c} tone="sky">{c}</Badge>)}</div>
                </div>
              ))
            )}
          </div>
        </Reveal>

        {/* subsystem health */}
        <Reveal delay={160}>
          <div className="panel overflow-hidden">
            <div className="mono-label flex items-center gap-2 border-b border-edge px-4 py-3"><Icon name="shield" size={11} /> subsystem health</div>
            {!health ? (
              <div className="space-y-2 p-4"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
            ) : (
              health.subsystems.map((s) => (
                <div key={s.name} className="flex items-center gap-3 border-b border-edge/60 px-4 py-2.5 last:border-0">
                  <span className={cx("h-1.5 w-1.5 rounded-full", s.status === "healthy" ? "bg-moss" : s.status === "degraded" ? "bg-gold" : "bg-flame")} />
                  <span className="font-mono text-xs text-fg">{s.name}</span>
                  <span className="truncate text-[11px] text-dim">{s.detail}</span>
                  <span className="ml-auto shrink-0">
                    <StatusPill status={s.status} />
                  </span>
                </div>
              ))
            )}
          </div>
        </Reveal>
      </div>
    </div>
  );
}
