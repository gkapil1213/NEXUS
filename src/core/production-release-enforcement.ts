import { SecurityApi } from "./security-api";
import type { ExecutionStore, StoredProductionAuthorization } from "./execution-store";
import { SecurityReleaseGate } from "./security-release-gate";
import {
  ProductionReleaseDecisionService,
  ProductionDecisionResult,
  ProductionApproval,
} from "./production-release-decision";

export interface ProductionExecutionAuthorization {
  authorizationId: string;
  releaseId: string;
  artifactId: string;
  commitSha: string;
  environment: string;
  securityDecisionId: string;
  approvalId: string;
  issuedAt: string;
  expiresAt: string;
  consumed: boolean;
  // Phase 138: which attempt consumed this authorization. Same-attempt retries
  // may resume; different-attempt retries are replay.
  consumedByAttemptId?: string | null;
  revoked: boolean;
  // Phase 102: immutable digest bound at authorization time.
  artifactDigest: string;
  // Phase 102: optional deployment context carried forward.
  projectId?: string;
  executionId?: string;
  imageRepository?: string;
  imageTag?: string;
  imageId?: string;
  containerName?: string;
  containerPort?: number;
}

export interface ReleaseRequestParams {
  releaseId: string;
  executionId: string;
  artifactId: string;
  artifactDigest: string;
  commitSha: string;
  environment: string;
  approval: ProductionApproval;
  execution?: any; // optional, passed to gate
  // Phase 102: optional deployment context.
  projectId?: string;
  imageRepository?: string;
  imageTag?: string;
  imageId?: string;
  containerName?: string;
  containerPort?: number;
}

export interface AuthorizationResult {
  status: "AUTHORIZED" | "BLOCKED" | "FAIL";
  authorization?: ProductionExecutionAuthorization;
  blockers: string[];
  reasons: string[];
}

export interface DeploymentResult {
  status: "DEPLOYED" | "BLOCKED" | "FAIL" | "AUTHORIZED" | "EXECUTING" | "VERIFIED";
  message: string;
  providerAvailable: boolean;
  provider?: string;
  deploymentId?: string;
}

/* --- Phase 102: release-execution provider seam --- */

export interface ReleaseExecutionRequest {
  authorizationId: string;
  releaseId: string;
  artifactId: string;
  commitSha: string;
  environment: string;
  projectId: string | null;
  executionId: string | null;
  imageRepository: string | null;
  imageTag: string | null;
  imageId: string | null;
  imageDigest: string;
  containerName: string | null;
  containerPort: number | null;
}

export interface ReleaseExecutionOutcome {
  status: "DEPLOYED" | "FAIL" | "BLOCKED";
  message: string;
  deploymentId?: string | null;
}

export interface ReleaseExecutionProvider {
  execute(req: ReleaseExecutionRequest): Promise<ReleaseExecutionOutcome>;
}

export class ProductionReleaseEnforcementService {
  private authorizations = new Map<string, ProductionExecutionAuthorization>();

  constructor(
    private api: SecurityApi,
    private gate: SecurityReleaseGate,
    private decisionService: ProductionReleaseDecisionService,
    private provider?: ReleaseExecutionProvider,
    private store?: ExecutionStore,
  ) {}

