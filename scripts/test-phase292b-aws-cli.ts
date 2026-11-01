import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createAwsRunner } from "../src/core/aws-cli";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  killed = 0;
  throwOnKill = false;

  kill(): boolean {
    this.killed++;
    if (this.throwOnKill) throw new Error("simulated kill failure");
    return true;
  }
}

function fakeSpawn(child: FakeChild) {
  return (() => child) as unknown as typeof import("node:child_process").spawn;
}

async function main() {
  let passed = 0;

  function check(name: string, condition: boolean) {
    assert.equal(condition, true, name);
    passed++;
    console.log("PASS:", name);
  }

  // Successful stdout is retained and stderr is always empty.
  {
    const child = new FakeChild();
    const run = createAwsRunner(fakeSpawn(child));
    const pending = run(["secretsmanager", "get-secret-value"]);
    child.stdout.write("secret-json");
    child.emit("close", 0);
    const result = await pending;

    check("successful exit retains stdout", result.stdout === "secret-json");
    check("successful result has no stderr", result.stderr === "");
    check("successful result has no failure", result.failure === undefined);
  }

  // Nonzero process exit is classified without exposing output.
  {
    const child = new FakeChild();
    const run = createAwsRunner(fakeSpawn(child));
    const pending = run(["secretsmanager"]);
    child.stdout.write("sensitive-output");
    child.emit("close", 254);
    const result = await pending;

    check("nonzero exit classified", result.failure === "nonzero_exit");
    check("nonzero exit suppresses stdout", result.stdout === "");
    check("nonzero exit code retained", result.exitCode === 254);
    check("nonzero exit suppresses stderr", result.stderr === "");
  }

  // Synchronous spawn exception.
  {
    const run = createAwsRunner((() => {
      throw new Error("sensitive spawn detail");
    }) as unknown as typeof import("node:child_process").spawn);

    const result = await run(["secretsmanager"]);

    check("synchronous spawn error classified", result.failure === "spawn_error");
    check("spawn error detail not exposed", !JSON.stringify(result).includes("sensitive"));
  }

  // Asynchronous child-process error.
  {
    const child = new FakeChild();
    const run = createAwsRunner(fakeSpawn(child));
    const pending = run(["secretsmanager"]);
    child.emit("error", new Error("sensitive async detail"));
    const result = await pending;

    check("asynchronous spawn error classified", result.failure === "spawn_error");
    check("asynchronous error detail not exposed", !JSON.stringify(result).includes("sensitive"));
  }

  // Timeout must settle even if kill throws.
  {
    const child = new FakeChild();
    child.throwOnKill = true;
    const run = createAwsRunner(fakeSpawn(child));
    const result = await run(["secretsmanager"], 10);

    check("timeout classified", result.failure === "timeout");
    check("timeout exit code", result.exitCode === 124);
    check("timeout attempted termination", child.killed === 1);
  }

  // Output overflow must settle even if kill throws.
  {
    const child = new FakeChild();
    child.throwOnKill = true;
    const run = createAwsRunner(fakeSpawn(child));
    const pending = run(["secretsmanager"]);
    child.stdout.write(Buffer.alloc(256 * 1024 + 1, 0x61));
    const result = await pending;

    check("output overflow classified", result.failure === "output_limit_exceeded");
    check("overflow exit code", result.exitCode === 125);
    check("overflow attempted termination", child.killed === 1);
    check("overflow suppresses captured output", result.stdout === "");
  }

  // Late close after timeout must not alter the settled result.
  {
    const child = new FakeChild();
    const run = createAwsRunner(fakeSpawn(child));
    const pending = run(["secretsmanager"], 10);
    const result = await pending;
    child.emit("close", 0);

    check("late close cannot change timeout result", result.failure === "timeout");
  }

  console.log(`\nAWS CLI runner: PASS (${passed} assertions)`);
}

main().catch((error) => {
  console.error("AWS CLI runner: FAIL");
  console.error(error);
  process.exitCode = 1;
});
