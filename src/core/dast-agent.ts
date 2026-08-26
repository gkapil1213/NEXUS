import { nid, digestOf } from "./db";

export interface DastFinding {
  id: string;
  fingerprint: string;
  category: "DAST";
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  description: string;
  url: string;
  evidence: string | null;
  remediation: string | null;
  status: "OPEN" | "RESOLVED" | "HUMAN_REVIEW_REQUIRED";
  created_at: number;
}

export interface DastScanResult {
  status: "PASSED" | "FAILED" | "BLOCKED";
  scanner: string;
  findings: DastFinding[];
  blocked_reason: string | null;
  duration_ms: number;
}

const SECURITY_HEADERS: { header: string; title: string; severity: "medium" | "low"; description: string; remediation: string }[] = [
  {
    header: "X-Content-Type-Options",
    title: "Missing X-Content-Type-Options header",
    severity: "medium",
    description: "The X-Content-Type-Options header is missing. It prevents MIME type sniffing.",
    remediation: "Add 'X-Content-Type-Options: nosniff' to server responses.",
  },
  {
    header: "X-Frame-Options",
    title: "Missing X-Frame-Options header",
    severity: "medium",
    description: "The X-Frame-Options header is missing. It helps prevent clickjacking.",
    remediation: "Add 'X-Frame-Options: DENY' or 'SAMEORIGIN'.",
  },
  {
    header: "Content-Security-Policy",
    title: "Missing Content-Security-Policy header",
    severity: "low",
    description: "The Content-Security-Policy header is missing. It mitigates XSS and data injection.",
    remediation: "Define a strict Content-Security-Policy.",
  },
  {
    header: "Strict-Transport-Security",
    title: "Missing Strict-Transport-Security header",
    severity: "low",
    description: "The Strict-Transport-Security header is missing. It enforces HTTPS.",
    remediation: "Add 'Strict-Transport-Security: max-age=31536000; includeSubDomains'.",
  },
];

export class HttpDASTProvider {
  constructor(private targetUrl: string) {}

  private async checkHeaders(url: string): Promise<DastFinding[]> {
    const findings: DastFinding[] = [];
    const response = await fetch(url, { method: "GET", redirect: "manual" });
    for (const sec of SECURITY_HEADERS) {
      if (!response.headers.has(sec.header)) {
        findings.push({
          id: nid("dast"),
          fingerprint: await digestOf(`DAST:${sec.title}:${url}`),
          category: "DAST",
          severity: sec.severity,
          title: sec.title,
          description: sec.description,
          url,
          evidence: `Header '${sec.header}' not present`,
          remediation: sec.remediation,
          status: "OPEN",
          created_at: Date.now(),
        });
      }
    }
    return findings;
  }

  private async checkTraceMethod(url: string): Promise<DastFinding | null> {
    try {
      const res = await fetch(url, { method: "TRACE" });
      if (res.status === 200 || res.status === 405) {
        return {
          id: nid("dast"),
          fingerprint: await digestOf(`DAST:TRACE:${url}`),
          category: "DAST",
          severity: "medium",
          title: "TRACE method may be enabled",
          description: "The TRACE method can be used for Cross-Site Tracing (XST) attacks.",
          url,
          evidence: `TRACE returned status ${res.status}`,
          remediation: "Disable the TRACE method on the server.",
          status: "OPEN",
          created_at: Date.now(),
        };
      }
    } catch {}
    return null;
  }

  private async checkErrorDisclosure(url: string): Promise<DastFinding | null> {
    try {
      const res = await fetch(url + "/nonexistent-page-xyz-123", { method: "GET" });
      const body = await res.text();
      if (/stack trace|Exception in|at .*\(.*\)/i.test(body)) {
        return {
          id: nid("dast"),
          fingerprint: await digestOf(`DAST:ERRORDISCLOSURE:${url}`),
          category: "DAST",
          severity: "high",
          title: "Error information disclosure",
          description: "The application returned a stack trace or detailed error message.",
          url: url + "/nonexistent-page-xyz-123",
          evidence: body.slice(0, 300),
          remediation: "Disable detailed error messages in production.",
          status: "OPEN",
          created_at: Date.now(),
        };
      }
    } catch {}
    return null;
  }

  async scan(): Promise<DastScanResult> {
    const start = Date.now();
    const findings: DastFinding[] = [];

    try {
      const headerFindings = await this.checkHeaders(this.targetUrl);
      findings.push(...headerFindings);

      const traceFinding = await this.checkTraceMethod(this.targetUrl);
      if (traceFinding) findings.push(traceFinding);

      const errorFinding = await this.checkErrorDisclosure(this.targetUrl);
      if (errorFinding) findings.push(errorFinding);

      return {
        status: findings.some((f) => f.severity === "critical" || f.severity === "high") ? "FAILED" : "PASSED",
        scanner: "dast-http",
        findings,
        blocked_reason: null,
        duration_ms: Date.now() - start,
      };
    } catch (e) {
      return {
        status: "BLOCKED",
        scanner: "dast-http",
        findings: [],
        blocked_reason: `DAST request failed: ${(e as Error).message}`,
        duration_ms: Date.now() - start,
      };
    }
  }
}

export class DASTAgent {
  readonly scanner = "dast-http";

  constructor() {}

  async scan(targetUrl: string): Promise<DastScanResult> {
    const provider = new HttpDASTProvider(targetUrl);
    return provider.scan();
  }
}