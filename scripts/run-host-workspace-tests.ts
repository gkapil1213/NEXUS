import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { prepareHostWorkspace, cleanupHostWorkspace, hasHostMaterialization } from "../src/core/host-workspace";
import { createRuntimeCommandExecutor } from "../src/core/runtime-command-adapter";
import { resolveExecutable, RuntimeBridge, TokenBoundExecutor } from "../src/core/runtime";
import type { HostBridge, ProcessExecutor, AllowedTool } from "../src/core/runtime";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`[PASSED] ${name}${detail ? "  Evidence: " + detail : ""}`); }
  else { fail++; console.log(`[FAILED] ${name}${detail ? "  Evidence: " + detail : ""}`); }
}

function mockWorkspaceService(files: { path: string; content: string }[]) {
  return {
    async listFiles(_actor: any, _id: string) {
      return files.map((f, i) => ({
        id: `wsf_${i}`, workspace_id: "ws_test", path: f.path,
        content: f.content, size: f.content.length,
        created_at: Date.now(), updated_at: Date.now(),
      }));
    },
  } as any;
}

function fakeActor() {
  return { id: "u1", email: "t@nexus.local", role: "OWNER", status: "ACTIVE" } as any;
}

function recordingBridge(): HostBridge & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    platform: () => process.platform,
    async exec(command, args, opts) {
      calls.push({ kind: "exec", command, args, opts });
      return { exit_code: 0, stdout: "mock-stdout", stderr: "" };
    },
    async materializeWorkspace(req) {
      calls.push({ kind: "materialize", token: req.token, files: req.files });
      return { cwd: `/mock/tmp/${req.token}`, files_written: req.files.length };
    },
    async cleanupWorkspace(token) {
      calls.push({ kind: "cleanup", token });
      return { cleaned: true };
    },
  };
}


function bridgeExecutor(bridge: HostBridge): ProcessExecutor {
  return {
    capability: () => ({ available: true, kind: "EXTERNAL_HOST_RUNTIME", reason: null }),
    async run(cmd: any) {
      const exe = resolveExecutable(process.platform, cmd.tool as AllowedTool);
      const r = await bridge.exec(exe, cmd.args ?? [], { cwd: cmd.cwd, workspace_token: cmd.workspace_token });
      return { exit_code: r.exit_code, stdout: r.stdout, stderr: r.stderr };
    },
  } as unknown as ProcessExecutor;
}

