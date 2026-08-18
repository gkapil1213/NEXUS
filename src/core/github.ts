/**
 * NEXUS Phase 1+ — real GitHub integration (browser-native).
 *
 * GitHub's REST API accepts authenticated CORS requests, so a genuine
 * connection works from the running app using a Personal Access Token:
 *
 *   connect      GET  /user                       (verify identity)
 *   repos        GET  /user/repos                 (real discovery)
 *   repo         GET  /repos/{owner}/{repo}
 *   branches     GET  /repos/{owner}/{repo}/branches
 *   commits      GET  /repos/{owner}/{repo}/commits
 *   push         POST /repos/.../git/blobs|trees|commits + PATCH ref
 *                (the Git Data API — real commits, no shell/git required)
 *   pull request POST /repos/{owner}/{repo}/pulls
 *
 * Security model:
 *   - the token lives ONLY in memory on this service instance; it is never
 *     persisted (IndexedDB/localStorage), never logged, never placed in
 *     audit metadata — audit records carry only a masked hint (ghp_••••1234)
 *   - reloading the app clears the connection by design (stated in the UI)
 *   - rate-limit state is read from real response headers
 *   - failures surface as structured NexusErrors with GitHub's real message
 *
 * Not supported (and labelled honestly in the UI): OAuth web/device flows
 * require a registered OAuth app + backend exchange; classic CI webhooks
 * require a server endpoint. Neither exists in a browser-only runtime.
 */

import { CONFIG } from "./config";
import { Err } from "./errors";

/* ---------------------------------- types --------------------------------- */

export interface RateLimit {
  limit: number;
  remaining: number;
  reset_at: number; // ms epoch
}

export interface GitHubIdentity {
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
  plan: string | null;
  public_repos: number;
  connected_at: number;
  token_hint: string; // masked — the only token-derived value ever exposed
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  html_url: string;
  is_private: boolean;
  default_branch: string;
  language: string | null;
  stars: number;
  forks: number;
  open_issues: number;
  pushed_at: string;
  permissions: { admin: boolean; push: boolean; pull: boolean };
}

export interface GitHubBranch {
  name: string;
  sha: string;
  is_protected: boolean;
}

export interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  html_url: string;
}

export interface PushResult {
  commit_sha: string;
  tree_sha: string;
  blob_sha: string;
  branch: string;
  created_branch: boolean;
  html_url: string;
}

export interface PullResult {
  number: number;
  html_url: string;
  head: string;
  base: string;
  state: string;
}

export interface ConnectionState {
  connected: boolean;
  identity: GitHubIdentity | null;
  rate: RateLimit | null;
}

/* --------------------------------- helpers -------------------------------- */

/** Mask a token for display/audit: keep only the last 4 characters. */
export function maskToken(token: string): string {
  if (!token) return "—";
  const tail = token.slice(-4);
  const prefix = token.startsWith("github_pat_") ? "github_pat_••••" : token.slice(0, 4) + "••••";
  return `${prefix}${tail}`;
}

/** Validate a commit file path before it is sent to GitHub. */
export function assertSafeCommitPath(path: string): string {
  const p = path.trim();
  if (!p || p.length > 200) throw Err.validation("INVALID_PATH", "path must be 1–200 characters");
  if (p.includes("..")) throw Err.validation("PATH_TRAVERSAL", "path traversal is not permitted");
  if (p.startsWith("/") || p.includes("\\") || p.includes(":")) {
    throw Err.validation("UNSAFE_PATH", "absolute, backslash or drive paths are not permitted");
  }
  return p;
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  token: string;
}

interface ApiResult<T> {
  data: T;
  rate: RateLimit | null;
}

