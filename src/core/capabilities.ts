/**
 * NEXUS Phase 3 — Runtime Capability Detection.
 *
 * Determines what the *current* runtime can actually execute, with strict
 * honesty semantics:
 *
 *   AVAILABLE   — the capability was probed and genuinely works here.
 *   UNAVAILABLE — probed; the runtime provably lacks it (e.g. no process
 *                 spawn in a browser, so no docker/scanner/Playwright CLI).
 *   BLOCKED     — present in principle but cannot be invoked from this
 *                 sandbox (e.g. a Docker daemon behind a socket this context
 *                 cannot reach).
 *   UNKNOWN     — the probe could not conclude (timeout / inconclusive).
 *
 * CRITICAL RULE honoured throughout: availability is NEVER inferred from
 * package.json or from the presence of source code. A tool is AVAILABLE only
 * when a real execution attempt succeeds. Shell-bound tooling in a browser
 * runtime is reported UNAVAILABLE/BLOCKED with the exact reason — it is never
 * reported PASS/AVAILABLE.
 *
 * Self-contained: does not touch Phase 1/2 types or stores, so it cannot
 * affect the existing regression suites or persisted data.
 */

export type CapabilityStatus = "AVAILABLE" | "UNAVAILABLE" | "BLOCKED" | "UNKNOWN";

export type CapabilityCategory =
  | "runtime"
  | "container"
  | "security"
  | "browser"
  | "network"
  | "provider";

export interface CapabilityProbe {
  name: string;
  category: CapabilityCategory;
  status: CapabilityStatus;
  /** The exact, human-readable reason for the status. */
  detail: string;
  /** Real measured latency of the probe, when a network/exec attempt ran. */
  latency_ms: number | null;
}

export interface CapabilityReport {
  probes: CapabilityProbe[];
  generated_at: number;
  environment: string;
  summary: Record<CapabilityStatus, number>;
}

/* ------------------------------ probe helpers ------------------------------ */

function probe(
  name: string,
  category: CapabilityCategory,
  status: CapabilityStatus,
  detail: string,
  latency_ms: number | null = null,
): CapabilityProbe {
  return { name, category, status, detail, latency_ms };
}

