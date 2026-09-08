// Phase 99 Worker - Autonomous Engineering Governance, Compliance & Human Oversight
import { randomUUID } from 'crypto';

function generateId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
}

function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
}

function nowISO(): string {
    return new Date().toISOString();
}

function redactString(input: string): string {
    const patterns = [
        /password\s*=\s*["'][^"']*["']/gi,
        /token\s*=\s*["'][^"']*["']/gi,
        /api[_-]?key\s*=\s*["'][^"']*["']/gi,
        /authorization\s*:\s*["'][^"']*["']/gi,
        /secret\s*=\s*["'][^"']*["']/gi,
        /credential\s*=\s*["'][^"']*["']/gi,
    ];
    let result = input;
    for (const pattern of patterns) {
        result = result.replace(pattern, 'REDACTED');
    }
    return result;
}

const sensitiveKeyPattern = /password|token|api[_-]?key|authorization|secret|credential/i;

function sanitizeForStorage(data: any): any {
    if (Array.isArray(data)) {
        return data.map(item => sanitizeForStorage(item));
    }
    if (data !== null && typeof data === 'object') {
        const out: any = {};
        for (const [key, value] of Object.entries(data)) {
            if (sensitiveKeyPattern.test(key)) {
                out['REDACTED_KEY'] = 'REDACTED';
            } else {
                out[key] = sanitizeForStorage(value);
            }
        }
        return out;
    }
    if (typeof data === 'string') {
        return redactString(data);
    }
    return data;
}

export interface Store {
    domains: Map<string, any>;
    policies: Map<string, any>;
    policyVersions: Map<string, any[]>;
    bindings: Map<string, any>;
    conflicts: Map<string, any>;
    decisions: Map<string, any>;
    constraints: Map<string, any>;
    frameworks: Map<string, any>;
    controls: Map<string, any>;
    obligations: Map<string, any>;
    mappings: Map<string, any>;
    assessments: Map<string, any>;
    findings: Map<string, any>;
    evidence: Map<string, any>;
    exceptions: Map<string, any>;
    compensatingControls: Map<string, any>;
    waivers: Map<string, any>;
    waiverApprovals: Map<string, any>;
    oversightRequests: Map<string, any>;
    oversightApprovals: Map<string, any>;
    oversightApprovers: Map<string, any>;
    oversightQuorums: Map<string, any>;
    oversightInterventions: Map<string, any>;
    authorizationGrants: Map<string, any>;
    authorizationRevocations: Map<string, any>;
    separationOfDutiesRules: Map<string, any>;
    breakGlassEvents: Map<string, any>;
    protectedOperations: Map<string, any>;
    executionGates: Map<string, any>;
    complianceGates: Map<string, any>;
    agentProfiles: Map<string, any>;
    modelRecords: Map<string, any>;
    toolPolicies: Map<string, any>;
    dataRules: Map<string, any>;
    residencyPolicies: Map<string, any>;
    retentionPolicies: Map<string, any>;
    supplyChainFindings: Map<string, any>;
    artifactGovernance: Map<string, any>;
    releaseGovernance: Map<string, any>;
    infraGovernance: Map<string, any>;
    incidents: Map<string, any>;
    escalations: Map<string, any>;
    correctiveActions: Map<string, any>;
    preventiveActions: Map<string, any>;
    governanceEvidence: Map<string, any>;
    audit: Map<string, any>;
    lineage: Map<string, any>;
    learning: Map<string, any>;
    replay: Map<string, any>;
    idempotencyKeys: Set<string>;
}

function createEmptyStore(): Store {
    return {
        domains: new Map(),
        policies: new Map(),
        policyVersions: new Map(),
        bindings: new Map(),
        conflicts: new Map(),
        decisions: new Map(),
        constraints: new Map(),
        frameworks: new Map(),
        controls: new Map(),
        obligations: new Map(),
        mappings: new Map(),
        assessments: new Map(),
        findings: new Map(),
        evidence: new Map(),
        exceptions: new Map(),
        compensatingControls: new Map(),
        waivers: new Map(),
        waiverApprovals: new Map(),
        oversightRequests: new Map(),
        oversightApprovals: new Map(),
        oversightApprovers: new Map(),
        oversightQuorums: new Map(),
        oversightInterventions: new Map(),
        authorizationGrants: new Map(),
        authorizationRevocations: new Map(),
        separationOfDutiesRules: new Map(),
        breakGlassEvents: new Map(),
        protectedOperations: new Map(),
        executionGates: new Map(),
        complianceGates: new Map(),
        agentProfiles: new Map(),
        modelRecords: new Map(),
        toolPolicies: new Map(),
        dataRules: new Map(),
        residencyPolicies: new Map(),
        retentionPolicies: new Map(),
        supplyChainFindings: new Map(),
        artifactGovernance: new Map(),
        releaseGovernance: new Map(),
        infraGovernance: new Map(),
        incidents: new Map(),
        escalations: new Map(),
        correctiveActions: new Map(),
        preventiveActions: new Map(),
        governanceEvidence: new Map(),
        audit: new Map(),
        lineage: new Map(),
        learning: new Map(),
        replay: new Map(),
        idempotencyKeys: new Set(),
    };
}