async function api<T>(path: string, opts: ApiOptions): Promise<ApiResult<T>> {
  const base = (CONFIG as unknown as { githubApi?: string }).githubApi ?? "https://api.github.com";
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${opts.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw Err.runtime("NETWORK_UNAVAILABLE", `GitHub API unreachable from this runtime (${(e as Error).message ?? "fetch failed"})`);
  }

  const rate = readRate(res);

  if (res.status === 401) {
    throw Err.auth("GITHUB_UNAUTHORIZED", "GitHub rejected the token (401). Check that it is valid and unexpired.");
  }
  if (res.status === 403) {
    if (rate && rate.remaining === 0) {
      throw Err.runtime("GITHUB_RATE_LIMITED", `GitHub rate limit exhausted — resets ${new Date(rate.reset_at).toLocaleTimeString()}`);
    }
    const msg = await safeMessage(res);
    throw Err.denied("GITHUB_FORBIDDEN", msg ?? "GitHub denied this action (403) — the token likely lacks the required scope or repository access.");
  }
  if (res.status === 404) {
    throw Err.notFound("GITHUB_NOT_FOUND", "GitHub returned 404 — the resource is missing or invisible to this token.");
  }
  if (res.status === 422) {
    const msg = await safeMessage(res);
    throw Err.validation("GITHUB_INVALID", msg ?? "GitHub rejected the request (422) — check branch, base and permissions.");
  }
  if (!res.ok) {
    const msg = await safeMessage(res);
    throw Err.runtime("GITHUB_ERROR", `GitHub error ${res.status}${msg ? `: ${msg}` : ""}`);
  }

  const data = (res.status === 204 ? null : await res.json()) as T;
  return { data, rate };
}

function readRate(res: Response): RateLimit | null {
  const limit = Number(res.headers.get("x-ratelimit-limit"));
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return null;
  return { limit, remaining, reset_at: Number.isFinite(reset) ? reset * 1000 : Date.now() };
}

async function safeMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { message?: string; errors?: { message?: string }[] };
    return body.message ?? body.errors?.[0]?.message ?? null;
  } catch {
    return null;
  }
}

/* --------------------------------- service -------------------------------- */

export class GitHubService {
  private token: string | null = null;
  private identity: GitHubIdentity | null = null;
  private rate: RateLimit | null = null;

  state(): ConnectionState {
    return { connected: this.identity !== null, identity: this.identity, rate: this.rate };
  }

  hint(): string | null {
    return this.identity?.token_hint ?? null;
  }

  /** Verify the token against GitHub and establish the session connection. */
  async connect(rawToken: string): Promise<GitHubIdentity> {
    const token = rawToken.trim();
    if (token.length < 20 || /\s/.test(token)) {
      throw Err.validation("INVALID_TOKEN", "that does not look like a GitHub token (classic ghp_… or fine-grained github_pat_…)");
    }
    const { data, rate } = await api<{ login: string; name: string | null; avatar_url: string; html_url: string; plan?: { name?: string }; public_repos: number }>("/user", { token });
    this.token = token;
    this.rate = rate;
    this.identity = {
      login: data.login,
      name: data.name,
      avatar_url: data.avatar_url,
      html_url: data.html_url,
      plan: data.plan?.name ?? null,
      public_repos: data.public_repos,
      connected_at: Date.now(),
      token_hint: maskToken(token),
    };
    return this.identity;
  }

  /** Clear the in-memory token and identity. Nothing persisted is touched. */
  disconnect(): void {
    this.token = null;
    this.identity = null;
    this.rate = null;
  }

  private requireToken(): string {
    if (!this.token) throw Err.auth("GITHUB_NOT_CONNECTED", "connect a GitHub token first");
    return this.token;
  }

