// scripts/_phase194_lease_race_child.ts
// Child of test-phase194-concurrent-lease. Opens the shared on-disk DB,
// attempts exactly one acquireLease for the given worker, prints one
// JSON line to stdout.

import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { LeaseManager } from "../src/core/lease-manager";

const [, , dbPath, workerId] = process.argv;
const JOB = "job_p194_race";

async function main() {
  const engine = await SQLiteEngine.open(dbPath);
  const store = new ExecutionStore(engine.getDatabase(), undefined);
  const leases = new LeaseManager(store);
  try {
    const l = leases.acquireLease(JOB, workerId, 60_000);
    process.stdout.write(JSON.stringify({ workerId, acquired: true, leaseId: l.leaseId }) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ workerId, acquired: false, error: (e as Error).message }) + "\n");
  }
  engine.close();
}
main().catch((e) => {
  process.stdout.write(JSON.stringify({ workerId, fatal: (e as Error).message }) + "\n");
  process.exit(1);
});
