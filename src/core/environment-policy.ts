// src/core/environment-policy.ts
//
// Phase 172 - explicit environment policy.
//
// Describes what a given environment requires before a real deployment
// may execute. This is a *description* only; enforcement remains at the
// existing gates (ProductionReleaseEnforcementService, ReleaseDeploymentBridge).
// Policy lives in code (matching Phase 165-171 convention); durable state
// remains in SQL.
//
// Fail-closed: any unrecognized environment name is treated as production.

export type EnvironmentName = "development" | "staging" | "production";

export interface EnvironmentPolicy {
  readonly name: string;
  readonly isProduction: boolean;
  readonly requiresProjectBinding: boolean;
  readonly requiresApproval: boolean;
  readonly requiresImmutableImage: boolean;
  readonly requiresAttemptIdentity: boolean;
  readonly requiresLeaseFencing: boolean;
  readonly requiresProviderAvailability: boolean;
  readonly requiresVerification: boolean;
}

const PRODUCTION_POLICY: EnvironmentPolicy = {
  name: "production",
  isProduction: true,
  requiresProjectBinding: true,
  requiresApproval: true,
  requiresImmutableImage: true,
  requiresAttemptIdentity: true,
  requiresLeaseFencing: true,
  requiresProviderAvailability: true,
  requiresVerification: true,
};

const STAGING_POLICY: EnvironmentPolicy = {
  name: "staging",
  isProduction: false,
  requiresProjectBinding: true,
  requiresApproval: true,
  requiresImmutableImage: true,
  requiresAttemptIdentity: true,
  requiresLeaseFencing: true,
  requiresProviderAvailability: true,
  requiresVerification: true,
};

const DEVELOPMENT_POLICY: EnvironmentPolicy = {
  name: "development",
  isProduction: false,
  requiresProjectBinding: true,
  requiresApproval: false,
  requiresImmutableImage: true,
  requiresAttemptIdentity: true,
  requiresLeaseFencing: true,
  requiresProviderAvailability: true,
  requiresVerification: false,
};

export function isKnownEnvironment(environment: string): boolean {
  return environment === "production" || environment === "staging" || environment === "development";
}

export function policyFor(environment: string): EnvironmentPolicy {
  if (environment === "production") return PRODUCTION_POLICY;
  if (environment === "staging") return STAGING_POLICY;
  if (environment === "development") return DEVELOPMENT_POLICY;
  return { ...PRODUCTION_POLICY, name: environment };
}