export class GovernanceControl {
    private store: Store;

    constructor(store?: Store) {
        this.store = store || createEmptyStore();
    }

    private recordAudit(entityType: string, entityId: string, prevState: string | null, newState: string, actor: string, reason: string, actorType: string = 'system', policyVersion?: string): void {
        const audit = {
            id: generateId('audit'),
            entity_type: entityType,
            entity_id: entityId,
            previous_state: prevState,
            new_state: newState,
            actor,
            actor_type: actorType,
            reason: redactString(reason),
            policy_version: policyVersion || null,
            correlation_id: generateId('corr'),
            created_at: nowISO(),
        };
        this.store.audit.set(audit.id, audit);
    }

    private recordLineage(entityType: string, entityId: string, nodeType: string, nodeId: string, parentNodeId: string | null): void {
        const lineage = {
            id: generateId('lineage'),
            entity_type: entityType,
            entity_id: entityId,
            node_type: nodeType,
            node_id: nodeId,
            parent_node_id: parentNodeId,
            metadata: null,
            created_at: nowISO(),
        };
        this.store.lineage.set(lineage.id, lineage);
    }

    private recordEvidence(entityType: string, entityId: string, evidenceType: string, data: any, actor: string = 'system'): void {
        const evidence = {
            id: generateId('evidence'),
            entity_type: entityType,
            entity_id: entityId,
            evidence_type: evidenceType,
            data: JSON.stringify(sanitizeForStorage(data)),
            actor,
            correlation_id: generateId('corr'),
            created_at: nowISO(),
        };
        this.store.governanceEvidence.set(evidence.id, evidence);
    }

    // ---------- Governance Domain & Policies ----------
    registerGovernanceDomain(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.domains.values()).find(d => d.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const domain = {
            id: input.id || generateId('govdomain'),
            name: input.name,
            organization_id: input.organizationId,
            state: 'ACTIVE',
            version: 1,
            created_at: nowISO(),
            updated_at: nowISO(),
            idempotency_key: input.idempotencyKey,
        };
        this.store.domains.set(domain.id, domain);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        this.recordAudit('GOVERNANCE_DOMAIN', domain.id, null, domain.state, 'system', 'Domain created');
        return domain;
    }

    createPolicy(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.policies.values()).find(p => p.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const policy = {
            id: input.id || generateId('policy'),
            domain_id: input.domainId,
            name: input.name,
            version: input.version || 1,
            policy_data: JSON.stringify(input.policyData || {}),
            state: input.state || 'DRAFT',
            created_at: nowISO(),
            activated_at: input.activatedAt || null,
            expires_at: input.expiresAt || null,
            idempotency_key: input.idempotencyKey,
        };
        this.store.policies.set(policy.id, policy);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        this.createPolicyVersion(policy.id, 'Initial');
        this.recordLineage('POLICY', policy.id, 'POLICY', policy.id, null);
        this.recordAudit('POLICY', policy.id, null, policy.state, 'system', 'Policy created');
        return policy;
    }

    createPolicyVersion(policyId: string, reason: string, actor: string = 'system'): any {
        const policy = this.store.policies.get(policyId);
        if (!policy) throw new Error('Policy not found');
        const version = policy.version;
        const versionRecord = {
            id: generateId('policyver'),
            policy_id: policyId,
            version,
            snapshot: JSON.stringify(policy),
            created_at: nowISO(),
        };
        if (!this.store.policyVersions.has(policyId)) this.store.policyVersions.set(policyId, []);
        this.store.policyVersions.get(policyId)!.push(versionRecord);
        policy.version += 1;
        this.store.policies.set(policyId, policy);
        this.recordAudit('POLICY_VERSION', versionRecord.id, null, version.toString(), actor, reason);
        return versionRecord;
    }

