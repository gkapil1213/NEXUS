/**
 * NEXUS Executions — real execution records with per-execution event chains,
 * evidence and artifacts. Cancel is gated by RBAC; terminal states are final.
 */

import { useCallback, useEffect, useState } from "react";
import { useNexus } from "../state";
import { Badge, Button, EmptyState, Icon, Reveal, SectionHead, Skeleton, StatusPill, cx, fmtDateTime, fmtDuration, timeAgo } from "../ui";
import type { ArtifactReference, Evidence, Execution, NexusEvent, Project } from "../core/types";

export function ExecutionsScreen() {
  const { services, user, toast } = useNexus();
  const [executions, setExecutions] = useState<Execution[] | null>(null);
  const [projects, setProjects] = useState<Record<string, Project>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ events: NexusEvent[]; evidence: Evidence[]; artifacts: ArtifactReference[] } | null>(null);

  const load = useCallback(async () => {
    if (!services || !user) return;
    try {
      const [exes, prjs] = await Promise.all([services.executions.list(user), services.projects.list(user)]);
      setExecutions(exes);
      setProjects(Object.fromEntries(prjs.map((p) => [p.id, p])));
    } catch {
      setExecutions([]);
    }
  }, [services, user]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (id: string) => {
      if (open === id) {
        setOpen(null);
        return;
      }
      setOpen(id);
      setDetail(null);
      if (!services || !user) return;
      try {
        const [events, evidence, artifacts] = await Promise.all([
          services.events.byExecution(id),
          services.evidence.list(user, id),
          services.artifacts.list(id),
        ]);
        setDetail({ events, evidence, artifacts });
      } catch {
        setDetail({ events: [], evidence: [], artifacts: [] });
      }
    },
    [open, services, user],
  );

  const cancel = async (e: Execution) => {
    if (!services || !user) return;
    try {
      await services.executions.cancel(user, e.id);
      toast("ok", "Execution cancelled", e.id.slice(0, 18) + "…");
      await load();
    } catch (err) {
      toast("err", "Cancel denied", (err as Error).message);
    }
  };

  const canCancel = user?.role !== "VIEWER";

  return (
    <div className="space-y-6">
      <SectionHead
        kicker="work ledger"
        title="Executions"
        sub="Every engineering run with its real status, duration and evidence chain. Terminal states are immutable."
        right={<Button variant="outline" icon="refresh" onClick={() => void load()}>Refresh</Button>}
      />

      {executions === null ? (
        <div className="space-y-2.5"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
      ) : executions.length === 0 ? (
        <EmptyState
          icon="play"
          title="No executions recorded"
          body="The database holds zero runs. Submit an engineering request from the Projects screen to create the first execution."
        />
      ) : (
        <div className="space-y-2.5">
          {executions.map((e, i) => {
            const dur = e.completed_at ? e.completed_at - e.started_at : Date.now() - e.started_at;
            const prj = projects[e.project_id];
            const expanded = open === e.id;
            return (
              <Reveal key={e.id} delay={Math.min(i * 40, 200)}>
                <div className={cx("panel overflow-hidden transition-colors", expanded && "border-edge-2")}>
                  <button onClick={() => void toggle(e.id)} className="flex w-full items-center gap-3 p-4 text-left">
                    <StatusPill status={e.status} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg">{e.request}</p>
                      <p className="mt-0.5 font-mono text-[10px] text-dim">
                        {e.id.slice(0, 20)}… · {prj?.name ?? e.project_id.slice(0, 12)} · started {timeAgo(e.started_at)}
                      </p>
                    </div>
                    <div className="hidden sm:block text-right">
                      <div className="font-mono text-xs text-mut tabular-nums">{e.status === "RUNNING" || e.status === "QUEUED" ? `${fmtDuration(dur)}…` : fmtDuration(dur)}</div>
                      <div className="font-mono text-[10px] text-dim">{fmtDateTime(e.started_at)}</div>
                    </div>
                    {canCancel && (e.status === "QUEUED" || e.status === "RUNNING") ? (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(ev) => { ev.stopPropagation(); void cancel(e); }}
                        onKeyDown={(ev) => { if (ev.key === "Enter") { ev.stopPropagation(); void cancel(e); } }}
                        className="shrink-0 rounded border border-flame/30 px-2 py-1 font-mono text-[10px] uppercase text-flame transition-colors hover:bg-flame/10"
                      >
                        cancel
                      </span>
                    ) : null}
                    <Icon name="chevronDown" size={14} className={cx("shrink-0 text-dim transition-transform", expanded && "rotate-180")} />
                  </button>

                  {expanded ? (
                    <div className="anim-fade border-t border-edge bg-ink-850/60 p-4">
                      {e.error ? (
                        <p className="mb-3 rounded border border-flame/30 bg-flame/10 px-3 py-2 font-mono text-[11px] text-flame">
                          {e.error.code} [{e.error.category}]: {e.error.message}
                        </p>
                      ) : null}

                      {!detail ? (
                        <div className="space-y-2"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
                      ) : (
                        <div className="grid lg:grid-cols-3 gap-4">
                          {/* event chain */}
                          <div>
                            <div className="mono-label mb-2">event chain · {detail.events.length}</div>
                            <div className="space-y-1">
                              {detail.events.length === 0 ? <p className="font-mono text-[11px] text-dim">no events</p> : null}
                              {detail.events.map((ev) => (
                                <div key={ev.id} className="flex items-center gap-2 font-mono text-[11px]">
                                  <span className="text-dim tabular-nums">#{ev.seq}</span>
                                  <span className="text-mint">{ev.type}</span>
                                  <span className="ml-auto text-dim">{timeAgo(ev.timestamp)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                          {/* evidence */}
                          <div>
                            <div className="mono-label mb-2">evidence · {detail.evidence.length}</div>
                            <div className="space-y-1.5">
                              {detail.evidence.length === 0 ? <p className="font-mono text-[11px] text-dim">no evidence recorded</p> : null}
                              {detail.evidence.map((ev) => (
                                <div key={ev.id} className="panel-inset p-2">
                                  <div className="flex items-center gap-2">
                                    <Badge tone={ev.source === "REAL_EXECUTION" ? "moss" : ev.source === "STATIC_ANALYSIS" ? "sky" : "gold"}>{ev.source.replace(/_/g, " ")}</Badge>
                                    <span className="font-mono text-[10px] text-mut">{ev.type}</span>
                                  </div>
                                  <p className="mt-1 truncate font-mono text-[10px] text-dim" title={ev.hash}>{ev.hash.slice(0, 26)}…</p>
                                </div>
                              ))}
                            </div>
                          </div>
                          {/* artifacts */}
                          <div>
                            <div className="mono-label mb-2">artifacts · {detail.artifacts.length}</div>
                            <div className="space-y-1.5">
                              {detail.artifacts.length === 0 ? <p className="font-mono text-[11px] text-dim">no artifacts registered</p> : null}
                              {detail.artifacts.map((a) => (
                                <div key={a.id} className="panel-inset flex items-center gap-2 p-2">
                                  <Icon name="file" size={13} className="text-gold" />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate font-mono text-[11px] text-fg">{a.name}</p>
                                    <p className="truncate font-mono text-[10px] text-dim">{a.kind} · {a.size}B · {a.digest.slice(0, 20)}…</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </Reveal>
            );
          })}
        </div>
      )}
    </div>
  );
}
