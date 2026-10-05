// src/core/node-host-bridge.ts
//
// Phase 250: shared Node HostBridge.
//
// Extracted verbatim from scripts/run-canonical-deployment-e2e.ts (which
// proved the pattern) so that both the canonical E2E and the Phase 250
// live A21 test can inject the same real host execution boundary.
//
// Security behavior is preserved exactly:
//   - workspace-token validation (TOKEN_RE)
//   - workspace isolation (cwd must be inside session root)
//   - allowlist enforcement delegated to HostProcessExecutor via runtime.ts
//   - no shell:true, no free-form argument strings
//   - timeout handling, exit-code passthrough
//   - deterministic cleanup

import path from "node:path";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import type { HostBridge } from "./runtime";

export function createNodeBridge(rootDir: string): HostBridge {
  const sessions = new Map<string, string>();
  const TOKEN_RE = /^[A-Za-z0-9_-]{4,128}$/;
  return {
    platform: () => process.platform,
    async materializeWorkspace(req) {
      if (!TOKEN_RE.test(req.token)) throw new Error("invalid token");
      if (sessions.has(req.token)) throw new Error("already materialized");
      await fsp.mkdir(rootDir, { recursive: true });
      const dir = await fsp.mkdtemp(path.join(rootDir, req.token.slice(0, 12) + "-"));
      const realRoot = await fsp.realpath(dir);
      for (const f of req.files) {
        if (f.path.includes("..") || path.isAbsolute(f.path)) throw new Error("unsafe path");
        const dest = path.join(realRoot, f.path);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, f.content, "utf8");
      }
      sessions.set(req.token, realRoot);
      return { cwd: realRoot, files_written: req.files.length };
    },
    async cleanupWorkspace(token) {
      const dir = sessions.get(token);
      if (!dir) return { cleaned: false, error: "unknown" };
      try { await fsp.rm(dir, { recursive: true, force: true }); sessions.delete(token); return { cleaned: true }; }
      catch (e) { return { cleaned: false, error: (e as Error).message }; }
    },
    async exec(command, args, opts) {
      const token = opts?.workspace_token;
      if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new Error("workspace_token required");
      const sessionRoot = sessions.get(token);
      if (!sessionRoot) throw new Error("unknown workspace session");
      let cwd = sessionRoot;
      if (opts.cwd) {
        const real = await fsp.realpath(path.resolve(sessionRoot, opts.cwd)).catch(() => null);
        if (!real) throw new Error("cwd does not exist");
        if (real !== sessionRoot && !real.startsWith(sessionRoot + path.sep)) throw new Error("cwd outside session");
        cwd = real;
      }
      const isCmd = /\.(cmd|bat)$/i.test(command);
      const useCmd = process.platform === "win32" && isCmd;
      const finalCmd = useCmd ? "cmd.exe" : command;
      const finalArgs = useCmd ? ["/c", command, ...args] : args;
      return await new Promise((resolve) => {
        const child = spawn(finalCmd, finalArgs, { cwd, shell: false, windowsHide: true, env: process.env });
        let stdout = "", stderr = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeout_ms ?? 300_000);
        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        child.on("error", (e) => { clearTimeout(timer); resolve({ exit_code: 127, stdout, stderr: stderr + e.message }); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ exit_code: timedOut ? 124 : (code ?? 1), stdout, stderr }); });
      });
    },
  } as HostBridge;
}