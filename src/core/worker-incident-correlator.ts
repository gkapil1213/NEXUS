export type CorrelationType =
  | "INDEPENDENT"
  | "RELATED"
  | "CASCADING"
  | "SHARED_ROOT_CAUSE"
  | "CROSS_DOMAIN"
  | "UNKNOWN";

export class WorkerIncidentCorrelator {
  correlate(
    a: { incidentId: string; domain: string; rootCause?: string },
    b: { incidentId: string; domain: string; rootCause?: string }
  ): CorrelationType {
    if (!a || !b) return "UNKNOWN";

    const aEmpty = !a.incidentId && !a.domain && !a.rootCause;
    const bEmpty = !b.incidentId && !b.domain && !b.rootCause;
    if (aEmpty || bEmpty) return "UNKNOWN";

    if (a.rootCause && a.rootCause === b.rootCause) return "SHARED_ROOT_CAUSE";
    if (a.domain === b.domain) return "RELATED";
    if (a.incidentId === b.incidentId) return "CASCADING";
    return "INDEPENDENT";
  }
}
