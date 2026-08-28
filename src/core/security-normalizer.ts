import {
  FindingSeverity,
  SecurityScannerCategory,
  SecurityEvidenceStatus,
  SecurityFinding,
} from "./types";

export function normalizeSeverity(raw: unknown): FindingSeverity {
  if (typeof raw !== "string" || raw.trim() === "") return "UNKNOWN";
  const s = raw.trim().toLowerCase();
  if (s.includes("critical")) return "CRITICAL";
  if (s.includes("high")) return "HIGH";
  if (s.includes("medium") || s.includes("moderate")) return "MEDIUM";
  if (s.includes("low")) return "LOW";
  if (s.includes("info")) return "INFO";
  return "UNKNOWN";
}

export function fingerprintFinding(input: {
  scanner: string;
  category: SecurityScannerCategory;
  title: string;
  file?: string;
  line?: number;
  cve?: string;
  package?: string;
  resource?: string;
}): string {
  const parts = [
    input.scanner.trim().toLowerCase(),
    input.category,
    input.title.trim().toLowerCase(),
    input.file?.trim().toLowerCase() || "",
    input.line?.toString() || "",
    input.cve?.trim().toLowerCase() || "",
    input.package?.trim().toLowerCase() || "",
    input.resource?.trim().toLowerCase() || "",
  ];
  return parts.join("|");
}

export interface ScannerAdapter {
  normalize(raw: unknown, context: { scanner: string; category: SecurityScannerCategory }): SecurityEvidenceStatus;
  extractFindings?(raw: unknown): Partial<SecurityFinding>[];
}

function rawBlocked(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === "object" && "error" in (raw as any)) return true;
  return false;
}

// ---------- SAST (Semgrep-like) ----------
export const sastAdapter: ScannerAdapter = {
  normalize(raw: any) {
    if (rawBlocked(raw)) return "BLOCKED";
    const results = raw.results;
    if (!Array.isArray(results) || results.length === 0) return "PASS";

    // Only fail on HIGH/CRITICAL findings. Medium/low are warnings.
    const hasHighOrCritical = results.some((r: any) => {
      const sev = normalizeSeverity(r.extra?.severity);
      return sev === "HIGH" || sev === "CRITICAL";
    });

    return hasHighOrCritical ? "FAIL" : "PASS";
  },
  extractFindings(raw: any) {
    if (!raw || !Array.isArray(raw.results)) return [];
    return raw.results.map((r: any) => ({
      title: r.check_id || r.rule || "SAST finding",
      severity: normalizeSeverity(r.extra?.severity),
      file: r.path,
      line: r.start?.line,
      description: r.extra?.message,
    }));
  },
};

// ---------- SCA (npm audit / dependency scan) ----------
export const scaAdapter: ScannerAdapter = {
  normalize(raw: any) {
  if (rawBlocked(raw)) return "BLOCKED";
  if (raw.status === "PASS") return "PASS";
  if (raw.status === "FAIL") return "FAIL";
  if (Array.isArray(raw.vulnerabilities) && raw.vulnerabilities.length > 0) {
    const hasHighOrCritical = raw.vulnerabilities.some((v: any) => {
      const sev = normalizeSeverity(v.severity);
      return sev === "HIGH" || sev === "CRITICAL";
    });
    return hasHighOrCritical ? "FAIL" : "PASS";
  }
  return "PASS";
},
  
  extractFindings(raw: any) {
    if (!raw || !Array.isArray(raw.vulnerabilities)) return [];
    return raw.vulnerabilities.map((v: any) => ({
      title: v.title || v.advisory?.title || "Dependency vulnerability",
      severity: normalizeSeverity(v.severity),
      package: v.package?.name || v.module_name,
      version: v.package?.version || v.version,
      fixed_version: v.first_patched_version || v.fixed_version,
      cve: v.cve || v.advisory?.cve,
      description: v.advisory?.description,
    }));
  },
};

// ---------- Secret Scanner ----------
export const secretAdapter: ScannerAdapter = {
  normalize(raw: any) {
    if (rawBlocked(raw)) return "BLOCKED";
    if (raw.status === "PASS") return "PASS";
    if (Array.isArray(raw.findings) && raw.findings.length > 0) return "FAIL";
    return "PASS";
  },
  extractFindings(raw: any) {
    if (!raw || !Array.isArray(raw.findings)) return [];
    return raw.findings.map((f: any) => ({
      title: f.rule_id || f.type || "Secret detected",
      severity: "HIGH",
      file: f.path,
      line: f.start_line,
      description: `Secret type: ${f.type || "unknown"}`,
    }));
  },
};

