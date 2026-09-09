import { ExecutionAdapter, ExecutionAdapterRequest, ExecutionAdapterResult, ExecutionAdapterContext } from "./execution-adapter";
import { spawn } from "child_process";

export class LocalProcessExecutionAdapter implements ExecutionAdapter {
    getId(): string { return "local-process"; }
    getType(): string { return "local"; }
    getCapabilities(): string[] { return ["process.exec", "shell.cmd"]; }

    validate(request: ExecutionAdapterRequest): { valid: boolean; errors: string[] } {
        if (!request.operation || typeof request.operation !== "string") {
            return { valid: false, errors: ["operation must be a non-empty string"] };
        }
        if (!request.args || !Array.isArray(request.args)) {
            return { valid: false, errors: ["args must be an array"] };
        }
        return { valid: true, errors: [] };
    }

    async execute(request: ExecutionAdapterRequest, context?: ExecutionAdapterContext): Promise<ExecutionAdapterResult> {
        return new Promise((resolve) => {
            const cmd = request.operation;
            const args = request.args || [];
            const options = {
                cwd: request.cwd || process.cwd(),
                env: { ...process.env, ...request.env },
                timeout: request.timeoutMs || 30000,
            };
            const child = spawn(cmd, args, options);
            let stdout = "";
            let stderr = "";
            let timedOut = false;

            const timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
            }, options.timeout);

            child.stdout.on("data", (data) => stdout += data.toString());
            child.stderr.on("data", (data) => stderr += data.toString());

            child.on("error", (err) => {
                clearTimeout(timer);
                resolve({
                    success: false,
                    exitCode: -1,
                    stdout,
                    stderr: stderr + err.message,
                    evidence: { error: err.message },
                });
            });

            child.on("close", (code) => {
                clearTimeout(timer);
                if (timedOut) {
                    resolve({
                        success: false,
                        exitCode: code === null ? undefined : code,
                        stdout,
                        stderr: stderr + "\n[Execution timed out]",
                        evidence: { timedOut: true },
                    });
                } else {
                    resolve({
                        success: code === 0,
                        exitCode: code === null ? undefined : code,
                        stdout,
                        stderr,
                        evidence: {},
                    });
                }
            });
        });
    }

    async cancel(executionId?: string): Promise<void> {
        throw new Error("Cancellation not supported for LocalProcessExecutionAdapter");
    }

    async healthCheck(): Promise<boolean> {
        try {
            await this.execute({ operation: "node", args: ["-e", "process.exit(0)"] });
            return true;
        } catch {
            return false;
        }
    }
}
