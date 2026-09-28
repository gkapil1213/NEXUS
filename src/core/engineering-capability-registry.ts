// src/core/engineering-capability-registry.ts
// Phase 214: durable answer to "can NEXUS actually execute this engineering
// stage in the current runtime?" Pure lookup + optional runtime probe. Never
// returns AVAILABLE for a stage whose real executor is not wired.

import type { AIProviderGateway } from "./ai-provider-gateway";

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

export interface AIGatewayProbeConfig {
  gateway: AIProviderGateway;
  /** Provider id in the gateway used for PLANNING. */
  planningProviderId: string;
  /** Provider id in the gateway used for ARCHITECTURE. */
  architectureProviderId: string;
  /** Provider id in the gateway used for IMPLEMENTATION (Phase 217, optional). */
  implementationProviderId?: string;
}

export class EngineeringCapabilityRegistry {
  constructor(
    private readonly probe?: RuntimeProbe,
    private readonly aiProbe?: AIGatewayProbeConfig,
  ) {}

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

  /**
   * Phase 216: async sibling. When a gateway is wired via the constructor,
   * PLANNING and ARCHITECTURE consult a real runtime probe against the
   * configured provider. Without a gateway the async result equals the
   * static result (honest NOT_IMPLEMENTED).
   *
   * Never reports AVAILABLE merely because an API key exists â€” the probe
   * performs a real HTTP request.
   */
  async evaluateAsync(stageType: EngineeringStageType): Promise<CapabilityVerdict> {
    const base = this.evaluate(stageType);

    if (!this.aiProbe) return base;

    if (stageType === "PLANNING" || stageType === "ARCHITECTURE" || stageType === "IMPLEMENTATION") {
      const targetId =
        stageType === "PLANNING"        ? this.aiProbe.planningProviderId :
        stageType === "ARCHITECTURE"    ? this.aiProbe.architectureProviderId :
        /* IMPLEMENTATION */              this.aiProbe.implementationProviderId;
      if (!targetId) {
        // No implementation provider id configured - stay honest with the
        // static base (NOT_IMPLEMENTED) rather than reporting UNAVAILABLE.
        return base;
      }
      // If the gateway has no provider registered, report UNAVAILABLE with
      // a specific reason (integration exists, config does not).
      if (!this.aiProbe.gateway.hasProvider(targetId)) {
        return {
          stageType,
          status: "UNAVAILABLE",
          reason: "PROVIDER_NOT_CONFIGURED",
          dependencies: base.dependencies,
        };
      }
      const probeResult = await this.aiProbe.gateway.probe(targetId);
      if (probeResult.status === "AVAILABLE") {
        return {
          stageType,
          status: "AVAILABLE",
          reason: probeResult.reason,
          dependencies: base.dependencies,
        };
      }
      return {
        stageType,
        status: "UNAVAILABLE",
        reason: probeResult.reason,
        dependencies: base.dependencies,
      };
    }

    // Other stages have no AI gateway wiring in this phase.
    return base;
  }

  async evaluateAllAsync(): Promise<CapabilityVerdict[]> {
    const out: CapabilityVerdict[] = [];
    for (const s of CANONICAL_ENGINEERING_DAG) {
      out.push(await this.evaluateAsync(s.stageType));
    }
    return out;
  }
}
