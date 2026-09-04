export type BlastRadiusLevel = "SMALL" | "MEDIUM" | "LARGE" | "CRITICAL" | "INSUFFICIENT";

export class WorkerBlastRadiusOptimizer {
  evaluate(affectedServices: number, affectedDomains: number, dependencyDepth: number, confidence: number): BlastRadiusLevel {
    if (confidence < 0.5) return "INSUFFICIENT";
    if (affectedServices > 50 || affectedDomains > 5 || dependencyDepth > 4) return "CRITICAL";
    if (affectedServices > 20 || affectedDomains > 3 || dependencyDepth > 2) return "LARGE";
    if (affectedServices > 5 || affectedDomains > 1) return "MEDIUM";
    return "SMALL";
  }
}
