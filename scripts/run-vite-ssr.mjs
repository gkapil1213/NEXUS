// Test-only Vite SSR bootstrap.
//
// Purpose: run TS integration tests under Vite's SSR pipeline so that
// import.meta.env.SSR is provided by the runtime that owns it (Vite),
// without modifying production code. No production module imports this file.
//
// Usage: node scripts/run-vite-ssr.mjs <relative-entry.ts>

import { createServer } from "vite";

const entry = process.argv[2];
if (!entry) {
  console.error("usage: node scripts/run-vite-ssr.mjs <entry.ts>");
  process.exit(2);
}

const vite = await createServer({
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  logLevel: "warn",
});

let exitCode = 0;
try {
  const mod = await vite.ssrLoadModule(entry);
  if (mod && typeof mod.run === "function") await mod.run();
  else if (mod && typeof mod.main === "function") await mod.main();
  else throw new Error("entry module does not export run() or main()");
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await vite.close();
}

process.exit(exitCode);