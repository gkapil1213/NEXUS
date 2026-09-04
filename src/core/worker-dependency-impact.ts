export type DependencyImpactScope = "ISOLATED" | "DIRECT" | "TRANSITIVE" | "CROSS_DOMAIN" | "UNKNOWN";

export class WorkerDependencyImpact {
  evaluate(dependencyDepth: number, sharedDomains: number): DependencyImpactScope {
    if (sharedDomains > 2) return "CROSS_DOMAIN";
    if (dependencyDepth >= 2) return "TRANSITIVE";
    if (dependencyDepth === 1) return "DIRECT";
    if (dependencyDepth === 0 && sharedDomains <= 1) return "ISOLATED";
    return "UNKNOWN";
  }
}