    bindPolicy(input: any): any {
        const binding = {
            id: input.id || generateId('binding'),
            policy_id: input.policyId,
            entity_type: input.entityType,
            entity_id: input.entityId,
            binding_data: JSON.stringify(input.bindingData || {}),
            created_at: nowISO(),
        };
        this.store.bindings.set(binding.id, binding);
        return binding;
    }

    resolvePolicy(entityType: string, entityId: string): any {
        const bindings = Array.from(this.store.bindings.values()).filter(b => b.entity_type === entityType && b.entity_id === entityId);
        if (bindings.length === 0) return { outcome: 'ALLOW', reason: 'No applicable policy' };
        // Simple precedence: first binding's policy
        const policyId = bindings[0].policy_id;
        const policy = this.store.policies.get(policyId);
        if (!policy) return { outcome: 'DENY', reason: 'Unknown policy' };
        const policyData = JSON.parse(policy.policy_data);
        return { outcome: policyData.outcome || 'ALLOW', reason: policyData.reason || '', policyId, policyVersion: policy.version - 1 };
    }

    detectPolicyConflict(policyId1: string, policyId2: string): any {
        const conflict = {
            id: generateId('conflict'),
            policy_id_1: policyId1,
            policy_id_2: policyId2,
            conflict_type: 'GENERAL',
            resolution: 'UNRESOLVED',
            created_at: nowISO(),
        };
        this.store.conflicts.set(conflict.id, conflict);
        return conflict;
    }

    simulatePolicy(policyId: string): any {
        return { status: 'SIMULATED', outcome: 'ALLOW' };
    }

    evaluateGovernance(entityType: string, entityId: string, action: string): string {
        // Simplified: check constraints and policy
        const policyResult = this.resolvePolicy(entityType, entityId);
        if (policyResult.outcome === 'DENY') return 'DENY';
        if (policyResult.outcome === 'FREEZE') return 'FREEZE';
        return 'ALLOW';
    }

    // ---------- Compliance ----------
    registerComplianceFramework(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.frameworks.values()).find(f => f.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const framework = {
            id: input.id || generateId('framework'),
            name: input.name,
            description: input.description || '',
            version: input.version,
            created_at: nowISO(),
            idempotency_key: input.idempotencyKey,
        };
        this.store.frameworks.set(framework.id, framework);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        return framework;
    }

    registerControl(input: any): any {
        const control = {
            id: input.id || generateId('control'),
            framework_id: input.frameworkId,
            control_id: input.controlId,
            description: input.description,
            requirement: input.requirement,
            evidence_required: input.evidenceRequired ? 1 : 0,
            created_at: nowISO(),
        };
        this.store.controls.set(control.id, control);
        return control;
    }

    mapControl(input: any): any {
        const mapping = {
            id: input.id || generateId('mapping'),
            control_id: input.controlId,
            entity_type: input.entityType,
            entity_id: input.entityId,
            created_at: nowISO(),
        };
        this.store.mappings.set(mapping.id, mapping);
        return mapping;
    }

    assessCompliance(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.assessments.values()).find(a => a.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const assessment = {
            id: input.id || generateId('assessment'),
            control_id: input.controlId,
            entity_type: input.entityType,
            entity_id: input.entityId,
            assessment_state: input.state || 'UNKNOWN',
            evidence_refs: JSON.stringify(input.evidenceRefs || []),
            assessed_at: nowISO(),
            expires_at: input.expiresAt || null,
            idempotency_key: input.idempotencyKey,
        };
        this.store.assessments.set(assessment.id, assessment);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        return assessment;
    }

    createException(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.exceptions.values()).find(e => e.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const exception = {
            id: input.id || generateId('exception'),
            control_id: input.controlId,
            entity_type: input.entityType,
            entity_id: input.entityId,
            justification: input.justification,
            risk: input.risk || 'UNKNOWN',
            compensating_control_id: input.compensatingControlId || null,
            approver: null,
            state: 'REQUESTED',
            expires_at: input.expiresAt || null,
            approved_at: null,
            revoked_at: null,
            idempotency_key: input.idempotencyKey,
        };
        this.store.exceptions.set(exception.id, exception);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        return exception;
    }

    approveException(exceptionId: string, approver: string): any {
        const exception = this.store.exceptions.get(exceptionId);
        if (!exception) throw new Error('Exception not found');
        exception.state = 'APPROVED';
        exception.approver = approver;
        exception.approved_at = nowISO();
        this.store.exceptions.set(exceptionId, exception);
        return exception;
    }

