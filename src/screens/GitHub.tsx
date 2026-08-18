/**
 * NEXUS GitHub integration — a REAL connection, not a simulation.
 *
 * The token is verified against GitHub's API (GET /user), repos are discovered
 * from the account (GET /user/repos), and artifacts can be committed through
 * the Git Data API. The token is held in memory only — reloading the app
 * clears it, and audit records carry only a masked hint.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNexus } from "../state";
import { Badge, Button, EmptyState, Field, Icon, Modal, Reveal, SectionHead, Skeleton, TextInput, cx, fmtDateTime, timeAgo } from "../ui";
import { can } from "../core/security";
import type { GitHubBranch, GitHubCommit, GitHubRepo, PullResult, PushResult, RateLimit } from "../core/github";
import { maskToken } from "../core/github";
import type { ArtifactReference, Execution, Project } from "../core/types";

type ConnPhase = "idle" | "verifying" | "fetching" | "ready";

const LANG_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Go: "#00ADD8",
  Rust: "#dea584",
  Java: "#b07219",
  Ruby: "#701516",
  Shell: "#89e051",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Vue: "#41b883",
  "C++": "#f34b7d",
  C: "#555555",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
};

function langColor(lang: string | null): string {
  return (lang && LANG_COLORS[lang]) || "#5fa8dc";
}

export function GitHubScreen() {
  const { services, user, toast } = useNexus();
  const [phase, setPhase] = useState<ConnPhase>("idle");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [query, setQuery] = useState("");
  const [rate, setRate] = useState<RateLimit | null>(null);
  const [selected, setSelected] = useState<GitHubRepo | null>(null);

  // The screen renders inside the authenticated shell; if the kernel isn't
  // up there is nothing to integrate with.
  if (!services || !user) return null;

  const connected = services.github.state().connected;
  const identity = services.github.state().identity;
  const canConnect = user ? can(user, "github:connect") : false;
  const canPush = user ? can(user, "github:push") : false;

  const connect = async () => {
    setError(null);
    setPhase("verifying");
    try {
      const who = await services.github.connect(token);
      await services.audit.record({
        actor: user.email,
        action: "github.connect",
        resource_type: "integration",
        resource_id: "github",
        result: "allow",
        metadata: { login: who.login, token_hint: who.token_hint }, // masked only — never the token
      });
      toast("ok", "Connected to GitHub", `@${who.login} verified · token held in memory only`);
      setPhase("fetching");
      setToken("");
      const list = await services.github.listRepos();
      setRepos(list);
      setRate(services.github.rateLimit());
      setPhase("ready");
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      await services.audit.record({
        actor: user.email,
        action: "github.connect_failed",
        resource_type: "integration",
        resource_id: "github",
        result: "deny",
        metadata: { reason: msg.slice(0, 120) },
      });
      setPhase(repos ? "ready" : "idle");
    }
  };

  const refresh = async () => {
    if (!connected) return;
    setPhase("fetching");
    try {
      setRepos(await services.github.listRepos());
      setRate(services.github.rateLimit());
      setPhase("ready");
    } catch (e) {
      toast("err", "Refresh failed", (e as Error).message);
      setPhase("ready");
    }
  };

  const disconnect = async () => {
    services.github.disconnect();
    setRepos(null);
    setSelected(null);
    setRate(null);
    setPhase("idle");
    await services.audit.record({
      actor: user.email,
      action: "github.disconnect",
      resource_type: "integration",
      resource_id: "github",
      result: "info",
    });
    toast("info", "Disconnected", "in-memory token cleared");
  };

  const visible = useMemo(() => {
    if (!repos) return null;
    const q = query.trim().toLowerCase();
    return q ? repos.filter((r) => r.full_name.toLowerCase().includes(q) || (r.language ?? "").toLowerCase().includes(q)) : repos;
  }, [repos, query]);

  const ratePct = rate ? Math.round((rate.remaining / Math.max(rate.limit, 1)) * 100) : null;

  return (
    <div className="space-y-6">
      <SectionHead
        kicker="integration"
        title="GitHub"
        sub="A real connection through the GitHub REST API — identity verified, repositories discovered, artifacts committed via the Git Data API."
        right={
          connected ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" icon="refresh" onClick={() => void refresh()} loading={phase === "fetching"}>
                Refresh
              </Button>
              <Button variant="danger" size="sm" icon="logout" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </div>
          ) : undefined
        }
      />

      {/* connection status strip — the characteristic opening */}
      <Reveal>
        <div className="panel panel-inset px-4 py-3 font-mono text-[11px]">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="text-dim">$ git remote -v</span>
            {connected && identity ? (
              <>
                <span className="flex items-center gap-2 text-mint">
                  <span className="h-1.5 w-1.5 rounded-full bg-mint pulse-dot" />
                  origin&nbsp;&nbsp;github.com/{identity.login} <span className="text-dim">(verified {timeAgo(identity.connected_at)})</span>
                </span>
                <span className="text-dim">token {identity.token_hint} · in-memory only</span>
                {identity.plan ? <span className="text-dim">plan {identity.plan}</span> : null}
              </>
            ) : (
              <span className="flex items-center gap-2 text-gold">
                <span className="h-1.5 w-1.5 rounded-full bg-gold pulse-dot" />
                no remote configured — connect a personal access token
              </span>
            )}
            {ratePct !== null && rate ? (
              <span className="ml-auto flex items-center gap-2">
                <span className="text-dim">rate</span>
                <span className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-700">
                  <span
                    className={cx("block h-full rounded-full transition-all duration-700", ratePct > 30 ? "bg-mint" : ratePct > 10 ? "bg-gold" : "bg-flame")}
                    style={{ width: `${ratePct}%` }}
                  />
                </span>
                <span className="tabular-nums text-mut">
                  {rate.remaining}/{rate.limit}
                </span>
              </span>
            ) : null}
          </div>
        </div>
      </Reveal>

      {!connected ? (
        <ConnectPanel
          token={token}
          setToken={setToken}
          showToken={showToken}
          setShowToken={setShowToken}
          error={error}
          busy={phase === "verifying"}
          disabled={!canConnect}
          onConnect={() => void connect()}
        />
      ) : (
        <>
          {/* discovery */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-80">
              <Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`filter ${repos?.length ?? ""} repositories…`}
                className="h-9 w-full rounded-md border border-edge bg-ink-850 pl-9 pr-3 text-sm text-fg placeholder:text-dim focus:border-mint/60 focus:outline-none"
              />
            </div>
            <span className="font-mono text-[11px] text-dim">
              {repos === null ? "discovering…" : `${visible?.length ?? 0} of ${repos.length} shown`}
            </span>
          </div>

          {visible === null ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <Skeleton className="h-36" />
              <Skeleton className="h-36" />
              <Skeleton className="h-36" />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon="github"
              title={(repos ?? []).length === 0 ? "This account exposes no repositories" : "No repositories match"}
              body={
                (repos ?? []).length === 0
                  ? "GitHub returned an empty list — with a fine-grained token only explicitly granted repositories are visible. That is the real state, not a placeholder."
                  : "Adjust the filter to see the rest of the account's repositories."
              }
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((r, i) => (
                <Reveal key={r.id} delay={Math.min(i * 40, 240)}>
                  <button onClick={() => setSelected(r)} className="panel panel-hover w-full p-4 text-left">
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex h-9 w-9 items-center justify-center rounded-md border border-edge bg-ink-800 text-sky">
                        <Icon name="github" size={17} />
                      </span>
                      <div className="flex items-center gap-1.5">
                        {r.is_private ? (
                          <Badge tone="gold">
                            <Icon name="lock" size={9} /> private
                          </Badge>
                        ) : (
                          <Badge tone="mut">public</Badge>
                        )}
                        {r.permissions.push ? (
                          <Badge tone="mint">push</Badge>
                        ) : (
                          <Badge tone="mut">read</Badge>
                        )}
                      </div>
                    </div>
                    <h3 className="mt-3 truncate font-display text-base font-semibold">{r.name}</h3>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-dim">{r.full_name}</p>
                    <p className="mt-2 line-clamp-2 min-h-[32px] text-xs text-mut">{r.description || "no description"}</p>
                    <div className="mt-3 flex items-center gap-4 font-mono text-[10px] text-dim">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ background: langColor(r.language) }} />
                        {r.language ?? "—"}
                      </span>
                      <span className="flex items-center gap-1">
                        <Icon name="star" size={10} /> {r.stars}
                      </span>
                      <span className="flex items-center gap-1">
                        <Icon name="branch" size={10} /> {r.default_branch}
                      </span>
                      <span className="ml-auto">{timeAgo(new Date(r.pushed_at).getTime())}</span>
                    </div>
                  </button>
                </Reveal>
              ))}
            </div>
          )}
        </>
      )}

      {selected ? (
        <RepoDrawer
          repo={selected}
          canPush={canPush}
          onClose={() => setSelected(null)}
          onRate={() => setRate(services.github.rateLimit())}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------- connect panel ----------------------------- */

function ConnectPanel({
  token,
  setToken,
  showToken,
  setShowToken,
  error,
  busy,
  disabled,
  onConnect,
}: {
  token: string;
  setToken: (v: string) => void;
  showToken: boolean;
  setShowToken: (v: boolean) => void;
  error: string | null;
  busy: boolean;
  disabled: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <Reveal>
        <div className="panel p-5">
          <div className="mono-label mb-3 flex items-center gap-2">
            <Icon name="plug" size={12} /> connect with a personal access token
          </div>

          {disabled ? (
            <p className="rounded border border-gold/25 bg-gold/[0.06] px-3 py-2.5 text-xs text-gold">
              Your role does not hold <span className="font-mono">github:connect</span>. Ask an OWNER or ADMIN to establish the
              integration — authorization is enforced by the kernel, not the UI.
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (token.trim()) onConnect();
              }}
              className="space-y-4"
            >
              {error ? (
                <p className="rounded border border-flame/30 bg-flame/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-flame">{error}</p>
              ) : null}

              <Field label="Personal access token" hint="Classic (ghp_…) or fine-grained (github_pat_…). Needed scopes: repo read, and Contents + Pull requests write if you plan to push.">
                <div className="flex gap-2">
                  <TextInput
                    type={showToken ? "text" : "password"}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="ghp_••••••••••••••••"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button type="button" variant="ghost" onClick={() => setShowToken(!showToken)} aria-label={showToken ? "Hide token" : "Show token"}>
                    {showToken ? <Icon name="x" size={14} /> : <Icon name="key" size={14} />}
                  </Button>
                </div>
              </Field>

              <Button type="submit" icon="plug" loading={busy} disabled={token.trim().length < 10}>
                {busy ? "Verifying against GitHub…" : "Verify & connect"}
              </Button>
            </form>
          )}

          <ul className="mt-5 space-y-1.5 border-t border-edge/60 pt-4 font-mono text-[10px] leading-relaxed text-dim">
            <li>· verified via GET /user before anything is accepted</li>
            <li>· token lives in memory only — never persisted, never logged, never in audit records</li>
            <li>· audit records carry only the masked hint (e.g. {maskToken("ghp_abcdef1234567890wxyz")})</li>
            <li>· reloading the app clears the connection by design</li>
          </ul>
        </div>
      </Reveal>

      <Reveal delay={80}>
        <div className="panel p-5">
          <div className="mono-label mb-3">what becomes available</div>
          <ul className="space-y-2.5 text-xs text-mut">
            {[
              ["github", "identity verification & rate-limit visibility"],
              ["box", "real repository discovery from the account"],
              ["branch", "branches & recent commits, browsable per repo"],
              ["play", "push execution artifacts as genuine commits (Git Data API)"],
              ["external", "open real pull requests from pushed branches"],
            ].map(([icon, text]) => (
              <li key={text} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-edge bg-ink-800 text-sky">
                  <Icon name={icon as never} size={12} />
                </span>
                {text}
              </li>
            ))}
          </ul>
          <div className="mt-4 rounded border border-edge/70 bg-ink-850 px-3 py-2.5 font-mono text-[10px] leading-relaxed text-dim">
            <span className="text-gold">honest limits:</span> OAuth app flows need a registered client + backend
            exchange, and CI webhooks need a server endpoint — neither exists in a browser-only runtime, so they are
            not offered here.
          </div>
        </div>
      </Reveal>
    </div>
  );
}