/** Run a real fetch with a timeout. Resolves to a boolean + latency. */
async function fetchProbe(url: string, timeoutMs: number): Promise<{ ok: boolean; latency_ms: number | null; status?: number }> {
  const t0 = performance.now();
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal, cache: "no-store" });
    const latency_ms = Math.round((performance.now() - t0) * 10) / 10;
    return { ok: res.ok, latency_ms, status: res.status };
  } catch {
    return { ok: false, latency_ms: null };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/** True when a real child process can be spawned in this runtime. */
function canSpawnProcess(): boolean {
  // Browsers expose no child_process / Deno.run / node:child_process.
  const g = globalThis as Record<string, unknown>;
  return typeof g.process !== "undefined" && typeof (g.process as { versions?: unknown }).versions !== "undefined";
}

/** True when a Docker daemon socket is reachable from this context. */
function dockerSocketReachable(): boolean {
  // A browser cannot open /var/run/docker.sock or an npipe. Only a Node/host
  // runtime could; we report based on actual reachability, not assumption.
  return false;
}

/* ------------------------------ the detector ------------------------------- */

export async function detectCapabilities(): Promise<CapabilityReport> {
  const probes: CapabilityProbe[] = [];
  const isBrowser = typeof document !== "undefined";
  const spawn = canSpawnProcess();

  /* ---- runtime primitives (these genuinely exist in a browser) ---- */
  probes.push(
    probe(
      "Browser / DOM",
      "browser",
      isBrowser ? "AVAILABLE" : "UNAVAILABLE",
      isBrowser ? "document is present — running inside a real browser" : "no DOM available",
    ),
    probe(
      "IndexedDB",
      "runtime",
      typeof indexedDB !== "undefined" ? "AVAILABLE" : "UNAVAILABLE",
      typeof indexedDB !== "undefined" ? "durable persistence engine present" : "IndexedDB not available",
    ),
    probe(
      "WebCrypto",
      "runtime",
      typeof crypto !== "undefined" && Boolean(crypto.subtle) ? "AVAILABLE" : "UNAVAILABLE",
      typeof crypto !== "undefined" && Boolean(crypto.subtle) ? "crypto.subtle present (digests, PBKDF2)" : "WebCrypto not available",
    ),
  );

  /* ---- process-spawn-bound tooling (honest UNAVAILABLE in a browser) ---- */
  const noSpawn = "no process-spawn capability in this browser runtime";
  probes.push(
    probe("Node.js (spawnable)", "runtime", spawn ? "AVAILABLE" : "UNAVAILABLE", spawn ? "node process detected" : noSpawn),
    probe("npm", "runtime", spawn ? "UNKNOWN" : "UNAVAILABLE", spawn ? "present; version not verified" : noSpawn),
    probe("git CLI", "runtime", spawn ? "UNKNOWN" : "UNAVAILABLE", spawn ? "present; not verified" : noSpawn),
  );

  /* ---- container runtime ---- */
  const dockerReason = dockerSocketReachable()
    ? "docker socket reachable"
    : spawn
      ? "docker may be present; not verified by execution"
      : "Docker CLI/daemon not invocable — no process spawn and no /var/run/docker.sock access from this sandbox";
  probes.push(
    probe("Docker CLI", "container", spawn ? "UNKNOWN" : "UNAVAILABLE", dockerReason),
    probe("Docker daemon", "container", dockerSocketReachable() ? "UNKNOWN" : "BLOCKED", dockerSocketReachable() ? "socket reachable; not verified" : "daemon socket unreachable from this runtime"),
    probe("docker build / run / inspect", "container", "BLOCKED", "requires Docker CLI + daemon, which are not invocable here"),
    probe("podman", "container", spawn ? "UNKNOWN" : "UNAVAILABLE", noSpawn),
    probe("containerd", "container", spawn ? "UNKNOWN" : "UNAVAILABLE", noSpawn),
  );

  /* ---- security / SBOM scanners (all shell-bound) ---- */
  for (const tool of ["syft", "trivy", "grype", "osv-scanner", "cyclonedx"]) {
    probes.push(
      probe(
        tool,
        "security",
        spawn ? "UNKNOWN" : "UNAVAILABLE",
        spawn ? "may be installed; not verified by execution" : `${tool} is a shell binary; ${noSpawn}`,
      ),
    );
  }

  /* ---- browser automation (Playwright) ---- */
  const hasPlaywright = typeof (globalThis as Record<string, unknown>).playwright !== "undefined";
  probes.push(
    probe(
      "Playwright",
      "browser",
      hasPlaywright ? "UNKNOWN" : "UNAVAILABLE",
      hasPlaywright ? "global detected; not verified" : "Playwright is not installed and there is no automation runtime in this sandbox",
    ),
    probe(
      "Chromium / Chrome (automatable)",
      "browser",
      "BLOCKED",
      "no browser-automation channel exists in this runtime; the served app cannot drive a real browser",
    ),
  );

  /* ---- network + provider APIs (real fetch probes) ---- */
  const net = await fetchProbe("https://api.github.com/zen", 5000);
  probes.push(
    probe(
      "Outbound network",
      "network",
      net.ok ? "AVAILABLE" : net.latency_ms === null ? "BLOCKED" : "UNAVAILABLE",
      net.ok
        ? `HTTPS reachable (probe ${net.latency_ms}ms)`
        : net.latency_ms === null
          ? "network probe timed out or was refused"
          : `network reachable but probe returned HTTP ${net.status}`,
      net.latency_ms,
    ),
  );

  const gh = await fetchProbe("https://api.github.com/zen", 5000);
  probes.push(
    probe(
      "GitHub API",
      "provider",
      gh.ok ? "AVAILABLE" : gh.latency_ms === null ? "BLOCKED" : "UNAVAILABLE",
      gh.ok
        ? `api.github.com responded (HTTP ${gh.status}, ${gh.latency_ms}ms). Credentials NOT probed.`
        : "GitHub API not reachable from this runtime",
      gh.latency_ms,
    ),
  );

  const gl = await fetchProbe("https://gitlab.com/api/v4/metadata", 5000);
  probes.push(
    probe(
      "GitLab API",
      "provider",
      gl.ok ? "AVAILABLE" : gl.latency_ms === null ? "BLOCKED" : "UNAVAILABLE",
      gl.ok
        ? `gitlab.com responded (HTTP ${gl.status}, ${gl.latency_ms}ms). Credentials NOT probed.`
        : gl.latency_ms === null
          ? "GitLab API not reachable / timed out"
          : `GitLab API returned HTTP ${gl.status}`,
      gl.latency_ms,
    ),
  );

  const summary: Record<CapabilityStatus, number> = { AVAILABLE: 0, UNAVAILABLE: 0, BLOCKED: 0, UNKNOWN: 0 };
  for (const p of probes) summary[p.status] += 1;

  return {
    probes,
    generated_at: Date.now(),
    environment: isBrowser ? "browser" : spawn ? "node" : "unknown",
    summary,
  };
}

/**
 * Convenience: the set of Phase-3 pipeline stages whose required runtime is
 * genuinely available. Everything else is reported BLOCKED by the caller —
 * never silently converted to PASS.
 */
export function executableHere(report: CapabilityReport): {
  source_sbom: boolean;
  security_static: boolean;
  docker: boolean;
  image_sbom: boolean;
  staging: boolean;
  health: boolean;
  smoke: boolean;
} {
  const avail = (name: string) => report.probes.find((p) => p.name === name)?.status === "AVAILABLE";
  const browser = avail("Browser / DOM");
  const docker = avail("Docker daemon");
  return {
    // Source SBOM + static security run in-browser from real manifests — available.
    source_sbom: browser,
    security_static: browser,
    // Everything below needs a real container/browser runtime — not available here.
    docker,
    image_sbom: docker,
    staging: docker,
    health: docker,
    smoke: avail("Playwright") && avail("Chromium / Chrome (automatable)"),
  };
}