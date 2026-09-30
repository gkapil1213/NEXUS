// scripts/host-bridge-node.ts
// Shared Node-side implementation of HostBridge (src/core/runtime.ts).
// Same contract the browser host satisfies via window.__NEXUS_HOST__.
// Extracted from the pattern already used by:
//   scripts/run-canonical-deployment-e2e.ts
//   scripts/run-docker-engineering-e2e.ts
//   scripts/test-phase191-deployment-execution.ts
//
// Not a parallel architecture: a faithful Node implementation of the
// same HostBridge interface (real filesystem, real process spawn).

import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { HostBridge } from "../src/core/runtime";

const TOKEN_RE = /^[A-Za-z0-9_-]{4,128}$/;

export interface NodeBridge extends HostBridge {
  _sessions: Map<string, string>;
}

export function createNodeBridge(rootDir: string): NodeBridge {
  const sessions = new Map<string, string>();
  return {
    _sessions: sessions,
    platform: () => process.platform,
    async materializeWorkspace(req) {
      if (!TOKEN_RE.test(req.token)) throw new Error("invalid token format");
      if (sessions.has(req.token)) throw new Error("session already materialized");
      await fsp.mkdir(rootDir, { recursive: true });
      const dir = await fsp.mkdtemp(path.join(rootDir, req.token.slice(0, 12) + "-"));
      const realRoot = await fsp.realpath(dir);
      for (const f of req.files) {
        if (f.path.includes("..") || path.isAbsolute(f.path)) throw new Error("unsafe path: " + f.path);
        const dest = path.join(realRoot, f.path);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const realParent = await fsp.realpath(path.dirname(dest));
        if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
          throw new Error("path escapes workspace: " + f.path);
        }
        await fsp.writeFile(dest, f.content, "utf8");
      }
      sessions.set(req.token, realRoot);
      return { cwd: realRoot, files_written: req.files.length };
    },
    async cleanupWorkspace(token) {
      const dir = sessions.get(token);
      if (!dir) return { cleaned: false, error: "unknown workspace session" };
      try { await fsp.rm(dir, { recursive: true, force: true }); sessions.delete(token); return { cleaned: true }; }
      catch (e) { return { cleaned: false, error: (e as Error).message }; }
    },
    async exec(command, args, opts) {
      const token = opts?.workspace_token;
      if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new Error("workspace_token required and must be valid");
      const sessionRoot = sessions.get(token);
      if (!sessionRoot) throw new Error("unknown workspace session");
      let cwd = sessionRoot;
      if (opts.cwd !== undefined && opts.cwd !== null && opts.cwd !== "") {
        const candidate = path.resolve(sessionRoot, opts.cwd);
        const real = await fsp.realpath(candidate).catch(() => null);
        if (!real) throw new Error("cwd does not exist");
        if (real !== sessionRoot && !real.startsWith(sessionRoot + path.sep)) throw new Error("cwd outside session boundary");
        cwd = real;
      }
      const isCmd = /\.(cmd|bat)$/i.test(command);
      const useShell = process.platform === "win32" && isCmd;
      return new Promise((resolve) => {
        const child = spawn(command, args, {
          cwd,
          shell: useShell,
          timeout: opts?.timeout_ms ?? 60_000,
        });
        let stdout = "", stderr = "";
        child.stdout?.on("data", (d) => (stdout += d.toString()));
        child.stderr?.on("data", (d) => (stderr += d.toString()));
        child.on("error", (e) => resolve({ exit_code: -1, stdout, stderr: stderr + String(e) }));
        child.on("close", (code) => resolve({ exit_code: code ?? -1, stdout, stderr }));
      });
    },
  };
}
