import { RealSecurityScanner } from "../src/core/security-scanners.ts";
import { HostProcessExecutor } from "../src/core/runtime.ts";
import type { HostBridge } from "../src/core/runtime.ts";
import { spawn } from "node:child_process";

const bridge: HostBridge = {
  platform: () => process.platform,
  exec: (command, args, opts) =>
    new Promise((resolve) => {
      console.log("EXEC START:", command, args.join(" "));
      const child = spawn(command, args, {
        cwd: opts.cwd,
        windowsHide: true,
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve({
          exit_code: 124,
          stdout,
          stderr: stderr + "\nDIAGNOSTIC TIMEOUT",
        });
      }, 15000);

      child.stdout.on("data", d => stdout += d.toString());
      child.stderr.on("data", d => stderr += d.toString());
      child.on("error", err => {
        clearTimeout(timer);
        resolve({ exit_code: 1, stdout, stderr: String(err) });
      });
      child.on("close", code => {
        clearTimeout(timer);
        resolve({ exit_code: code ?? 1, stdout, stderr });
      });
    }),
};

const scanner = new RealSecurityScanner(new HostProcessExecutor(bridge));

for (const [name, adapter] of [
  ["SAST", (scanner as any).semgrep],
  ["SECRET", (scanner as any).gitleaks],
  ["IAC", (scanner as any).checkov],
  ["SCA", (scanner as any).sca],
]) {
  console.log("\nDETECT START:", name);
  try {
    const result = await Promise.race([
      adapter.detect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("DETECT TIMEOUT: " + name)), 20000)
      ),
    ]);
    console.log("DETECT RESULT:", name, JSON.stringify(result));
  } catch (error) {
    console.error("DETECT ERROR:", name, error);
  }
}
