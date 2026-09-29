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
export const PHASE_212: Manifest = {
  phase: 212,
  suite: "release-recovery",
  testScript: "scripts/test-phase212-release-recovery.ts",
  requiredTestIds: [
    "212A","212B","212C","212D","212E","212F","212G","212H","212I","212J",
    "212K","212L","212M","212N","212O","212P","212Q","212R","212S","212T",
    "212U","212V","212W","212X","212Y","212Z","212AA","212AB","212AC","212AD",
    "212AE","212AF",
  ],
};
export const PHASE_213: Manifest = {
  phase: 213,
  suite: "lifecycle-integrity",
  testScript: "scripts/test-phase213-lifecycle-integrity.ts",
  requiredTestIds: [
    "213A","213B","213C","213D","213E","213F","213G","213H",
    "213I","213J","213K","213L","213M","213N","213O",
  ],
};
export const PHASE_214: Manifest = {
  phase: 214,
  suite: "engineering-run",
  testScript: "scripts/test-phase214-engineering-run.ts",
  requiredTestIds: [
    "214A","214B","214C","214D","214E","214F","214G","214H","214I","214J",
    "214K","214L","214M","214N","214O","214P","214Q","214R","214S","214T",
    "214U","214V","214W","214X","214Y","214Z",
  ],
};
export const PHASE_215: Manifest = {
  phase: 215,
  suite: "planning-architecture",
  testScript: "scripts/test-phase215-planning-architecture.ts",
  requiredTestIds: [
    "215A","215B","215C","215D","215E","215F","215G","215H","215I","215J",
    "215K","215L","215M","215N","215O","215P","215Q","215R","215S","215T",
    "215U","215V","215W","215X","215Y","215Z",
  ],
};
export const PHASE_216: Manifest = {
  phase: 216,
  suite: "ai-provider",
  testScript: "scripts/test-phase216-ai-provider.ts",
  requiredTestIds: [
    "216A","216B","216C","216D","216E","216F","216G","216H","216I","216J",
    "216K","216L","216M","216N","216O","216P","216Q","216R","216S","216T",
    "216U","216V","216W","216X","216Y","216Z",
  ],
};
export const PHASE_217: Manifest = {
  phase: 217,
  suite: "implementation-execution",
  testScript: "scripts/test-phase217-implementation.ts",
  requiredTestIds: [
    "217A","217B","217C","217D","217E","217F","217G","217H","217I","217J",
    "217K","217L","217M","217N","217O","217P","217Q","217R","217S","217T",
    "217U","217V","217W","217X","217Y","217Z",
  ],
};
export const PHASE_218: Manifest = {
  phase: 218,
  suite: "engineering-stage-execution",
  testScript: "scripts/test-phase218-stage-execution.ts",
  requiredTestIds: [
    "218A","218B","218C","218D","218E","218F","218G","218H","218I","218J",
    "218K","218L","218M","218N","218O","218P",
    "218Q","218R","218S","218T","218U","218V","218W","218X","218Y","218Z",
  ],
};

export const PHASE_219: Manifest = {
  phase: 219,
  suite: "engineering-build-stage-execution",
  testScript: "scripts/test-phase219-build-stage-execution.ts",
  requiredTestIds: [
    "219A","219B","219C","219D","219E","219F","219G","219H","219I","219J",
    "219K","219L","219M","219N","219O","219P","219Q","219R","219S","219T",
    "219U",
  ],
};

export const MANIFESTS: Record<number, Manifest> = {
  207: PHASE_207,
  208: PHASE_208,
  209: PHASE_209,
  210: PHASE_210,
  211: PHASE_211,
  212: PHASE_212,
  213: PHASE_213,
  214: PHASE_214,
  215: PHASE_215,
   216: PHASE_216,
   217: PHASE_217,
  218: PHASE_218,
  219: PHASE_219,
};

export function getManifest(phase: number): Manifest {
  const m = MANIFESTS[phase];
  if (!m) throw new Error("No verification manifest registered for phase " + phase);
  return m;
}
