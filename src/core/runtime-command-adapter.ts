// src/core/runtime-command-adapter.ts
//
// Bridges devops.CommandExecutor (string in) to runtime.ProcessExecutor
// (AllowlistedCommand in). Spawns nothing, uses no shell, and validates every
// candidate (tool, operation) pair against the existing runtime TOOL_OPERATIONS
// table before delegating. Unrepresentable commands throw EXECUTOR_BLOCKED so
// the caller records BLOCKED — never a fabricated SUCCESS.

import { ProcessExecutor, TOOL_OPERATIONS, AllowlistedCommand } from "./runtime";
import type { CommandExecutor } from "./devops";

const SAFE_TOKEN = /^[A-Za-z0-9_./=:@+\-]+$/;

type Candidate = { tool: string; operation: string; args: string[] };

function tokenize(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (const t of tokens) if (!SAFE_TOKEN.test(t)) return null;
  return tokens;
}

function candidatesFor(tokens: string[]): Candidate[] {
  const [tool, sub, ...rest] = tokens;
  if (!tool) return [];

  // node-style tools: node, python, python3 — sub is the script path or -c/-m
  if (tool === "node" || tool === "python" || tool === "python3") {
    return sub ? [{ tool, operation: "run", args: [sub, ...rest] }] : [];
  }

  // package managers
  if (tool === "npm" || tool === "pnpm" || tool === "yarn") {
    if (sub === "install") return [
      { tool, operation: "install", args: rest },
      { tool, operation: "ci", args: rest },
    ];
    if (sub === "ci") return [{ tool, operation: "ci", args: rest }];
    if (sub === "test") return [{ tool, operation: "test", args: rest }];
    if (sub === "run" && rest.length > 0) return [{ tool, operation: "run", args: rest }];
    // yarn build / yarn test shorthand
    if (sub && !sub.startsWith("-")) return [{ tool, operation: "run", args: [sub, ...rest] }];
    return [];
  }

  if (tool === "pytest") return [{ tool, operation: "run", args: [sub, ...rest].filter(Boolean) as string[] }];
  if (tool === "pip")     return sub ? [{ tool, operation: sub, args: rest }] : [];
  if (tool === "npx")     return sub ? [{ tool, operation: "run", args: [sub, ...rest] }] : [];
  if (tool === "tsc" || tool === "vite" || tool === "next" || tool === "go" ||
      tool === "cargo" || tool === "mvn" || tool === "docker") {
    return [{ tool, operation: "run", args: [sub, ...rest].filter(Boolean) as string[] }];
  }
  return [];
}

function resolve(tokens: string[]): AllowlistedCommand | null {
  const table = TOOL_OPERATIONS as unknown as Record<string, readonly string[] | undefined>;
  for (const c of candidatesFor(tokens)) {
    const ops = table[c.tool];
    if (ops && ops.includes(c.operation)) {
      return { tool: c.tool as AllowlistedCommand["tool"], operation: c.operation, args: c.args };
    }
  }
  return null;
}

export function createRuntimeCommandExecutor(runtime: ProcessExecutor): CommandExecutor {
  return {
    async exec(command: string, cwd: string, opts?: { workspace_token?: string }) {
      const tokens = tokenize(command);
      const resolved = tokens ? resolve(tokens) : null;
      if (!resolved) {
        const err = new Error(
          `EXECUTOR_BLOCKED: '${command}' is not representable as an allowlisted runtime tool/operation`,
        );
        (err as Error & { code?: string }).code = "EXECUTOR_BLOCKED";
        throw err;
      }
      const r = await runtime.run({ ...resolved, cwd, workspace_token: opts?.workspace_token });
      return { exit_code: r.exit_code, stdout: r.stdout, stderr: r.stderr };
    },
  };
}