(async () => {
  console.log("NEXUS HOST-WORKSPACE MATERIALIZATION & EXECUTION TESTS");
  console.log("=====================================================\n");
  const actor = fakeActor();

  // A. Materialization
  {
    const bridge = recordingBridge();
    const ws = mockWorkspaceService([
      { path: "package.json", content: "{}" },
      { path: "src/index.js", content: "x" },
      { path: "src/nested/deep.js", content: "y" },
    ]);
    const res = await prepareHostWorkspace({ workspaces: ws, bridge }, actor, "ws_test");
    const mcall = bridge.calls.find((c) => c.kind === "materialize");
    check("A1 nested safe paths materialize", res.status === "READY" && mcall?.files.length === 3, `files=${mcall?.files.length ?? 0}`);
  }
  {
    const bridge = recordingBridge();
    const ws = mockWorkspaceService([{ path: "a.js", content: "a" }]);
    const res = await prepareHostWorkspace({ workspaces: ws, bridge }, actor, "ws_test");
    const mcall = bridge.calls.find((c) => c.kind === "materialize");
    check("A2 only the workspace's files materialized, no extras", res.status === "READY" && mcall?.files.length === 1 && mcall.files[0].path === "a.js", "1 file");
  }
  {
    const bridge = recordingBridge();
    const ws = mockWorkspaceService([{ path: "../evil.txt", content: "x" }]);
    const res = await prepareHostWorkspace({ workspaces: ws, bridge }, actor, "ws_test");
    check("A3 traversal path rejected before materialization", res.status === "BLOCKED" && bridge.calls.every((c) => c.kind !== "materialize"), res.status === "BLOCKED" ? res.reason.slice(0, 60) : "not blocked");
  }
  {
    const bridge = recordingBridge();
    const ws = mockWorkspaceService([{ path: "/etc/passwd", content: "x" }]);
    const res = await prepareHostWorkspace({ workspaces: ws, bridge }, actor, "ws_test");
    check("A4 absolute path rejected", res.status === "BLOCKED", res.status === "BLOCKED" ? res.reason.slice(0, 60) : "not blocked");
  }
  {
    const ws = mockWorkspaceService([]);
    const res = await prepareHostWorkspace({ workspaces: ws, bridge: null }, actor, "ws_test");
    check("A5 no bridge → BLOCKED with reason", res.status === "BLOCKED" && /no host bridge/i.test(res.reason), res.status === "BLOCKED" ? res.reason.slice(0, 60) : "not blocked");
  }
  {
    const badBridge = { platform: () => "linux", exec: async () => ({ exit_code: 0, stdout: "", stderr: "" }) } as HostBridge;
    const ws = mockWorkspaceService([]);
    const res = await prepareHostWorkspace({ workspaces: ws, bridge: badBridge }, actor, "ws_test");
    check("A6 bridge without materialization → BLOCKED", res.status === "BLOCKED" && /does not implement/i.test(res.reason), res.status === "BLOCKED" ? res.reason.slice(0, 60) : "not blocked");
  }

  // B. cwd wiring through a controlled bridge (records exec args, no real spawn)
  {
    const bridge = recordingBridge();
    const ws = mockWorkspaceService([
      { path: "package.json", content: "{}" },
      { path: "src/index.js", content: "console.log(1)" },
    ]);
    const prepared = await prepareHostWorkspace({ workspaces: ws, bridge }, actor, "ws_test");
    if (prepared.status !== "READY") {
      check("B1 materialization returns a cwd from the bridge", false, prepared.reason);
    } else {
      const repo = process.cwd();
      const adapter = createRuntimeCommandExecutor(bridgeExecutor(bridge));
      await adapter.exec("npm test", prepared.cwd, { workspace_token: prepared.token });
      const ecall = bridge.calls.find((c) => c.kind === "exec");
      check("B1 exec receives the materialized cwd", ecall?.opts?.cwd === prepared.cwd, `cwd=${ecall?.opts?.cwd}`);
      check("B2 exec receives the materialized workspace token", ecall?.opts?.workspace_token === prepared.token, `token=${ecall?.opts?.workspace_token}`);
      check("B2 cwd is NOT \".\" and NOT the NEXUS repo", ecall?.opts?.cwd !== "." && ecall?.opts?.cwd !== repo, `repo=${repo}`);
      const cleanup = await cleanupHostWorkspace({ workspaces: ws, bridge }, prepared.token);
      check("B3 cleanup reports cleaned=true", cleanup.cleaned === true);
    }
  }

  // C. cwd wiring through the adapter (recorded, no real spawn)
  {
    const bridge = recordingBridge();
    const ws = mockWorkspaceService([{ path: "x.js", content: "x" }]);
    const adapter = createRuntimeCommandExecutor(bridgeExecutor(bridge));
    const prepared = await prepareHostWorkspace({ workspaces: ws, bridge }, actor, "ws_test");
    if (prepared.status !== "READY") {
      check("C1 adapter exec uses materialized cwd", false, prepared.reason);
    } else {
      await adapter.exec("npm test", prepared.cwd, { workspace_token: prepared.token });
      const ecall = bridge.calls.find((c) => c.kind === "exec");
      check("C1 adapter exec uses materialized cwd (NOT '.')", ecall?.opts?.cwd === prepared.cwd && ecall.opts.cwd !== ".", `cwd=${ecall?.opts?.cwd}`);
    }
  }

  // D. Non-zero exit preserved (via adapter)
  {
    const bridge = recordingBridge();
    bridge.exec = async (command, args, opts) => {
      (bridge.calls as any[]).push({ kind: "exec", command, args, opts });
      return { exit_code: 2, stdout: "", stderr: "boom" };
    };
    const ws = mockWorkspaceService([{ path: "y.js", content: "y" }]);
    const adapter = createRuntimeCommandExecutor(bridgeExecutor(bridge));
    const prepared = await prepareHostWorkspace({ workspaces: ws, bridge }, actor, "ws_test");
    if (prepared.status !== "READY") {
      check("D1 non-zero exit preserved", false, prepared.reason);
    } else {
      const r = await adapter.exec("npm test", prepared.cwd, { workspace_token: prepared.token });
      check("D1 non-zero exit preserved verbatim", r.exit_code === 2 && r.stderr === "boom", "exit=2");
    }
  }

  // E. Failure truth
  {
    const bridge = recordingBridge();
    bridge.cleanupWorkspace = async () => ({ cleaned: false, error: "sandbox denied" });
    const ws = mockWorkspaceService([{ path: "z.js", content: "z" }]);
    const prepared = await prepareHostWorkspace({ workspaces: ws, bridge }, actor, "ws_test");
    const cleanup = await cleanupHostWorkspace({ workspaces: ws, bridge }, prepared.status === "READY" ? prepared.token : "tkn");
    check("E1 cleanup failure observable and honest", cleanup.cleaned === false && /sandbox denied/.test(cleanup.error ?? ""), `error="${cleanup.error}"`);
  }
  {
    const badBridge = { platform: () => "linux", exec: async () => ({ exit_code: 0, stdout: "", stderr: "" }) } as HostBridge;
    check("E2 hasHostMaterialization false without methods", hasHostMaterialization(badBridge) === false);
    check("E3 hasHostMaterialization true for full bridge", hasHostMaterialization(recordingBridge()) === true);
  }

  // F. Runtime capability probes are workspace-token bound
  {
    const bridge = recordingBridge();
    const rb = new RuntimeBridge({ events: { emit: async () => {} }, audit: { record: async () => {} } } as any, bridgeExecutor(bridge), bridge);
    await rb.detect();
    const execs = bridge.calls.filter((c: any) => c.kind === 'exec');
    const ok = execs.length > 0 && execs.every((c: any) => typeof c.opts?.workspace_token === 'string' && c.opts.workspace_token.length > 0);
    check('F1 every runtime probe exec carries a workspace_token', ok, execs.length + ' probe execs');
  }
  {
    const inner = { capability: () => ({ available: true, kind: 'EXTERNAL_HOST_RUNTIME', reason: null }), run: async (cmd: any) => ({ exit_code: 0, stdout: JSON.stringify(cmd), stderr: '' }) } as unknown as ProcessExecutor;
    const tbe = new TokenBoundExecutor(inner, 'tok_A');
    const r1 = await tbe.run({ tool: 'node', operation: '--version', args: [] } as any);
    const p1 = JSON.parse(r1.stdout);
    check('F2 TokenBoundExecutor injects token when absent', p1.workspace_token === 'tok_A', 'token=' + p1.workspace_token);
    const r2 = await tbe.run({ tool: 'node', operation: '--version', args: [], workspace_token: 'tok_B' } as any);
    const p2 = JSON.parse(r2.stdout);
    check('F3 TokenBoundExecutor preserves explicit token', p2.workspace_token === 'tok_B', 'token=' + p2.workspace_token);
  }
  {
    const bridge = recordingBridge();
    const rb = new RuntimeBridge({ events: { emit: async () => {} }, audit: { record: async () => {} } } as any, bridgeExecutor(bridge), bridge);
    await rb.detect();
    const mc = bridge.calls.find((c: any) => c.kind === 'materialize');
    const ok = !!mc && /^[A-Za-z0-9_-]{4,128}$/.test(mc.token) && Array.isArray(mc.files) && mc.files.length > 0;
    check('F4 probe materialization uses valid token + at least one file', ok, 'token=' + (mc?.token?.slice(0, 20)) + ' files=' + (mc?.files?.length));
  }
  {
    const bridge = recordingBridge();
    bridge.exec = async (command: string, args: string[], opts: any) => {
      bridge.calls.push({ kind: 'exec', command, args, opts });
      if (/docker/i.test(command)) throw new Error('synthetic docker probe failure');
      return { exit_code: 0, stdout: 'v1.0.0', stderr: '' };
    };
    const rb = new RuntimeBridge({ events: { emit: async () => {} }, audit: { record: async () => {} } } as any, bridgeExecutor(bridge), bridge);
    try { await rb.detect(); } catch {}
    const cc = bridge.calls.find((c: any) => c.kind === 'cleanup');
    check('F5 probe-workspace cleanup runs even when a probe errors', !!cc, 'cleaned=' + !!cc);
  }
  {
    const bridge = recordingBridge();
    bridge.materializeWorkspace = async (req: any) => { bridge.calls.push({ kind: 'materialize', token: req.token, files: req.files }); throw new Error('materialize denied by test'); };
    const rb = new RuntimeBridge({ events: { emit: async () => {} }, audit: { record: async () => {} } } as any, bridgeExecutor(bridge), bridge);
    const status = await rb.detect();
    const execs = bridge.calls.filter((c: any) => c.kind === 'exec');
    check('F6 materialization failure -> BLOCKED, no tokenless probe attempted', status.processExecution === 'BLOCKED' && execs.length === 0, 'status=' + status.processExecution + ' execs=' + execs.length);
  }
  {
    const browserExec = { capability: () => ({ available: false, kind: 'MANAGED_BROWSER_RUNTIME', reason: 'no host bridge' }), run: async () => { throw new Error('browser must not run'); } } as unknown as ProcessExecutor;
    const rb = new RuntimeBridge({ events: { emit: async () => {} }, audit: { record: async () => {} } } as any, browserExec, null);
    const status = await rb.detect();
    check('F7 managed-browser runtime reports BLOCKED', status.processExecution === 'BLOCKED', 'processExecution=' + status.processExecution);
  }
  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();

export function run() { /* wrapper compat */ }