    revokeException(exceptionId: string, reason: string): any {
        const exception = this.store.exceptions.get(exceptionId);
        if (!exception) throw new Error('Exception not found');
        exception.state = 'REVOKED';
        exception.revoked_at = nowISO();
        this.store.exceptions.set(exceptionId, exception);
        return exception;
    }

    createWaiver(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.waivers.values()).find(w => w.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const waiver = {
            id: input.id || generateId('waiver'),
            entity_type: input.entityType,
            entity_id: input.entityId,
            justification: input.justification,
            risk_acceptance: input.riskAcceptance,
            scope: input.scope,
            approver: null,
            state: 'REQUESTED',
            expires_at: input.expiresAt || null,
            approved_at: null,
            revoked_at: null,
            idempotency_key: input.idempotencyKey,
        };
        this.store.waivers.set(waiver.id, waiver);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        return waiver;
    }

    approveWaiver(waiverId: string, approver: string): any {
        const waiver = this.store.waivers.get(waiverId);
        if (!waiver) throw new Error('Waiver not found');
        waiver.state = 'APPROVED';
        waiver.approver = approver;
        waiver.approved_at = nowISO();
        this.store.waivers.set(waiverId, waiver);
        return waiver;
    }

    // ---------- Authorization ----------
    authorize(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.authorizationGrants.values()).find(a => a.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const grant = {
            id: input.id || generateId('authgrant'),
            identity: input.identity,
            role: input.role || null,
            capability: input.capability,
            resource_type: input.resourceType,
            resource_id: input.resourceId,
            effect: input.effect || 'ALLOW',
            expires_at: input.expiresAt || null,
            revoked: 0,
            idempotency_key: input.idempotencyKey,
        };
        this.store.authorizationGrants.set(grant.id, grant);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        return grant;
    }

    revokeAuthorization(grantId: string, revokedBy: string, reason: string): any {
        const grant = this.store.authorizationGrants.get(grantId);
        if (!grant) throw new Error('Grant not found');
        grant.revoked = 1;
        this.store.authorizationGrants.set(grantId, grant);
        const revocation = {
            id: generateId('authrev'),
            grant_id: grantId,
            revoked_by: revokedBy,
            reason,
            revoked_at: nowISO(),
        };
        this.store.authorizationRevocations.set(revocation.id, revocation);
        return revocation;
    }

    evaluateSeparationOfDuties(requester: string, approver: string): boolean {
        // Simplified rule: requester and approver must differ
        return requester !== approver;
    }

    requestOversight(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.oversightRequests.values()).find(o => o.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const request = {
            id: input.id || generateId('oversight'),
            subject_type: input.subjectType,
            subject_id: input.subjectId,
            requested_action: input.requestedAction,
            requester: input.requester,
            state: 'REQUESTED',
            created_at: nowISO(),
            expires_at: input.expiresAt || null,
            idempotency_key: input.idempotencyKey,
        };
        this.store.oversightRequests.set(request.id, request);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        return request;
    }

    approveOversight(requestId: string, approver: string): any {
        const request = this.store.oversightRequests.get(requestId);
        if (!request) throw new Error('Request not found');
        request.state = 'APPROVED';
        this.store.oversightRequests.set(requestId, request);
        const approval = {
            id: generateId('oversightappr'),
            request_id: requestId,
            approver,
            decision: 'APPROVED',
            decided_at: nowISO(),
        };
        this.store.oversightApprovals.set(approval.id, approval);
        return approval;
    }

    rejectOversight(requestId: string, reason: string): any {
        const request = this.store.oversightRequests.get(requestId);
        if (!request) throw new Error('Request not found');
        request.state = 'REJECTED';
        this.store.oversightRequests.set(requestId, request);
        return request;
    }

    activateBreakGlass(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.breakGlassEvents.values()).find(b => b.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const event = {
            id: input.id || generateId('breakglass'),
            actor: input.actor,
            reason: input.reason,
            scope: input.scope,
            expires_at: input.expiresAt || null,
            activated_at: nowISO(),
            reviewed: 0,
            idempotency_key: input.idempotencyKey,
        };
        this.store.breakGlassEvents.set(event.id, event);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        return event;
    }

    evaluateExecutionGate(input: any): any {
        // Simplified gate evaluation
        const result = {
            outcome: input.outcome || 'ALLOW',
            reason: input.reason || '',
        };
        return result;
    }