  async requestRelease(params: ReleaseRequestParams): Promise<AuthorizationResult> {
    const blockers: string[] = [];
    const reasons: string[] = [];

    // 1. Evaluate production decision (includes security gate, approval, integrity)
    const decision: ProductionDecisionResult = await this.decisionService.decide({
      releaseId: params.releaseId,
      executionId: params.executionId,
      artifactId: params.artifactId,
      artifactDigest: params.artifactDigest,
      environment: params.environment,
      approval: params.approval,
      execution: params.execution,
    });

    if (decision.status !== "ALLOW") {
      blockers.push(...decision.blockers);
      reasons.push(...decision.blockers);
      return { status: decision.status === "FAIL" ? "FAIL" : "BLOCKED", blockers, reasons };
    }

    // 2. Verify approval matches exactly (defense in depth)
    const approval = params.approval;
    if (
      approval.releaseId !== params.releaseId ||
      approval.artifactId !== params.artifactId ||
      approval.artifactDigest !== params.artifactDigest ||
      approval.environment !== params.environment
    ) {
      blockers.push("Approval does not match release/artifact/digest/environment");
      reasons.push("Approval mismatch");
      return { status: "BLOCKED", blockers, reasons };
    }

    // 3. Issue authorization (short-lived, 5 minutes)
    const authorization: ProductionExecutionAuthorization = {
      authorizationId: `auth_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      releaseId: params.releaseId,
      artifactId: params.artifactId,
      commitSha: params.commitSha,
      environment: params.environment,
      securityDecisionId: decision.releaseId, // use releaseId as decision reference
      approvalId: approval.approvedAt, // we don't have approval id; use timestamp as unique
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      consumed: false,
      revoked: false,
      artifactDigest: params.artifactDigest,
      projectId: params.projectId,
      executionId: params.executionId,
      imageRepository: params.imageRepository,
      imageTag: params.imageTag,
      imageId: params.imageId,
      containerName: params.containerName,
      containerPort: params.containerPort,
    };

    this.authorizations.set(authorization.authorizationId, authorization);
    // Phase 138: mirror to durable store when available. Read path prefers durable.
    this.store?.createProductionAuthorization({
      authorizationId: authorization.authorizationId,
      releaseId: authorization.releaseId,
      artifactId: authorization.artifactId,
      artifactDigest: authorization.artifactDigest,
      commitSha: authorization.commitSha,
      environment: authorization.environment,
      securityDecisionId: authorization.securityDecisionId,
      approvalId: authorization.approvalId,
      executionId: authorization.executionId ?? null,
      projectId: authorization.projectId ?? null,
      imageRepository: authorization.imageRepository ?? null,
      imageTag: authorization.imageTag ?? null,
      imageId: authorization.imageId ?? null,
      containerName: authorization.containerName ?? null,
      containerPort: authorization.containerPort ?? null,
      issuedAt: authorization.issuedAt,
      expiresAt: authorization.expiresAt,
      consumedAt: null,
      consumedByAttemptId: null,
      revokedAt: null,
    });
    return {
      status: "AUTHORIZED",
      authorization,
      blockers: [],
      reasons: [],
    };
  }

    async authorizeExecution(
    authorizationId: string,
    releaseId: string,
    artifactId: string,
    commitSha: string,
    environment: string,
    attemptId: string,
  ): Promise<AuthorizationResult> {
    // Phase 138: prefer durable record when present. Falls back to the in-memory
    // Map only for authorizations issued before the store was wired (legacy path).
    const durable = this.store?.getProductionAuthorization(authorizationId);
    const auth: ProductionExecutionAuthorization | undefined = durable
      ? {
          authorizationId: durable.authorizationId,
          releaseId: durable.releaseId,
          artifactId: durable.artifactId,
          commitSha: durable.commitSha,
          environment: durable.environment,
          securityDecisionId: durable.securityDecisionId,
          approvalId: durable.approvalId,
          issuedAt: durable.issuedAt,
          expiresAt: durable.expiresAt,
          consumed: durable.consumedAt !== null,
          consumedByAttemptId: durable.consumedByAttemptId,
          revoked: durable.revokedAt !== null,
          artifactDigest: durable.artifactDigest,
          projectId: durable.projectId ?? undefined,
          executionId: durable.executionId ?? undefined,
          imageRepository: durable.imageRepository ?? undefined,
          imageTag: durable.imageTag ?? undefined,
          imageId: durable.imageId ?? undefined,
          containerName: durable.containerName ?? undefined,
          containerPort: durable.containerPort ?? undefined,
        }
      : this.authorizations.get(authorizationId);
    if (!auth) {
      return { status: "BLOCKED", blockers: ["Authorization not found"], reasons: ["Authorization not found"] };
    }

    // Check expiration
    if (new Date(auth.expiresAt) < new Date()) {
      auth.revoked = true;
      return { status: "BLOCKED", blockers: ["Authorization expired"], reasons: ["Authorization expired"] };
    }

    // Check revocation
    if (auth.revoked) {
      return { status: "BLOCKED", blockers: ["Authorization revoked"], reasons: ["Authorization revoked"] };
    }

    // Check binding
    if (
      auth.releaseId !== releaseId ||
      auth.artifactId !== artifactId ||
      auth.commitSha !== commitSha ||
      auth.environment !== environment
    ) {
      return { status: "BLOCKED", blockers: ["Authorization binding mismatch"], reasons: ["Authorization binding mismatch"] };
    }

    // Phase 138: consumption is deferred to executeRelease so a crash between
    // authorization and provider invocation does not burn the authorization
    // for a same-attempt retry. Different-attempt reuse remains blocked.
    if (auth.consumed && auth.consumedByAttemptId !== attemptId) {
      return { status: "BLOCKED", blockers: ["Authorization already consumed by a different attempt"], reasons: ["Authorization replay detected"] };
    }

    return { status: "AUTHORIZED", authorization: auth, blockers: [], reasons: [] };
  }

  async executeRelease(
    authorizationId: string,
    releaseId: string,
    artifactId: string,
    commitSha: string,
    environment: string,
    attemptId: string | null,
  ): Promise<DeploymentResult> {
    if (!attemptId || attemptId.length === 0) {
      return {
        status: "BLOCKED",
        message: "Durable execution attempt identity is required for production release execution",
        providerAvailable: this.provider !== undefined,
      };
    }
    if (!this.store) {
      return {
        status: "BLOCKED",
        message: "Durable execution attempt identity cannot be validated: no durable store available",
        providerAvailable: this.provider !== undefined,
      };
    }
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt) {
      return {
        status: "BLOCKED",
        message: "Attempt identity is not a durable ExecutionAttempt: " + attemptId,
        providerAvailable: this.provider !== undefined,
      };
    }
    const attemptJob = this.store.getJob(attempt.jobId);
    if (!attemptJob) {
      return {
        status: "BLOCKED",
        message: "Attempt's execution job is not durable: " + attempt.jobId,
        providerAvailable: this.provider !== undefined,
      };
    }
    const jobExecutionId = (attemptJob as { payload?: { executionId?: string } }).payload?.executionId;
    if (jobExecutionId !== releaseId) {
      return {
        status: "BLOCKED",
        message: "Attempt " + attemptId + " does not belong to execution " + releaseId,
        providerAvailable: this.provider !== undefined,
      };
    }
    const authResult = await this.authorizeExecution(authorizationId, releaseId, artifactId, commitSha, environment, attemptId);
    if (authResult.status !== "AUTHORIZED" || !authResult.authorization) {
      return {
        status: authResult.status === "FAIL" ? "FAIL" : "BLOCKED",
        message: authResult.reasons.join(", "),
        providerAvailable: this.provider !== undefined,
      };
    }

    // Phase 138: consume on the provider-invocation boundary, bound to the attempt.
    const auth = authResult.authorization;
    if (!auth.consumed) {
      if (this.store) {
        const cas = this.store.consumeProductionAuthorization(authorizationId, attemptId);
        if (!cas.consumed && cas.consumedByAttemptId !== attemptId) {
          return {
            status: "BLOCKED",
            message: "Authorization already consumed by a different attempt",
            providerAvailable: this.provider !== undefined,
          };
        }
      } else {
        auth.consumed = true;
        auth.consumedByAttemptId = attemptId;
        this.authorizations.set(auth.authorizationId, auth);
      }
    }

    // No provider wired → fail closed (Phase 101 / Phase 4 Pass 6 behavior preserved).
    if (!this.provider) {
      return {
        status: "BLOCKED",
        message: "No real production deployment provider configured",
        providerAvailable: false,
      };
    }

    // Real provider wired → invoke canonical deployment, translate outcome.
    const outcome = await this.provider.execute({
      authorizationId: auth.authorizationId,
      releaseId: auth.releaseId,
      artifactId: auth.artifactId,
      commitSha: auth.commitSha,
      environment: auth.environment,
      projectId: auth.projectId ?? null,
      executionId: auth.executionId ?? null,
      imageRepository: auth.imageRepository ?? null,
      imageTag: auth.imageTag ?? null,
      imageId: auth.imageId ?? null,
      imageDigest: auth.artifactDigest,
      containerName: auth.containerName ?? null,
      containerPort: auth.containerPort ?? null,
    });

    return {
      status: outcome.status,
      message: outcome.message,
      providerAvailable: true,
      provider: "canonical-deployment-orchestrator",
      deploymentId: outcome.deploymentId ?? undefined,
    };
  }

}
