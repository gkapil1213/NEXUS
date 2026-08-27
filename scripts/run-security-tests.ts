import { openEngine } from "../src/core/db";
import { runSecurityTests } from "../src/core/security-tests";

const engine = await openEngine();
const results = await runSecurityTests(engine);
let pass = 0, fail = 0;
console.log("Phase 4 Security Tests\n");
for (const r of results) {
  console.log(`[${r.status}] ${r.name}`);
  if (r.error) console.log(`       Error: ${r.error}`);
  if (r.status === "PASSED") pass++; else fail++;
}
console.log(`\nPASS: ${pass}  FAIL: ${fail}  TOTAL: ${results.length}`);