// ---------- IaC ----------
export const iacAdapter: ScannerAdapter = {
  normalize(raw: any) {
    if (rawBlocked(raw)) return "BLOCKED";
    if (raw.status === "PASS") return "PASS";
    if (Array.isArray(raw.results) && raw.results.length > 0) return "FAIL";
    return "PASS";
  },
  extractFindings(raw: any) {
    if (!raw || !Array.isArray(raw.results)) return [];
    return raw.results.map((r: any) => ({
      title: r.rule_id || r.title || "IaC misconfiguration",
      severity: normalizeSeverity(r.severity),
      file: r.location?.file,
      line: r.location?.start_line,
      resource: r.resource,
      description: r.description,
      recommendation: r.remediation,
    }));
  },
};

// ---------- Trivy (Container) ----------
export const trivyAdapter: ScannerAdapter = {
  normalize(raw: any) {
    if (rawBlocked(raw)) return "BLOCKED";
    if (Array.isArray(raw.Results)) {
      const hasHighOrCritical = raw.Results.some(
        (r: any) =>
          (r.Vulnerabilities || []).some((v: any) => {
            const sev = normalizeSeverity(v.Severity);
            return sev === "HIGH" || sev === "CRITICAL";
          }) ||
          (r.Misconfigurations || []).some((m: any) => {
            const sev = normalizeSeverity(m.Severity);
            return sev === "HIGH" || sev === "CRITICAL";
          })
      );
      return hasHighOrCritical ? "FAIL" : "PASS";
    }
    return "UNKNOWN";
  },
  extractFindings(raw: any) {
    if (!raw || !Array.isArray(raw.Results)) return [];
    const findings: Partial<SecurityFinding>[] = [];
    for (const result of raw.Results) {
      if (result.Vulnerabilities) {
        for (const v of result.Vulnerabilities) {
          findings.push({
            title: v.Title || "Container vulnerability",
            severity: normalizeSeverity(v.Severity),
            package: v.PkgName,
            version: v.InstalledVersion,
            fixed_version: v.FixedVersion,
            cve: v.VulnerabilityID,
            description: v.Description,
            target: result.Target,
          });
        }
      }
      if (result.Misconfigurations) {
        for (const m of result.Misconfigurations) {
          findings.push({
            title: m.Title || "Container misconfiguration",
            severity: normalizeSeverity(m.Severity),
            resource: m.ID,
            file: m.FilePath,
            line: m.StartLine,
            description: m.Description,
          });
        }
      }
    }
    return findings;
  },
};

// ---------- SBOM (evidence only) ----------
export const sbomAdapter: ScannerAdapter = {
  normalize(raw: any) {
    if (rawBlocked(raw)) return "BLOCKED";
    if (raw.components && raw.components.length > 0) return "PASS";
    if (raw.status === "PASS") return "PASS";
    return "UNKNOWN";
  },
};

// ---------- DAST ----------
export const dastAdapter: ScannerAdapter = {
  normalize(raw: any) {
    if (rawBlocked(raw)) return "BLOCKED";
    if (raw.status === "PASS") return "PASS";
    if (Array.isArray(raw.findings) && raw.findings.length > 0) {
      const hasHighOrCritical = raw.findings.some((f: any) => {
        const sev = normalizeSeverity(f.severity);
        return sev === "HIGH" || sev === "CRITICAL";
      });
      return hasHighOrCritical ? "FAIL" : "PASS";
    }
    return "PASS";
  },
  extractFindings(raw: any) {
    if (!raw || !Array.isArray(raw.findings)) return [];
    return raw.findings.map((f: any) => ({
      title: f.name || "DAST finding",
      severity: normalizeSeverity(f.severity),
      resource: f.url,
      description: f.description,
      cwe: f.cwe,
    }));
  },
};

export const signatureAdapter: ScannerAdapter = {
  normalize(raw, _context) {
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        return "BLOCKED";
      }
    }
    if (!raw || typeof raw !== "object") return "BLOCKED";
    const obj = raw as any;
    if (obj.blocked === true) return "BLOCKED";
    if (obj.signed === true && obj.verified === true) return "PASS";
    if (obj.signed === false) return "FAIL";
    return "BLOCKED";
  },
  extractFindings(_raw) {
    return [];
  },
};

// ---------- Supply Chain ----------
export const supplyChainAdapter: ScannerAdapter = {
  normalize(raw: any) {
    if (rawBlocked(raw)) return "BLOCKED";
    if (raw.status === "PASS") return "PASS";
    if (raw.verified === true) return "PASS";
    if (raw.verified === false) return "FAIL";
    return "UNKNOWN";
  },
  extractFindings(raw: any) {
    if (raw?.mismatches && Array.isArray(raw.mismatches)) {
      return raw.mismatches.map((m: any) => ({
        title: "Supply chain mismatch",
        severity: "HIGH",
        description: m,
      }));
    }
    return [];
  },
};