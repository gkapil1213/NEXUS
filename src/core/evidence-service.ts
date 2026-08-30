import { promises as fs } from "node:fs";
import path from "node:path";
import { redactSecrets } from "./redaction";

export interface ScannerEvidence {
  execution_id: string;
  scanner: string;
  scanner_version: string | null;
  status: "PASS" | "FAIL" | "BLOCKED" | "SKIPPED" | "ERROR";
  started_at: string;
  completed_at: string;
  duration_ms: number;
  command_identity: string;
  target: string | null;
  findings: any[]; // should be structured findings
  artifact_references?: {
    artifact_id?: string;
    image_ref?: string;
    image_digest?: string;
    commit_sha?: string;
    release_id?: string;
    signature_identity?: string;
  };
  error_reason?: string | null;
  blocked_reason?: string | null;
  // extra fields allowed
  [key: string]: any;
}

export interface EvidenceRecord {
  capabilities?: any[];
  configuration_checks?: any[];
  scanner_executions?: ScannerEvidence[];
  release_decisions?: any[];
  failure_injection?: any[];
  regression_results?: any[];
  generated_at: string;
}

export class EvidenceService {
  private evidenceFilePath = path.join(process.cwd(), "phase4-pass9-evidence.json");

  constructor(filePath?: string) {
    if (filePath) this.evidenceFilePath = filePath;
  }

  private sanitize<T>(obj: T): T {
    const json = JSON.stringify(obj);
    const sanitized = redactSecrets(json);
    return JSON.parse(sanitized);
  }

  async writeEvidence(data: EvidenceRecord): Promise<void> {
    const sanitized = this.sanitize(data);
    await fs.writeFile(this.evidenceFilePath, JSON.stringify(sanitized, null, 2), "utf-8");
  }

  async readEvidence(): Promise<EvidenceRecord | null> {
    try {
      const content = await fs.readFile(this.evidenceFilePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
}

export const evidenceService = new EvidenceService();