import { ObservabilityService } from "./observability-service";
import { Incident } from "./observability-types";

export interface IncidentAnalysis {
  incidentId: string;
  classification: "APPLICATION" | "DATABASE" | "NETWORK" | "DEPENDENCY" | "DEPLOYMENT" | "SECURITY" | "RESOURCE" | "CONFIGURATION" | "UNKNOWN";
  confidence: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  summary: string;
  evidence: string[];
  uncertainties: string[];
}

export class IncidentAnalysisService {
  constructor(private observability: ObservabilityService) {}

  async analyze(incident: Incident): Promise<IncidentAnalysis> {
    const healths = await this.observability.listHealthChecks(20);
    const observations = await this.observability.listObservations(50);
    const relevantHealth = healths.filter((h) => h.target === incident.service);
    const recentFailures = relevantHealth.filter((h) => h.status !== "HEALTHY");
    const evidence: string[] = [
      ...recentFailures.map((h) => `${h.target} ${h.status} at ${h.timestamp}`),
      ...observations.slice(-5).map((o) => `${o.metric} = ${o.value}`),
    ];

    let classification: IncidentAnalysis["classification"] = "UNKNOWN";
    let confidence: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN" = "UNKNOWN";
    let summary = "Insufficient evidence to determine root cause.";

    if (recentFailures.length > 0) {
      classification = "APPLICATION";
      summary = `Service ${incident.service} is failing health checks.`;
      confidence = evidence.length >= 5 ? "HIGH" : evidence.length >= 2 ? "MEDIUM" : "LOW";
    } else if (observations.some((o) => o.metric === "cpu_user_microseconds" && o.value > 1_000_000)) {
      classification = "RESOURCE";
      summary = "High CPU usage observed.";
      confidence = "MEDIUM";
    } else if (observations.some((o) => o.metric === "memory_rss_bytes" && o.value > 200 * 1024 * 1024)) {
      classification = "RESOURCE";
      summary = "High memory usage observed.";
      confidence = "MEDIUM";
    }

    return {
      incidentId: incident.id,
      classification,
      confidence,
      summary,
      evidence,
      uncertainties: ["Limited historical data", "No distributed tracing"],
    };
  }
}