    evaluateAgentGovernance(agentId: string, requiredCapability: string): boolean {
        const profile = Array.from(this.store.agentProfiles.values()).find(a => a.agent_id === agentId);
        if (!profile) return false;
        const capabilities = JSON.parse(profile.capabilities);
        return capabilities.includes(requiredCapability);
    }

    evaluateToolGovernance(toolId: string, scope: string): boolean {
        const policy = Array.from(this.store.toolPolicies.values()).find(t => t.tool_id === toolId && t.revoked === 0);
        if (!policy) return false;
        const allowed = JSON.parse(policy.allowed_scopes);
        return allowed.includes(scope);
    }

    evaluateDataGovernance(dataClassification: string, region: string): boolean {
        const rule = Array.from(this.store.dataRules.values()).find(d => d.data_classification === dataClassification);
        if (!rule) return false;
        const prohibited = JSON.parse(rule.prohibited_regions);
        return !prohibited.includes(region);
    }

    evaluateReleaseGovernance(releaseId: string, environment: string): string {
        const record = Array.from(this.store.releaseGovernance.values()).find(r => r.release_id === releaseId && r.environment === environment);
        if (!record) return 'DENY';
        return record.state === 'APPROVED' ? 'ALLOW' : 'DENY';
    }

    evaluateInfrastructureGovernance(resourceId: string, action: string): string {
        const record = Array.from(this.store.infraGovernance.values()).find(i => i.resource_id === resourceId && i.action === action);
        if (!record) return 'DENY';
        return record.state === 'APPROVED' ? 'ALLOW' : 'DENY';
    }

    createGovernanceIncident(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.incidents.values()).find(i => i.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const incident = {
            id: input.id || generateId('govincident'),
            incident_type: input.incidentType,
            severity: input.severity,
            description: redactString(input.description),
            status: 'OPEN',
            idempotency_key: input.idempotencyKey,
            created_at: nowISO(),
        };
        this.store.incidents.set(incident.id, incident);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        return incident;
    }

    escalateGovernanceIncident(incidentId: string, level: number, reason: string): any {
        const incident = this.store.incidents.get(incidentId);
        if (!incident) throw new Error('Incident not found');
        const escalation = {
            id: generateId('govescalation'),
            incident_id: incidentId,
            level,
            reason: redactString(reason),
            created_at: nowISO(),
        };
        this.store.escalations.set(escalation.id, escalation);
        return escalation;
    }

    createCorrectiveAction(input: any): any {
        const action = {
            id: input.id || generateId('corrective'),
            description: input.description,
            owner: input.owner || null,
            deadline: input.deadline || null,
            status: 'OPEN',
            verified: 0,
            created_at: nowISO(),
        };
        this.store.correctiveActions.set(action.id, action);
        return action;
    }

    generateGovernanceEvidence(entityType: string, entityId: string, evidenceType: string, data: any, actor: string = 'system'): any {
        const evidence = {
            id: generateId('govevidence'),
            entity_type: entityType,
            entity_id: entityId,
            evidence_type: evidenceType,
            data: JSON.stringify(sanitizeForStorage(data)),
            actor,
            correlation_id: generateId('corr'),
            created_at: nowISO(),
        };
        this.store.governanceEvidence.set(evidence.id, evidence);
        return evidence;
    }

    queryGovernanceLineage(entityType: string, entityId: string): any[] {
        return Array.from(this.store.lineage.values()).filter(l => l.entity_type === entityType && l.entity_id === entityId);
    }

    recordGovernanceLearning(entityType: string, entityId: string, learningType: string, content: string): any {
        const learning = {
            id: generateId('govlearning'),
            entity_type: entityType,
            entity_id: entityId,
            learning_type: learningType,
            content: redactString(content),
            created_at: nowISO(),
        };
        this.store.learning.set(learning.id, learning);
        return learning;
    }

    computeDeterministicHash(subjectType: string, subjectId: string): string {
        return `${subjectType}_${subjectId}`;
    }

    replayGovernanceDecision(subjectType: string, subjectId: string, inputHash: string): any {
        const outputHash = this.computeDeterministicHash(subjectType, subjectId);
        const divergence = inputHash === outputHash ? 0 : 1;
        const replay = {
            id: generateId('govreplay'),
            subject_type: subjectType,
            subject_id: subjectId,
            input_hash: inputHash,
            output_hash: outputHash,
            divergence,
            replayed_at: nowISO(),
        };
        this.store.replay.set(replay.id, replay);
        return replay;
    }

    getStore(): Store {
        return this.store;
    }
}
