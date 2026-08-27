import { NexusEngine, openEngine } from "./db";
import {
  SecurityExecutionService,
  SecurityEvidenceService,
  SecurityFindingService,
  RiskCorrelationService,
  SecurityDecisionService,
} from "./security-services";
import { SecurityPolicyEngine } from "./security-policy";
import {
  SecurityExecution,
  SecurityEvidence,
  SecurityFinding,
  FindingStatus,
  RiskAssessment,
  SecurityDecision,
} from "./types";

export class SecurityApi {
  private engine: NexusEngine;
  private executionService: SecurityExecutionService;
  private evidenceService: SecurityEvidenceService;
  public findingService: SecurityFindingService;
  private riskService: RiskCorrelationService;
  private decisionService: SecurityDecisionService;
  private policyEngine: SecurityPolicyEngine;

  constructor(engine: NexusEngine) {
    this.engine = engine;
    this.executionService = new SecurityExecutionService(engine);
    this.evidenceService = new SecurityEvidenceService(engine);
    this.findingService = new SecurityFindingService(engine);
    this.riskService = new RiskCorrelationService(engine);
    this.decisionService = new SecurityDecisionService(engine);
    this.policyEngine = new SecurityPolicyEngine();
  }

  static async create(engine?: NexusEngine): Promise<SecurityApi> {
    const e = engine ?? (await openEngine());
    return new SecurityApi(e);
  }

  async startExecution(
    projectId: string,
    executionId: string,
    commitSha: string,
    artifactDigest?: string,
    releaseId?: string
  ): Promise<SecurityExecution> {
    return this.executionService.start(projectId, executionId, commitSha, artifactDigest, releaseId);
  }

  async completeExecution(
    executionId: string,
    verdict: "PASS" | "FAIL" | "BLOCKED",
    status: "SUCCEEDED" | "FAILED" | "BLOCKED" | "CANCELLED"
  ): Promise<SecurityExecution> {
    return this.executionService.complete(executionId, verdict, status);
  }

  async ingestEvidence(evidence: Omit<SecurityEvidence, "id" | "created_at">): Promise<SecurityEvidence> {
    return this.evidenceService.persistEvidence(evidence);
  }

  async ingestFindings(evidence: SecurityEvidence, rawFindings: Partial<SecurityFinding>[]): Promise<SecurityFinding[]> {
    return this.findingService.ingestFindings(evidence, rawFindings);
  }

  async transitionFinding(
    findingId: string,
    newStatus: FindingStatus,
    reason?: string,
    metadata?: {
      false_positive_evidence?: string;
      approved_by?: string;
      approved_at?: string;
      expires_at?: string;
      scope?: string;
    }
  ): Promise<SecurityFinding> {
    return this.findingService.transition(findingId, newStatus, "system", reason, metadata);
  }

  async assessRisk(executionId: string): Promise<RiskAssessment> {
    await this.findingService.revertExpiredAcceptedRisks();
    return this.riskService.assess(executionId);
  }

  async recordDecision(decision: Omit<SecurityDecision, "id" | "created_at">): Promise<SecurityDecision> {
    return this.decisionService.recordDecision(decision);
  }

  async evaluatePolicy(
    execution: SecurityExecution,
    evidenceList: SecurityEvidence[],
    findings: SecurityFinding[],
    risk?: RiskAssessment
  ): Promise<SecurityDecision> {
    const decision = this.policyEngine.evaluate(execution, evidenceList, findings, risk);
    await this.decisionService.recordDecision(decision);
    return decision;
  }

  async getEvidence(executionId: string): Promise<SecurityEvidence[]> {
    return this.evidenceService.getByExecution(executionId);
  }

  async getFindings(executionId: string): Promise<SecurityFinding[]> {
    return this.findingService.getByExecution(executionId);
  }

  async getRisk(executionId: string): Promise<RiskAssessment[]> {
    return this.engine.byIndex<RiskAssessment>("security_risk_assessments", "byExecution", executionId);
  }

  async getDecisions(executionId: string): Promise<SecurityDecision[]> {
    return this.decisionService.getByExecution(executionId);
  }
}