  async listRepos(limit = 60): Promise<GitHubRepo[]> {
    const token = this.requireToken();
    const { data, rate } = await api<
      {
        id: number;
        full_name: string;
        owner: { login: string };
        name: string;
        description: string | null;
        html_url: string;
        private: boolean;
        default_branch: string;
        language: string | null;
        stargazers_count: number;
        forks_count: number;
        open_issues_count: number;
        pushed_at: string;
        permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
      }[]
    >(`/user/repos?affiliation=owner,collaborator&sort=pushed&per_page=${limit}`, { token });
    this.rate = rate ?? this.rate;
    return data.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      owner: r.owner.login,
      name: r.name,
      description: r.description,
      html_url: r.html_url,
      is_private: r.private,
      default_branch: r.default_branch,
      language: r.language,
      stars: r.stargazers_count,
      forks: r.forks_count,
      open_issues: r.open_issues_count,
      pushed_at: r.pushed_at,
      permissions: { admin: r.permissions?.admin ?? false, push: r.permissions?.push ?? false, pull: r.permissions?.pull ?? false },
    }));
  }

  async listBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
    const token = this.requireToken();
    const { data, rate } = await api<{ name: string; commit: { sha: string }; protected: boolean }[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
      { token },
    );
    this.rate = rate ?? this.rate;
    return data.map((b) => ({ name: b.name, sha: b.commit.sha, is_protected: b.protected }));
  }

  async listCommits(owner: string, repo: string, limit = 20): Promise<GitHubCommit[]> {
    const token = this.requireToken();
    const { data, rate } = await api<
      { sha: string; commit: { message: string; author: { name: string; date: string } | null }; html_url: string; author: { login: string } | null }[]
    >(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=${limit}`, { token });
    this.rate = rate ?? this.rate;
    return data.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.author?.login ?? c.commit.author?.name ?? "unknown",
      date: c.commit.author?.date ?? new Date().toISOString(),
      html_url: c.html_url,
    }));
  }

  /**
   * Real commit via the Git Data API: blob → tree → commit → ref update.
   * Creates the branch when it does not exist yet. Returns genuine SHAs.
   */
  async pushFile(
    owner: string,
    repo: string,
    branch: string,
    path: string,
    content: string,
    message: string,
  ): Promise<PushResult> {
    const token = this.requireToken();
    const safePath = assertSafeCommitPath(path);
    const encOwner = encodeURIComponent(owner);
    const encRepo = encodeURIComponent(repo);

    // 1. blob
    const blob = await api<{ sha: string }>(`/repos/${encOwner}/${encRepo}/git/blobs`, {
      token,
      method: "POST",
      body: { content, encoding: "utf-8" },
    });

    // 2. base commit (or create a fresh branch rooted at the new commit)
    let baseSha: string | null = null;
    let createdBranch = false;
    try {
      const ref = await api<{ object: { sha: string } }>(`/repos/${encOwner}/${encRepo}/git/ref/heads/${encodeURIComponent(branch)}`, { token });
      baseSha = ref.data.object.sha;
    } catch (e) {
      if ((e as { code?: string }).code !== "NOT_FOUND") throw e;
      // branch does not exist — we will create it after the commit
      const def = await api<{ default_branch: string }>(`/repos/${encOwner}/${encRepo}`, { token });
      const defRef = await api<{ object: { sha: string } }>(`/repos/${encOwner}/${encRepo}/git/ref/heads/${encodeURIComponent(def.data.default_branch)}`, { token });
      baseSha = defRef.data.object.sha;
      createdBranch = true;
    }

    // 3. base tree
    const baseCommit = await api<{ tree: { sha: string } }>(`/repos/${encOwner}/${encRepo}/git/commits/${baseSha}`, { token });

    // 4. new tree with the file
    const tree = await api<{ sha: string }>(`/repos/${encOwner}/${encRepo}/git/trees`, {
      token,
      method: "POST",
      body: {
        base_tree: baseCommit.data.tree.sha,
        tree: [{ path: safePath, mode: "100644", type: "blob", sha: blob.data.sha }],
      },
    });

    // 5. commit
    const commit = await api<{ sha: string; html_url: string }>(`/repos/${encOwner}/${encRepo}/git/commits`, {
      token,
      method: "POST",
      body: { message, tree: tree.data.sha, parents: [baseSha] },
    });

    // 6. move (or create) the ref
    if (createdBranch) {
      await api(`/repos/${encOwner}/${encRepo}/git/refs`, {
        token,
        method: "POST",
        body: { ref: `refs/heads/${branch}`, sha: commit.data.sha },
      });
    } else {
      await api(`/repos/${encOwner}/${encRepo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        token,
        method: "PATCH",
        body: { sha: commit.data.sha },
      });
    }

    return {
      commit_sha: commit.data.sha,
      tree_sha: tree.data.sha,
      blob_sha: blob.data.sha,
      branch,
      created_branch: createdBranch,
      html_url: commit.data.html_url,
    };
  }

  /** Real pull request. */
  async createPullRequest(owner: string, repo: string, head: string, base: string, title: string, body: string): Promise<PullResult> {
    const token = this.requireToken();
    const { data } = await api<{ number: number; html_url: string; head: { ref: string }; base: { ref: string }; state: string }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      { token, method: "POST", body: { head, base, title, body } },
    );
    return { number: data.number, html_url: data.html_url, head: data.head.ref, base: data.base.ref, state: data.state };
  }

  rateLimit(): RateLimit | null {
    return this.rate;
  }
}
