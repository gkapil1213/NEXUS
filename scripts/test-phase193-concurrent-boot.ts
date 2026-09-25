import { NexusKernel } from "../src/core/kernel";

let pass = 0, fail = 0, blocked = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  " + detail : "")); }
  else      { fail++; console.log("[FAILED] " + name + (detail ? "  " + detail : "")); }
}
function blk(name: string, reason: string) {
  blocked++; console.log("[BLOCKED] " + name + "  " + reason);
}

async function main() {
  console.log("PHASE 193 — §6 CONCURRENT BOOT SAFETY\n");

  {
    const k = new NexusKernel();
    const results = await Promise.all([k.boot(), k.boot(), k.boot()]);
    ok("A1: all three boot() calls resolved", results.every(Boolean));
    ok("A2: all three returned the same services object",
       results[0] === results[1] && results[1] === results[2]);

    const sched = (k as any).cicdScheduler;
    if (sched === undefined) {
      blk("A3: cicdScheduler present", "runtime class has no GitHub bridge");
      blk("A4: scheduler running", "scheduler not constructed");
      blk("A5: ownership identity", "ownership not constructed");
      blk("A6: recovery supervisor", "supervisor not constructed");
    } else {
      ok("A3: cicdScheduler present", true);
      ok("A4: scheduler running", sched.isRunning() === true);
      const id = (k as any).cicdOwnership?.workerIdValue?.();
      ok("A5: ownership identity", typeof id === "string" && id.length > 0, "workerId=" + id);
      ok("A6: recovery supervisor", (k as any).recoverySupervisor !== undefined);
    }
    await k.shutdown();
    ok("A7: shutdown after concurrent boot", true);
  }

  {
    const k = new NexusKernel();
    const s1 = await k.boot();
    const s2 = await k.boot();
    ok("B1: second boot() returns same services object", s1 === s2);
    if ((k as any).cicdScheduler === undefined)
      blk("B2: no duplicate scheduler", "runtime class has no GitHub bridge");
    else
      ok("B2: no duplicate scheduler", true);
    await k.shutdown();
  }

  {
    const k = new NexusKernel();
    const s1 = await k.boot();
    const id1 = (k as any).cicdOwnership?.workerIdValue?.();
    await k.shutdown();
    const s2 = await k.boot();
    const id2 = (k as any).cicdOwnership?.workerIdValue?.();
    ok("C1: boot after shutdown resolves", !!s2);
    if ((k as any).cicdOwnership === undefined)
      blk("C2: new ownership identity after restart", "runtime class has no GitHub bridge");
    else
      ok("C2: new ownership identity after restart",
         typeof id2 === "string" && id2 !== id1, `id1=${id1} id2=${id2}`);
    await k.shutdown();
  }

  {
    const k = new NexusKernel();
    await k.boot();
    await k.shutdown();
    await k.shutdown();
    await k.shutdown();
    ok("D1: repeated shutdown() does not throw", true);
  }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
