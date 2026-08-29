import {
  SecurityPostureService,
  ScannerHealthService,
  SecurityEvidenceIntegrityService,
  ContinuousSecurityVerificationService,
  SecurityDriftService,
  SecurityPolicyHistoryService,
  SecurityRiskHistoryService,
  SecurityHeartbeatService,
} from "./security-operations";
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
  // Existing services
  private engine: NexusEngine;
  private executionService: SecurityExecutionService;
  private evidenceService: SecurityEvidenceService;
  public findingService: SecurityFindingService; // public for tests and external access
  private riskService: RiskCorrelationService;
  private decisionService: SecurityDecisionService;
  private policyEngine: SecurityPolicyEngine;

  // Phase 4 Pass 7 – Continuous Security Operations
  private postureService: SecurityPostureService;
  private scannerHealthService: ScannerHealthService;
  private evidenceIntegrityService: SecurityEvidenceIntegrityService;
  private continuousVerificationService: ContinuousSecurityVerificationService;
  private driftService: SecurityDriftService;
  private policyHistoryService: SecurityPolicyHistoryService;
  private riskHistoryService: SecurityRiskHistoryService;
  private heartbeatService: SecurityHeartbeatService;

  constructor(engine: NexusEngine) {
    this.engine = engine;
    this.executionService = new SecurityExecutionService(engine);
    this.evidenceService = new SecurityEvidenceService(engine);
    this.findingService = new SecurityFindingService(engine);
    this.riskService = new RiskCorrelationService(engine);
    this.decisionService = new SecurityDecisionService(engine);
    this.policyEngine = new SecurityPolicyEngine();

    this.postureService = new SecurityPostureService(engine);
    this.scannerHealthService = new ScannerHealthService(engine);
    this.evidenceIntegrityService = new SecurityEvidenceIntegrityService(engine);
    this.continuousVerificationService = new ContinuousSecurityVerificationService(engine);
    this.driftService = new SecurityDriftService(engine);
    this.policyHistoryService = new SecurityPolicyHistoryService(engine);
    this.riskHistoryService = new SecurityRiskHistoryService(engine);
    this.heartbeatService = new SecurityHeartbeatService(engine);
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

  // Phase 4 Pass 7 – Continuous Security Operations
  async getProjectPosture(projectId: string) {
    return this.postureService.getProjectPosture(projectId);
  }

  async updateScannerHealth(scanner: string, data: any) {
    return this.scannerHealthService.updateHealth(scanner, data);
  }

  async listScannerHealth() {
    return this.scannerHealthService.listHealth();
  }

  async verifyEvidenceIntegrity(id: string, content: string) {
    return this.evidenceIntegrityService.verifyEvidence(id, content);
  }

  async verifyCommitBinding(projectId: string, commitSha: string, artifactDigest?: string) {
    return this.continuousVerificationService.verifyBinding(projectId, commitSha, artifactDigest);
  }

  async detectDrift(expectedDigest: string, actualDigest: string, projectId?: string) {
    return this.driftService.detectArtifactDrift(expectedDigest, actualDigest, projectId);
  }

  async recordPolicyEvaluation(record: any) {
    return this.policyHistoryService.recordEvaluation(record);
  }

  async getPolicyHistory(executionId?: string, releaseId?: string) {
    return this.policyHistoryService.getHistory(executionId, releaseId);
  }

  async snapshotRisk(projectId: string, executionId: string, risk: RiskAssessment) {
    return this.riskHistoryService.snapshot(projectId, executionId, risk);
  }

  async getRiskHistory(projectId: string) {
    return this.riskHistoryService.getHistory(projectId);
  }

  async securityHeartbeat() {
    return this.heartbeatService.check();
  }
}