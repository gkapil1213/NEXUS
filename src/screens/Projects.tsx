/**
 * NEXUS Projects — real project lifecycle + engineering request submission.
 * All state comes from ProjectService; actions are gated by RBAC.
 */

import { useCallback, useEffect, useState } from "react";
import { useNexus } from "../state";
import { Badge, Button, EmptyState, Field, Icon, Modal, Reveal, SectionHead, Skeleton, StatusPill, TextArea, TextInput, cx, fmtDateTime, timeAgo } from "../ui";
import { Err } from "../core/errors";
import type { Execution, Project, ProjectStatus } from "../core/types";

export function ProjectsScreen() {
  const { services, user, toast, navigate } = useNexus();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selected, setSelected] = useState<Project | null>(null);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    if (!services || !user) return;
    try {
      setProjects(await services.projects.list(user));
    } catch {
      setProjects([]);
    }
  }, [services, user]);

  useEffect(() => {
    void load();
  }, [load]);

  const openProject = useCallback(
    async (p: Project) => {
      setSelected(p);
      if (services) {
        try {
          setExecutions(await services.executions.byProject(p.id));
        } catch {
          setExecutions([]);
        }
      }
    },
    [services],
  );

  const canCreate = user?.role === "OWNER" || user?.role === "ADMIN" || user?.role === "ENGINEER";
  const canArchive = user?.role === "OWNER" || user?.role === "ADMIN";

  const changeStatus = async (p: Project, status: ProjectStatus) => {
    if (!services || !user) return;
    try {
      await services.projects.update(user, p.id, { status });
      toast("ok", `Project ${status.toLowerCase()}`, p.name);
      await load();
      if (selected?.id === p.id) setSelected({ ...p, status });
    } catch (e) {
      toast("err", "Action denied", (e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <SectionHead
        kicker="portfolio"
        title="Projects"
        sub="Real project records with lifecycle control — ACTIVE, PAUSED, ARCHIVED. Empty means the database is empty."
        right={canCreate ? <Button icon="plus" onClick={() => setCreateOpen(true)}>New project</Button> : <Badge tone="mut"><Icon name="lock" size={10} /> read-only role</Badge>}
      />

      {projects === null ? (
        <div className="space-y-2.5"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon="box"
          title="Zero projects in the database"
          body="Nothing has been created yet — this is the true persisted state. Create the first project to begin."
          action={canCreate ? <Button icon="plus" onClick={() => setCreateOpen(true)}>Create project</Button> : undefined}
        />
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
          {projects.map((p, i) => (
            <Reveal key={p.id} delay={Math.min(i * 50, 250)}>
              <button onClick={() => void openProject(p)} className="panel panel-hover w-full p-4 text-left">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex h-9 w-9 items-center justify-center rounded-md border border-edge bg-ink-800 font-display text-sm font-bold text-mint">
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  <StatusPill status={p.status} />
                </div>
                <h3 className="mt-3 font-display text-base font-semibold truncate">{p.name}</h3>
                <p className="mt-1 line-clamp-2 text-xs text-mut min-h-[32px]">{p.description || "no description"}</p>
                <div className="mt-3 flex items-center gap-2 font-mono text-[10px] text-dim">
                  <Icon name="branch" size={11} />
                  <span className="truncate">{p.repository || "no repository"} · {p.default_branch}</span>
                </div>
                <div className="mt-2 font-mono text-[10px] text-dim">created {timeAgo(p.created_at)}</div>
              </button>
            </Reveal>
          ))}
        </div>
      )}

      <CreateProjectModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void load(); }} />

      {/* project detail drawer */}
      {selected ? (
        <div className="fixed inset-0 z-[70]">
          <div className="absolute inset-0 bg-[#03060a]/70 anim-fade" onClick={() => setSelected(null)} />
          <aside className="absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto border-l border-edge-2 bg-ink-900 anim-pop">
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-edge bg-ink-900/95 px-5 py-4 backdrop-blur">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-display text-lg font-bold truncate">{selected.name}</h3>
                  <StatusPill status={selected.status} />
                </div>
                <p className="font-mono text-[10px] text-dim">{selected.id}</p>
              </div>
              <button onClick={() => setSelected(null)} className="rounded p-1.5 text-mut hover:bg-ink-700 hover:text-fg" aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="space-y-5 p-5">
              <div className="grid grid-cols-2 gap-3 font-mono text-[11px]">
                <div className="panel-inset p-3"><span className="mono-label block">repository</span><span className="text-mut break-all">{selected.repository || "—"}</span></div>
                <div className="panel-inset p-3"><span className="mono-label block">default branch</span><span className="text-mut">{selected.default_branch}</span></div>
                <div className="panel-inset p-3"><span className="mono-label block">created</span><span className="text-mut">{fmtDateTime(selected.created_at)}</span></div>
                <div className="panel-inset p-3"><span className="mono-label block">updated</span><span className="text-mut">{fmtDateTime(selected.updated_at)}</span></div>
              </div>

              {selected.description ? <p className="text-sm text-mut">{selected.description}</p> : null}

              {canArchive ? (
                <div className="flex flex-wrap gap-2">
                  {selected.status === "ACTIVE" ? (
                    <>
                      <Button variant="gold" size="sm" icon="clock" onClick={() => void changeStatus(selected, "PAUSED")}>Pause</Button>
                      <Button variant="danger" size="sm" icon="archive" onClick={() => void changeStatus(selected, "ARCHIVED")}>Archive</Button>
                    </>
                  ) : (
                    <Button variant="outline" size="sm" icon="refresh" onClick={() => void changeStatus(selected, "ACTIVE")}>Reactivate</Button>
                  )}
                </div>
              ) : null}

              <RequestPanel project={selected} onSubmitted={() => void openProject(selected)} />

              <div>
                <div className="mono-label mb-2 flex items-center gap-2"><Icon name="play" size={11} /> executions · {executions.length}</div>
                {executions.length === 0 ? (
                  <p className="font-mono text-[11px] text-dim">no executions for this project yet</p>
                ) : (
                  <div className="space-y-1.5">
                    {executions.map((e) => (
                      <button key={e.id} onClick={() => { setSelected(null); navigate("executions"); }} className="panel-inset flex w-full items-center gap-3 p-2.5 text-left transition-colors hover:border-edge-2">
                        <StatusPill status={e.status} />
                        <span className="min-w-0 flex-1 truncate text-xs text-mut">{e.request}</span>
                        <span className="shrink-0 font-mono text-[10px] text-dim">{timeAgo(e.started_at)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ request panel ------------------------------ */

function RequestPanel({ project, onSubmitted }: { project: Project; onSubmitted: () => void }) {
  const { services, user, toast } = useNexus();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ status: string; id: string; evidence: number } | null>(null);

  const canRun = user?.role !== "VIEWER" && project.status === "ACTIVE";

  const submit = async () => {
    if (!services || !user) return;
    setBusy(true);
    setError(null);
    try {
      const res = await services.orchestrator.submit(user, project.id, text);
      const evidence = await services.evidence.list(user, res.execution.id);
      setLastResult({ status: res.execution.status, id: res.execution.id, evidence: evidence.length });
      setText("");
      toast(res.execution.status === "SUCCEEDED" ? "ok" : "err", `Execution ${res.execution.status.toLowerCase()}`, res.execution.id.slice(0, 20) + "…");
      onSubmitted();
    } catch (e) {
      const msg = e instanceof Err.constructor ? (e as { message: string }).message : (e as Error).message;
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-inset p-4">
      <div className="mono-label mb-2 flex items-center gap-2"><Icon name="terminal" size={11} /> engineering request</div>
      {!canRun ? (
        <p className="text-xs text-dim">
          {project.status !== "ACTIVE" ? "project is not ACTIVE — executions are refused" : "your role cannot create executions"}
        </p>
      ) : (
        <div className="space-y-3">
          <TextArea value={text} onChange={(e) => setText(e.target.value)} placeholder="Describe the engineering work, e.g. “Design the booking confirmation flow and its API contract”" />
          {error ? <p className="rounded border border-flame/30 bg-flame/10 px-3 py-2 font-mono text-[11px] text-flame">{error}</p> : null}
          {lastResult ? (
            <p className={cx("rounded border px-3 py-2 font-mono text-[11px]", lastResult.status === "SUCCEEDED" ? "border-moss/30 bg-moss/10 text-moss" : "border-flame/30 bg-flame/10 text-flame")}>
              {lastResult.status} · {lastResult.evidence} evidence record(s) · {lastResult.id.slice(0, 22)}…
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button icon="play" loading={busy} disabled={text.trim().length < 4} onClick={() => void submit()}>
              Submit request
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- create modal ------------------------------ */

function CreateProjectModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { services, user, toast } = useNexus();
  const [form, setForm] = useState({ name: "", description: "", repository: "", default_branch: "main" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!services || !user) return;
    setBusy(true);
    setError(null);
    try {
      const p = await services.projects.create(user, form);
      toast("ok", "Project created", p.name);
      setForm({ name: "", description: "", repository: "", default_branch: "main" });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New project" subtitle="Validated, authorized and audited on creation.">
      <form onSubmit={submit} className="space-y-4">
        {error ? <p className="rounded border border-flame/30 bg-flame/10 px-3 py-2 font-mono text-xs text-flame">{error}</p> : null}
        <Field label="Name">
          <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="booking-platform" required autoFocus />
        </Field>
        <Field label="Description">
          <TextInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="what this project delivers" />
        </Field>
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="Repository (optional)">
            <TextInput value={form.repository} onChange={(e) => setForm({ ...form, repository: e.target.value })} placeholder="https://…" />
          </Field>
          <Field label="Branch">
            <TextInput value={form.default_branch} onChange={(e) => setForm({ ...form, default_branch: e.target.value })} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy} icon="plus">Create project</Button>
        </div>
      </form>
    </Modal>
  );
}

export { Err };
