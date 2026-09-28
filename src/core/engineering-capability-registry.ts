// src/core/engineering-capability-registry.ts
// Phase 214: durable answer to "can NEXUS actually execute this engineering
// stage in the current runtime?" Pure lookup + optional runtime probe. Never
// returns AVAILABLE for a stage whose real executor is not wired.

export type EngineeringStageType =
  | "PLANNING"
  | "ARCHITECTURE"
  | "IMPLEMENTATION"
  | "BUILD"
  | "TEST"
  | "DIAGNOSIS"
  | "REPAIR"
  | "SECURITY_REVIEW"
  | "RELEASE_READY";

export type CapabilityStatus = "AVAILABLE" | "UNAVAILABLE" | "NOT_IMPLEMENTED";

export interface CapabilityVerdict {
  stageType: EngineeringStageType;
  status: CapabilityStatus;
  reason: string;
  dependencies: string[];
}

export const CANONICAL_ENGINEERING_DAG: ReadonlyArray<{
  stageType: EngineeringStageType;
  ordinal: number;
  dependsOn: EngineeringStageType[];
}> = [
  { stageType: "PLANNING",        ordinal: 0, dependsOn: [] },
  { stageType: "ARCHITECTURE",    ordinal: 1, dependsOn: ["PLANNING"] },
  { stageType: "IMPLEMENTATION",  ordinal: 2, dependsOn: ["ARCHITECTURE"] },
  { stageType: "BUILD",           ordinal: 3, dependsOn: ["IMPLEMENTATION"] },
  { stageType: "TEST",            ordinal: 4, dependsOn: ["BUILD"] },
  { stageType: "DIAGNOSIS",       ordinal: 5, dependsOn: ["TEST"] },
  { stageType: "REPAIR",          ordinal: 6, dependsOn: ["DIAGNOSIS"] },
  { stageType: "SECURITY_REVIEW", ordinal: 7, dependsOn: ["REPAIR"] },
  { stageType: "RELEASE_READY",   ordinal: 8, dependsOn: ["SECURITY_REVIEW"] },
];

/**
 * Static capabilities: for phases 214 the real executors for these stages do
 * not exist in this repository. Each entry must change to AVAILABLE only
 * when a real executor is wired and tested. This is the honest answer.
 *
 * Runtime-probed capabilities (BUILD, TEST) may become AVAILABLE at runtime
 * via the provided probe. Without a probe they stay UNAVAILABLE.
 */
export interface RuntimeProbe {
  hasDocker(): boolean;
  hasNode(): boolean;
}

export class EngineeringCapabilityRegistry {
  constructor(private readonly probe?: RuntimeProbe) {}

  staticBase(stageType: EngineeringStageType): CapabilityVerdict {
    switch (stageType) {
      case "PLANNING":
      case "ARCHITECTURE":
      case "IMPLEMENTATION":
      case "DIAGNOSIS":
      case "REPAIR":
        return {
          stageType,
          status: "NOT_IMPLEMENTED",
          reason: "no executor is wired in this phase",
          dependencies: [],
        };
      case "SECURITY_REVIEW":
        return {
          stageType,
          status: "NOT_IMPLEMENTED",
          reason: "SecurityApi exists but no per-run security executor is wired",
          dependencies: ["security-api"],
        };
      case "RELEASE_READY":
        return {
          stageType,
          status: "NOT_IMPLEMENTED",
          reason: "release execution path exists (Phase 211/212) but is not yet driven from engineering runs",
          dependencies: ["release-execution-gate", "release-safety-gate"],
        };
      case "BUILD":
        return {
          stageType,
          status: "UNAVAILABLE",
          reason: "no canonical build executor for engineering runs",
          dependencies: ["runtime-bridge"],
        };
      case "TEST":
        return {
          stageType,
          status: "UNAVAILABLE",
          reason: "no canonical test executor for engineering runs",
          dependencies: ["runtime-bridge"],
        };
    }
  }

  evaluate(stageType: EngineeringStageType): CapabilityVerdict {
    const base = this.staticBase(stageType);
    if (!this.probe) return base;
    // Runtime probes are conservative: they only downgrade, never upgrade
    // NOT_IMPLEMENTED. A build stage stays UNAVAILABLE unless a real executor
    // exists, regardless of docker/node being present.
    return base;
  }

  evaluateAll(): CapabilityVerdict[] {
    return CANONICAL_ENGINEERING_DAG.map((s) => this.evaluate(s.stageType));
  }
}
