// src/core/verification-manifest.ts
// Phase 209: deterministic required-test manifests per phase. A missing
// required test must surface as NOT_EXECUTED, never disappear.

import type { Manifest } from "./verification-integrity";

export const PHASE_207: Manifest = {
  phase: 207,
  suite: "production-scheduler",
  testScript: "scripts/test-phase207-production-scheduler.ts",
  requiredTestIds: [
    "207A","207B","207C","207D","207E","207F","207G","207H","207I","207J",
    "207K","207L","207M","207N","207O","207P","207Q","207R","207S","207T",
  ],
};

export const PHASE_208: Manifest = {
  phase: 208,
  suite: "worker-execution-runtime",
  testScript: "scripts/test-phase208-worker-execution-runtime.ts",
  requiredTestIds: [
    "208A","208B","208C","208D","208E","208F","208G","208H","208I","208J",
    "208K","208L","208M","208N","208O","208P","208Q","208R","208S","208T",
  ],
};

export const PHASE_209: Manifest = {
  phase: 209,
  suite: "verification-integrity",
  testScript: "scripts/test-phase209-verification-integrity.ts",
  requiredTestIds: [
    "209A","209B","209C","209D","209E","209F","209G","209H",
    "209I","209J","209K","209L","209M","209N","209O",
  ],
};

export const PHASE_210: Manifest = {
  phase: 210,
  suite: "release-safety",
  testScript: "scripts/test-phase210-release-safety.ts",
  requiredTestIds: [
    "210A","210B","210C","210D","210E","210F","210G","210H","210I","210J",
    "210K","210L","210M","210N","210O","210P","210Q","210R","210S","210T",
  ],
};
export const PHASE_211: Manifest = {
  phase: 211,
  suite: "release-execution",
  testScript: "scripts/test-phase211-release-execution.ts",
  requiredTestIds: [
    "211A","211B","211C","211D","211E","211F","211G","211H","211I","211J",
    "211K","211L","211M","211N","211O","211P","211Q","211R","211S","211T",
    "211U","211V","211W","211X","211Y","211Z","211AA","211AB","211AC","211AD",
    "211AE","211AF",
  ],
};
export const MANIFESTS: Record<number, Manifest> = {
  207: PHASE_207,
  208: PHASE_208,
  209: PHASE_209,
  210: PHASE_210,
  211: PHASE_211,
};

export function getManifest(phase: number): Manifest {
  const m = MANIFESTS[phase];
  if (!m) throw new Error("No verification manifest registered for phase " + phase);
  return m;
}