/* -------------------------------- repo drawer ------------------------------ */

function RepoDrawer({ repo, canPush, onClose, onRate }: { repo: GitHubRepo; canPush: boolean; onClose: () => void; onRate: () => void }) {
  const { services, user, toast } = useNexus();
  const [branches, setBranches] = useState<GitHubBranch[] | null>(null);
  const [commits, setCommits] = useState<GitHubCommit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pushOpen, setPushOpen] = useState(false);
  const abortRef = useRef(false);

  useEffect(() => {
    abortRef.current = false;
    setBranches(null);
    setCommits(null);
    setLoadError(null);
    (async () => {
      if (!services) return;
      try {
        const [b, c] = await Promise.all([services.github.listBranches(repo.owner, repo.name), services.github.listCommits(repo.owner, repo.name)]);
        if (abortRef.current) return;
        setBranches(b);
        setCommits(c);
        onRate();
      } catch (e) {
        if (!abortRef.current) setLoadError((e as Error).message);
      }
    })();
    return () => {
      abortRef.current = true;
    };
  }, [repo, services?.github, onRate]);

  if (!services || !user) return null;

  return (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-[#03060a]/70 anim-fade" onClick={onClose} />
      <aside className="absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto border-l border-edge-2 bg-ink-900 anim-pop">
        <div className="sticky top-0 z-10 border-b border-edge bg-ink-900/95 px-5 py-4 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Icon name="github" size={18} className="text-sky" />
                <h3 className="truncate font-display text-lg font-bold">{repo.full_name}</h3>
                {repo.is_private ? (
                  <Badge tone="gold">
                    <Icon name="lock" size={9} /> private
                  </Badge>
                ) : null}
              </div>
              <a href={repo.html_url} target="_blank" rel="noreferrer" className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-dim transition-colors hover:text-sky">
                {repo.html_url} <Icon name="external" size={10} />
              </a>
            </div>
            <button onClick={onClose} className="rounded p-1.5 text-mut hover:bg-ink-700 hover:text-fg" aria-label="Close">
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-dim">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: langColor(repo.language) }} /> {repo.language ?? "—"}
            </span>
            <span className="flex items-center gap-1"><Icon name="star" size={10} /> {repo.stars}</span>
            <span>{repo.forks} forks</span>
            <span>{repo.open_issues} open issues</span>
            <span>pushed {timeAgo(new Date(repo.pushed_at).getTime())}</span>
          </div>
        </div>

        <div className="space-y-6 p-5">
          {loadError ? (
            <p className="rounded border border-flame/30 bg-flame/10 px-3 py-2.5 font-mono text-[11px] text-flame">{loadError}</p>
          ) : null}

          {canPush && repo.permissions.push ? (
            <Button icon="play" onClick={() => setPushOpen(true)}>
              Push an execution artifact
            </Button>
          ) : (
            <p className="font-mono text-[10px] text-dim">
              {repo.permissions.push ? "your role lacks github:push — the kernel enforces it" : "this token has read-only access to this repository"}
            </p>
          )}

          {/* branches */}
          <div>
            <div className="mono-label mb-2 flex items-center gap-2">
              <Icon name="branch" size={11} /> branches · {branches?.length ?? "…"}
            </div>
            {branches === null && !loadError ? (
              <div className="space-y-1.5">
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
              </div>
            ) : branches && branches.length === 0 ? (
              <p className="font-mono text-[11px] text-dim">no branches visible to this token</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {branches?.map((b) => (
                  <span
                    key={b.name}
                    title={b.sha}
                    className={cx(
                      "flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[11px]",
                      b.name === repo.default_branch ? "border-mint/40 bg-mint/10 text-mint" : "border-edge text-mut",
                    )}
                  >
                    <Icon name="branch" size={10} />
                    {b.name}
                    {b.is_protected ? <Icon name="shield" size={10} className="text-gold" /> : null}
                    <span className="text-dim/70">{b.sha.slice(0, 7)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* commits */}
          <div>
            <div className="mono-label mb-2 flex items-center gap-2">
              <Icon name="clock" size={11} /> recent commits · {commits?.length ?? "…"}
            </div>
            {commits === null && !loadError ? (
              <div className="space-y-1.5">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            ) : commits && commits.length === 0 ? (
              <p className="font-mono text-[11px] text-dim">no commits visible — this may be an empty repository</p>
            ) : (
              <div className="relative space-y-0">
                <span className="absolute bottom-3 left-[9px] top-3 w-px bg-edge" />
                {commits?.map((c, i) => (
                  <div key={c.sha} className="relative flex gap-3 py-2">
                    <span
                      className={cx(
                        "relative z-10 mt-1 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-ink-900",
                        i === 0 ? "border-mint/60" : "border-edge",
                      )}
                    >
                      <span className={cx("h-1.5 w-1.5 rounded-full", i === 0 ? "bg-mint" : "bg-dim")} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-fg">{c.message.split("\n")[0]}</p>
                      <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-dim">
                        <a href={c.html_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded bg-ink-800 px-1.5 py-0.5 text-sky transition-colors hover:bg-ink-700">
                          {c.sha.slice(0, 7)} <Icon name="external" size={9} />
                        </a>
                        <span>{c.author}</span>
                        <span>{fmtDateTime(new Date(c.date).getTime())}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>

      <PushModal repo={repo} open={pushOpen} onClose={() => setPushOpen(false)} actorEmail={user.email} onPushed={(r) => toast("ok", "Artifact committed to GitHub", `${r.commit_sha.slice(0, 7)} on ${r.branch}${r.created_branch ? " (branch created)" : ""}`)} />
    </div>
  );
}

/* --------------------------------- push modal ------------------------------ */

function PushModal({
  repo,
  open,
  onClose,
  actorEmail,
  onPushed,
}: {
  repo: GitHubRepo;
  open: boolean;
  onClose: () => void;
  actorEmail: string;
  onPushed: (r: PushResult) => void;
}) {
  const { services, user } = useNexus();
  const [executions, setExecutions] = useState<Execution[] | null>(null);
  const [executionId, setExecutionId] = useState("");
  const [artifacts, setArtifacts] = useState<ArtifactReference[] | null>(null);
  const [artifactId, setArtifactId] = useState("");
  const [branch, setBranch] = useState(`nexus/evidence`);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PushResult | null>(null);
  const [prResult, setPrResult] = useState<PullResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setPrResult(null);
    setError(null);
    setArtifactId("");
    setArtifacts(null);
    (async () => {
      if (!services || !user) return;
      try {
        const list = await services.executions.list(user);
        setExecutions(list);
        if (list.length > 0) setExecutionId(list[0].id);
      } catch {
        setExecutions([]);
      }
    })();
  }, [open, services?.executions, user]);

  useEffect(() => {
    if (!executionId) {
      setArtifacts(null);
      return;
    }
    (async () => {
      if (!services) return;
      const list = await services.artifacts.list(executionId);
      setArtifacts(list);
      setArtifactId(list[0]?.id ?? "");
    })();
  }, [executionId, services?.artifacts]);

  // Push/PR live inside the authenticated shell.
  if (!services || !user) return null;

  const artifact = artifacts?.find((a) => a.id === artifactId) ?? null;
  const execution = executions?.find((e) => e.id === executionId) ?? null;

  const push = async () => {
    if (!artifact || !execution) return;
    setBusy(true);
    setError(null);
    try {
      // Read the real artifact content back from the store.
      const stored = (await services.engine.get<ArtifactReference & { __content?: string }>("artifacts", artifact.id)) as
        | (ArtifactReference & { __content?: string })
        | undefined;
      const content = stored?.__content ?? "";
      const path = `nexus/artifacts/${execution.id}/${artifact.name}`;
      const commitMsg = message.trim() || `nexus: evidence ${artifact.kind} for ${execution.id}`;
      const res = await services.github.pushFile(repo.owner, repo.name, branch.trim() || repo.default_branch, path, content, commitMsg);
      setResult(res);
      onPushed(res);
      await services.audit.record({
        actor: actorEmail,
        action: "github.push",
        resource_type: "execution",
        resource_id: execution.id,
        result: "allow",
        metadata: { repo: repo.full_name, branch: res.branch, commit: res.commit_sha.slice(0, 12), artifact: artifact.name }, // sha prefix only
      });
      await services.evidence.record(execution.id, {
        type: "report",
        source: "REAL_EXECUTION",
        content: JSON.stringify({ provider: "github", repo: repo.full_name, commit_sha: res.commit_sha, tree_sha: res.tree_sha, branch: res.branch, url: res.html_url, created_branch: res.created_branch }),
        metadata: { kind: "github_commit", commit: res.commit_sha },
      });
    } catch (e) {
      setError((e as Error).message);
      await services.audit.record({
        actor: actorEmail,
        action: "github.push_failed",
        resource_type: "execution",
        resource_id: executionId,
        result: "deny",
        metadata: { repo: repo.full_name, reason: (e as Error).message.slice(0, 120) },
      });
    } finally {
      setBusy(false);
    }
  };

  const openPr = async () => {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const pr = await services.github.createPullRequest(
        repo.owner,
        repo.name,
        result.branch,
        repo.default_branch,
        `nexus: evidence for execution ${executionId.slice(0, 16)}…`,
        [
          "Automated by the NEXUS control plane from a verified execution artifact.",
          "",
          `- execution: \`${executionId}\``,
          `- artifact: \`${artifact?.name ?? "—"}\` (${artifact?.digest ?? "—"})`,
          `- commit: ${result.html_url}`,
          "",
          "_This PR was opened through the GitHub API by an authenticated NEXUS session._",
        ].join("\n"),
      );
      setPrResult(pr);
      await services.audit.record({
        actor: actorEmail,
        action: "github.pr_created",
        resource_type: "execution",
        resource_id: executionId,
        result: "allow",
        metadata: { repo: repo.full_name, pr: pr.number, url: pr.html_url },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Push execution artifact" subtitle={`${repo.full_name} — a real commit through the Git Data API (blob → tree → commit → ref).`} width="max-w-2xl">
      <div className="space-y-4">
        {error ? <p className="rounded border border-flame/30 bg-flame/10 px-3 py-2.5 font-mono text-[11px] text-flame">{error}</p> : null}

        {result ? (
          <div className="anim-pop space-y-3 rounded-md border border-moss/30 bg-moss/[0.06] p-4">
            <div className="flex items-center gap-2 font-display text-sm font-semibold text-moss">
              <Icon name="check" size={15} /> Committed to GitHub
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px] text-mut">
              <span className="text-dim">commit</span>
              <a href={result.html_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sky hover:underline">
                {result.commit_sha.slice(0, 12)}… <Icon name="external" size={10} />
              </a>
              <span className="text-dim">branch</span>
              <span>
                {result.branch} {result.created_branch ? <Badge tone="mint" className="ml-1">created</Badge> : null}
              </span>
              <span className="text-dim">tree</span>
              <span>{result.tree_sha.slice(0, 12)}…</span>
              <span className="text-dim">blob</span>
              <span>{result.blob_sha.slice(0, 12)}…</span>
            </div>
            {prResult ? (
              <a href={prResult.html_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-mono text-[11px] text-sky hover:underline">
                pull request #{prResult.number} ({prResult.head} → {prResult.base}) <Icon name="external" size={10} />
              </a>
            ) : (
              <Button size="sm" variant="outline" icon="external" loading={busy} onClick={() => void openPr()}>
                Open pull request → {repo.default_branch}
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Execution">
                <select
                  value={executionId}
                  onChange={(e) => setExecutionId(e.target.value)}
                  className="h-9 w-full rounded-md border border-edge bg-ink-850 px-2 text-sm text-fg focus:border-mint/60 focus:outline-none"
                >
                  {executions === null ? <option>loading…</option> : null}
                  {executions?.length === 0 ? <option value="">no executions yet</option> : null}
                  {executions?.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.id.slice(0, 18)}… · {e.status}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Artifact">
                <select
                  value={artifactId}
                  onChange={(e) => setArtifactId(e.target.value)}
                  className="h-9 w-full rounded-md border border-edge bg-ink-850 px-2 text-sm text-fg focus:border-mint/60 focus:outline-none"
                >
                  {artifacts === null ? <option>loading…</option> : null}
                  {artifacts?.length === 0 ? <option value="">no artifacts for this execution</option> : null}
                  {artifacts?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.kind}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {artifact ? (
              <div className="rounded-md border border-edge/70 bg-ink-850 px-3 py-2.5 font-mono text-[10px] text-dim">
                digest <span className="text-mut">{artifact.digest}</span> · {artifact.size} bytes ·{" "}
                <span className="text-mut">nexus/artifacts/{executionId.slice(0, 12)}…/{artifact.name}</span>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Target branch" hint="created automatically if it does not exist">
                <TextInput value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={repo.default_branch} />
              </Field>
              <Field label="Commit message">
                <TextInput value={message} onChange={(e) => setMessage(e.target.value)} placeholder="nexus: evidence …" />
              </Field>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button icon="play" loading={busy} disabled={!artifact} onClick={() => void push()}>
                Commit artifact
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
