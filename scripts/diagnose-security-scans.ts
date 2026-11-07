import {
  SemgrepAdapter,
  GitleaksAdapter,
  CheckovAdapter,
  ScaAdapter,
} from "../src/core/security-scanners.ts";
import { HostProcessExecutor } from "../src/core/runtime.ts";
import type { HostBridge } from "../src/core/runtime.ts";
import { spawn } from "node:child_process";

const bridge: HostBridge = {
  platform: () => process.platform,
  exec: (command, args, opts) =>
    new Promise((resolve) => {
      console.log("PROCESS START:", command, args.join(" "));

      const resolvedCommands: Record<string, string> = {
        "semgrep.exe":
          "C:\\Users\\pc\\AppData\\Local\\Programs\\Python\\Python314\\Scripts\\semgrep.exe",
        "gitleaks.exe":
          "C:\\Users\\pc\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gitleaks.Gitleaks_Microsoft.Winget.Source_8wekyb3d8bbwe\\gitleaks.exe",
        "npm.cmd":
          "C:\\Program Files\\nodejs\\npm.cmd",
      };

      const resolvedCommand = resolvedCommands[command.toLowerCase()] ?? command;
      const isCmd = /\.(cmd|bat)$/i.test(resolvedCommand);

      const child = isCmd
        ? spawn(
            process.env.ComSpec || "cmd.exe",
            ["/d", "/c", "call", resolvedCommand, ...args],
            {
              cwd: opts.cwd,
              windowsHide: true,
              shell: false,
            }
          )
        : spawn(resolvedCommand, args, {
            cwd: opts.cwd,
            windowsHide: true,
            shell: false,
          });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timeoutMs = opts.timeout_ms ?? 180000;

      const timer = setTimeout(() => {
        if (settled) return;
        console.error("PROCESS TIMEOUT:", command);

        if (child.pid && process.platform === "win32") {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } else {
          child.kill("SIGKILL");
        }

        settled = true;
        resolve({
          exit_code: 124,
          stdout,
          stderr: stderr + "\nDIAGNOSTIC PROCESS TIMEOUT",
        });
      }, timeoutMs);

      child.stdout?.on("data", d => stdout += d.toString());
      child.stderr?.on("data", d => stderr += d.toString());

      child.on("error", err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exit_code: 1, stdout, stderr: stderr + "\n" + String(err) });
      });

      child.on("close", code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.log("PROCESS EXIT:", command, code);
        resolve({ exit_code: code ?? 1, stdout, stderr });
      });
    }),
};

const exec = new HostProcessExecutor(bridge);

const scanners = [
  ["SAST", new SemgrepAdapter(exec)],
  ["SECRET", new GitleaksAdapter(exec)],
  ["IAC", new CheckovAdapter(exec)],
  ["SCA", new ScaAdapter(exec)],
] as const;

for (const [name, scanner] of scanners) {
  console.log(`\n========== ${name}: SCAN START ==========`);

  let outerTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      scanner.scan("."),
      new Promise<never>((_, reject) => {
        outerTimer = setTimeout(
          () => reject(new Error(`${name}: OUTER TIMEOUT after 210 seconds`)),
          210000
        );
      }),
    ]);

    console.log(`${name}: SCAN RESULT`);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`${name}: SCAN ERROR`, error);
  } finally {
    if (outerTimer) clearTimeout(outerTimer);
  }

  console.log(`========== ${name}: SCAN END ==========`);
}



