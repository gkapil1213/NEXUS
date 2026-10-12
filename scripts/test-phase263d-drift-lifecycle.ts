// scripts/test-phase263d-drift-lifecycle.ts
// Phase 263d verifier: drift observer lifecycle — stop() awaits in-flight tick.
//
// DB-free. Exercises only the lifecycle contract added in phase263d:
//   A. stop() must NOT resolve while a tick is in flight
//   B. stop() must resolve immediately when nothing is in flight
//   C. stop() must resolve once the in-flight tick settles
//   D. no-overlap: a second runNow() during an in-flight tick is skipped
//
// Uses a deferred gate inside observer.observe() to hold a tick open on demand.

import {
  DriftObservationSupervisor,
  type DriftObservationScope,
  type DriftObservationEventSink,
} from "../src/core/drift-observation-supervisor";
import type { DeploymentObservation } from "../src/core/post-deployment-integrity";

let passed = 0, failed = 0;
function ok(c: boolean, m: string): void {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string): void { console.log("\n--- " + t + " ---"); }

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class NullEvents implements DriftObservationEventSink {
  async emit(): Promise<unknown> { return undefined; }
}

function observation(overrides: Partial<DeploymentObservation> = {}): DeploymentObservation {
  return {
    available: true,
    status: "OBSERVED",
    observed_at: new Date().toISOString(),
    observed_digest: "sha256:test",
    observed_release_id: "rel-263d",
    observed_artifact_id: "art-263d",
    ...overrides,
  } as DeploymentObservation;
}

interface Deps {
  gate?: { promise: Promise<void> };
  observedIds?: string[];
  scopes?: DriftObservationScope[];
}

function buildSupervisor(deps: Deps = {}): DriftObservationSupervisor {
  const scopes: DriftObservationScope[] = deps.scopes ?? [
    { projectId: "p263d", environment: "prod" },
  ];
  return new DriftObservationSupervisor({
    incidentStore: {} as any,
    history: {
      getCurrentDeployment: async () => ({
        id: "dep-263d",
        project_id: "p263d",
        environment: "prod",
        status: "KNOWN_GOOD",
        release_id: "rel-263d",
        artifact_id: "art-263d",
        image_digest: "sha256:test",
      }),
    } as any,
    observer: {
      observe: async (id: string) => {
        deps.observedIds?.push(id);
        if (deps.gate) await deps.gate.promise;
        return observation();
      },
    } as any,
    workerId: "p263d-worker",
    intervalMs: 60_000,
    maxScopesPerTick: 100,
    enumerateScopes: async () => scopes,
    svc: { events: new NullEvents() } as any,
  } as any);
}

async function main() {
  // ---- A: stop() does NOT resolve while a tick is in flight ----------
  section("A - stop() awaits an in-flight tick");
  {
    const gate = deferred<void>();
    const observedIds: string[] = [];
    const sup = buildSupervisor({ gate, observedIds });

    const tickPromise = sup.runNow();
    await new Promise((r) => setTimeout(r, 20));
    ok(observedIds.length === 1, "A1 observer.observe() entered exactly once");

    let stopResolved = false;
    const stopPromise = sup.stop().then(() => { stopResolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    ok(!stopResolved, "A2 stop() did NOT resolve while tick in flight");

    gate.resolve();
    await tickPromise;
    await stopPromise;
    ok(stopResolved, "A3 stop() resolved after tick settled");
    ok(sup.status().running === false, "A4 status().running is false after stop");
  }

  // ---- B: stop() with nothing in flight resolves immediately ---------
  section("B - stop() with no in-flight tick resolves immediately");
  {
    const sup = buildSupervisor();
    const t0 = Date.now();
    await sup.stop();
    const dt = Date.now() - t0;
    ok(dt < 100, "B1 stop() with nothing in flight resolved in <100ms (took " + dt + "ms)");
  }

  // ---- C: stop() is idempotent ---------------------------------------
  section("C - stop() is idempotent");
  {
    const sup = buildSupervisor();
    await sup.stop();
    await sup.stop();
    ok(true, "C1 two consecutive stop() calls do not throw");
  }

  // ---- D: no-overlap guard -------------------------------------------
  section("D - no-overlap: second runNow() during an in-flight tick is skipped");
  {
    const gate = deferred<void>();
    const sup = buildSupervisor({ gate });

    const first = sup.runNow();
    await new Promise((r) => setTimeout(r, 20));

    const skippedBefore = sup.status().skippedTicks;
    const second = await sup.runNow();
    const skippedAfter = sup.status().skippedTicks;
    ok(skippedAfter === skippedBefore + 1, "D1 skippedTicks incremented by 1");
    ok(second !== null && typeof second === "object", "D2 skipped runNow returned a report");

    gate.resolve();
    await first;
    const totalTicks = sup.status().totalTicks;
    ok(totalTicks === 1, "D3 exactly one tick completed (totalTicks=" + totalTicks + ")");
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});