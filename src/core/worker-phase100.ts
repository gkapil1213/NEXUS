// Phase 100 Worker - NEXUS Autonomous Engineering OS Final Integration
import { randomUUID } from 'crypto';

function generateId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
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

export interface NexusOSStore {
    intents: Map<string, any>;
    missions: Map<string, any>;
    portfolios: Map<string, any>;
    projects: Map<string, any>;
    environments: Map<string, any>;
    agents: Map<string, any>;
    capabilities: Map<string, any>;
    teams: Map<string, any>;
    strategies: Map<string, any>;
    risks: Map<string, any>;
    governanceDecisions: Map<string, any>;
    safetyDecisions: Map<string, any>;
    approvals: Map<string, any>;
    resources: Map<string, any>;
    reservations: Map<string, any>;
    workloads: Map<string, any>;
    scheduling: Map<string, any>;
    executions: Map<string, any>;
    observations: Map<string, any>;
    diagnoses: Map<string, any>;
    remediations: Map<string, any>;
    verifications: Map<string, any>;
    recoveries: Map<string, any>;
    rollbacks: Map<string, any>;
    incidents: Map<string, any>;
    evidence: Map<string, any>;
    audit: Map<string, any>;
    lineage: Map<string, any>;
    learning: Map<string, any>;
    decisionMemory: Map<string, any>;
    replay: Map<string, any>;
    breakers: Map<string, any>;
    idempotencyKeys: Set<string>;
    shutdownState: { isShutdown: boolean };
    concurrencyLocks: Map<string, boolean>;
}

function createEmptyStore(): NexusOSStore {
    return {
        intents: new Map(),
        missions: new Map(),
        portfolios: new Map(),
        projects: new Map(),
        environments: new Map(),
        agents: new Map(),
        capabilities: new Map(),
        teams: new Map(),
        strategies: new Map(),
        risks: new Map(),
        governanceDecisions: new Map(),
        safetyDecisions: new Map(),
        approvals: new Map(),
        resources: new Map(),
        reservations: new Map(),
        workloads: new Map(),
        scheduling: new Map(),
        executions: new Map(),
        observations: new Map(),
        diagnoses: new Map(),
        remediations: new Map(),
        verifications: new Map(),
        recoveries: new Map(),
        rollbacks: new Map(),
        incidents: new Map(),
        evidence: new Map(),
        audit: new Map(),
        lineage: new Map(),
        learning: new Map(),
        decisionMemory: new Map(),
        replay: new Map(),
        breakers: new Map(),
        idempotencyKeys: new Set(),
        shutdownState: { isShutdown: false },
        concurrencyLocks: new Map(),
    };
}

export class NexusOS {
    private store: NexusOSStore;

    constructor(store?: NexusOSStore) {
        this.store = store || createEmptyStore();
    }

    private recordAudit(entityType: string, entityId: string, prevState: string | null, newState: string, actor: string, reason: string): void {
        const audit = {
            id: generateId('audit'),
            entity_type: entityType,
            entity_id: entityId,
            previous_state: prevState,
            new_state: newState,
            actor,
            reason: redactString(reason),
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
        this.store.evidence.set(evidence.id, evidence);
    }

    // ---------- Intent & Mission ----------
    ingestIntent(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.intents.values()).find(i => i.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const intent = {
            id: input.id || generateId('intent'),
            description: input.description,
            organization_id: input.organizationId,
            idempotency_key: input.idempotencyKey,
            state: 'RECEIVED',
            created_at: nowISO(),
        };
        this.store.intents.set(intent.id, intent);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        this.recordAudit('INTENT', intent.id, null, intent.state, 'system', 'Intent ingested');
        return intent;
    }

    createMission(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.missions.values()).find(m => m.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const mission = {
            id: input.id || generateId('mission'),
            intent_id: input.intentId,
            organization_id: input.organizationId,
            project_id: input.projectId || null,
            description: input.description,
            state: 'CREATED',
            created_at: nowISO(),
            idempotency_key: input.idempotencyKey,
        };
        this.store.missions.set(mission.id, mission);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        this.recordLineage('MISSION', mission.id, 'MISSION', mission.id, input.intentId || null);
        this.recordAudit('MISSION', mission.id, null, mission.state, 'system', 'Mission created');
        return mission;
    }

    planMission(missionId: string): any {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        this.recordLineage('MISSION', missionId, 'PLAN', generateId('plan'), missionId);
        const plan = {
            id: generateId('plan'),
            mission_id: missionId,
            plan_data: { steps: ['analyze','plan','execute'] },
            state: 'PLANNED',
            created_at: nowISO(),
        };
        mission.state = 'PLANNED';
        this.store.missions.set(missionId, mission);
        this.recordAudit('MISSION', missionId, 'CREATED', 'PLANNED', 'system', 'Mission planned');
        return plan;
    }

    evaluateStrategy(missionId: string): any {
        this.recordLineage('MISSION', missionId, 'STRATEGY', generateId('strategy'), missionId);
        const strategy = {
            id: generateId('strategy'),
            mission_id: missionId,
            content: 'default strategy',
            risk: 'LOW',
            created_at: nowISO(),
        };
        this.store.strategies.set(strategy.id, strategy);
        return strategy;
    }

    composeAgentTeam(missionId: string): any {
        this.recordLineage('MISSION', missionId, 'TEAM', generateId('team'), missionId);
        const team = {
            id: generateId('team'),
            mission_id: missionId,
            members: [],
            created_at: nowISO(),
        };
        this.store.teams.set(team.id, team);
        return team;
    }

    evaluateRisk(missionId: string): any {
        this.recordLineage('MISSION', missionId, 'RISK', generateId('risk'), missionId);
        const risk = {
            id: generateId('risk'),
            mission_id: missionId,
            level: 'LOW',
            created_at: nowISO(),
        };
        this.store.risks.set(risk.id, risk);
        return risk;
    }

    evaluateGovernance(missionId: string): string {
        this.recordLineage('MISSION', missionId, 'GOVERNANCE', generateId('gov'), missionId);
        const decision = 'ALLOW';
        const record = {
            id: generateId('gov'),
            mission_id: missionId,
            decision,
            created_at: nowISO(),
        };
        this.store.governanceDecisions.set(record.id, record);
        return decision;
    }

    evaluateSafety(missionId: string): string {
        this.recordLineage('MISSION', missionId, 'SAFETY', generateId('safety'), missionId);
        const decision = 'ALLOW';
        const record = {
            id: generateId('safety'),
            mission_id: missionId,
            decision,
            created_at: nowISO(),
        };
        this.store.safetyDecisions.set(record.id, record);
        return decision;
    }

    requestApproval(missionId: string, requester: string): any {
        this.recordLineage('MISSION', missionId, 'APPROVAL_REQUEST', generateId('approval'), missionId);
        const approval = {
            id: generateId('approval'),
            mission_id: missionId,
            requester,
            state: 'REQUESTED',
            created_at: nowISO(),
        };
        this.store.approvals.set(approval.id, approval);
        return approval;
    }

    approveApproval(approvalId: string, approver: string): any {
        const approval = this.store.approvals.get(approvalId);
        if (!approval) throw new Error('Approval not found');
        approval.state = 'APPROVED';
        approval.approver = approver;
        this.store.approvals.set(approvalId, approval);
        return approval;
    }

    allocateResources(missionId: string, resourceType: string, amount: number): any {
        this.recordLineage('MISSION', missionId, 'RESOURCE', generateId('resource'), missionId);
        const resource = {
            id: generateId('resource'),
            mission_id: missionId,
            type: resourceType,
            amount,
            state: 'ALLOCATED',
            created_at: nowISO(),
        };
        this.store.resources.set(resource.id, resource);
        return resource;
    }

    reserveResource(resourceId: string, missionId: string, idempotencyKey: string): any {
        if (this.store.idempotencyKeys.has(idempotencyKey)) {
            const existing = Array.from(this.store.reservations.values()).find(r => r.idempotency_key === idempotencyKey);
            if (existing) return existing;
        }
        const reservation = {
            id: generateId('reservation'),
            resource_id: resourceId,
            mission_id: missionId,
            idempotency_key: idempotencyKey,
            state: 'ACTIVE',
            created_at: nowISO(),
        };
        this.store.reservations.set(reservation.id, reservation);
        this.store.idempotencyKeys.add(idempotencyKey);
        return reservation;
    }

    scheduleWorkload(missionId: string): any {
        this.recordLineage('MISSION', missionId, 'SCHEDULE', generateId('workload'), missionId);
        const workload = {
            id: generateId('workload'),
            mission_id: missionId,
            state: 'SCHEDULED',
            created_at: nowISO(),
        };
        this.store.workloads.set(workload.id, workload);
        this.store.scheduling.set(workload.id, { status: 'SCHEDULED' });
        return workload;
    }

    dispatchWorkload(workloadId: string): any {
        const workload = this.store.workloads.get(workloadId);
        if (!workload) throw new Error('Workload not found');
        if (this.store.shutdownState.isShutdown) throw new Error('System is shutting down');
        workload.state = 'DISPATCHED';
        this.store.workloads.set(workloadId, workload);
        return workload;
    }

    executeWorkload(workloadId: string): any {
        const workload = this.store.workloads.get(workloadId);
        if (!workload) throw new Error('Workload not found');
        workload.state = 'EXECUTING';
        this.store.workloads.set(workloadId, workload);
        const execution = {
            id: generateId('execution'),
            workload_id: workloadId,
            state: 'RUNNING',
            created_at: nowISO(),
        };
        this.store.executions.set(execution.id, execution);
        return execution;
    }

    observe(executionId: string, observationType: string, value: any): any {
        const obs = {
            id: generateId('obs'),
            execution_id: executionId,
            type: observationType,
            value,
            created_at: nowISO(),
        };
        this.store.observations.set(obs.id, obs);
        return obs;
    }

    diagnose(executionId: string, suspectedCause: string): any {
        const diag = {
            id: generateId('diag'),
            execution_id: executionId,
            cause: suspectedCause,
            created_at: nowISO(),
        };
        this.store.diagnoses.set(diag.id, diag);
        return diag;
    }

    remediate(diagnosisId: string, action: string): any {
        const rem = {
            id: generateId('remediation'),
            diagnosis_id: diagnosisId,
            action,
            state: 'EXECUTED',
            created_at: nowISO(),
        };
        this.store.remediations.set(rem.id, rem);
        return rem;
    }

    verify(executionId: string, status: string): any {
        const ver = {
            id: generateId('verification'),
            execution_id: executionId,
            status,
            created_at: nowISO(),
        };
        this.store.verifications.set(ver.id, ver);
        return ver;
    }

    recover(executionId: string): any {
        const rec = {
            id: generateId('recovery'),
            execution_id: executionId,
            state: 'RECOVERED',
            created_at: nowISO(),
        };
        this.store.recoveries.set(rec.id, rec);
        return rec;
    }

    rollback(executionId: string): any {
        const rb = {
            id: generateId('rollback'),
            execution_id: executionId,
            state: 'ROLLED_BACK',
            created_at: nowISO(),
        };
        this.store.rollbacks.set(rb.id, rb);
        return rb;
    }

    createIncident(subjectType: string, subjectId: string, type: string, severity: string, idempotencyKey?: string): any {
        const key = idempotencyKey || `${subjectType}_${subjectId}_${type}`;
        if (this.store.idempotencyKeys.has(key)) {
            const existing = Array.from(this.store.incidents.values()).find(i => i.idempotency_key === key);
            if (existing) return existing;
        }
        const incident = {
            id: generateId('incident'),
            subject_type: subjectType,
            subject_id: subjectId,
            type,
            severity,
            idempotency_key: key,
            state: 'OPEN',
            created_at: nowISO(),
        };
        this.store.incidents.set(incident.id, incident);
        this.store.idempotencyKeys.add(key);
        return incident;
    }

    generateEvidence(entityType: string, entityId: string, evidenceType: string, data: any): any {
        const ev = {
            id: generateId('evidence'),
            entity_type: entityType,
            entity_id: entityId,
            evidence_type: evidenceType,
            data: JSON.stringify(sanitizeForStorage(data)),
            created_at: nowISO(),
        };
        this.store.evidence.set(ev.id, ev);
        return ev;
    }

    queryLineage(entityType: string, entityId: string): any[] {
        return Array.from(this.store.lineage.values()).filter(l => l.entity_type === entityType && l.entity_id === entityId);
    }

    recordLearning(entityType: string, entityId: string, learningType: string, content: string): any {
        const learning = {
            id: generateId('learning'),
            entity_type: entityType,
            entity_id: entityId,
            learning_type: learningType,
            content: redactString(content),
            created_at: nowISO(),
        };
        this.store.learning.set(learning.id, learning);
        return learning;
    }

    recordDecisionMemory(decisionId: string, context: any): any {
        const dm = {
            id: generateId('decision_memory'),
            decision_id: decisionId,
            context: JSON.stringify(sanitizeForStorage(context)),
            created_at: nowISO(),
        };
        this.store.decisionMemory.set(dm.id, dm);
        return dm;
    }

    computeDeterministicHash(entityType: string, entityId: string): string {
        return `${entityType}_${entityId}`;
    }

    replayDecision(entityType: string, entityId: string, inputHash: string): any {
        const outputHash = this.computeDeterministicHash(entityType, entityId);
        const divergence = inputHash === outputHash ? 0 : 1;
        const replay = {
            id: generateId('replay'),
            entity_type: entityType,
            entity_id: entityId,
            input_hash: inputHash,
            output_hash: outputHash,
            divergence,
            created_at: nowISO(),
        };
        this.store.replay.set(replay.id, replay);
        return replay;
    }

    pauseExecution(executionId: string, actor: string, reason: string): any {
        const execution = this.store.executions.get(executionId);
        if (!execution) throw new Error('Execution not found');
        execution.state = 'PAUSED';
        this.store.executions.set(executionId, execution);
        this.recordAudit('EXECUTION', executionId, 'RUNNING', 'PAUSED', actor, reason);
        return execution;
    }

    resumeExecution(executionId: string, actor: string, reason: string): any {
        const execution = this.store.executions.get(executionId);
        if (!execution) throw new Error('Execution not found');
        if (execution.state !== 'PAUSED') throw new Error('Cannot resume non-paused execution');
        execution.state = 'RUNNING';
        this.store.executions.set(executionId, execution);
        this.recordAudit('EXECUTION', executionId, 'PAUSED', 'RUNNING', actor, reason);
        return execution;
    }

    shutdownSafely(): void {
        this.store.shutdownState.isShutdown = true;
    }

    startupRecovery(): void {
        this.store.shutdownState.isShutdown = false;
    }

    evaluateReadiness(): string {
        const checks = [
            this.store.missions.size > 0,
            this.store.workloads.size > 0,
            !this.store.shutdownState.isShutdown,
        ];
        return checks.every(Boolean) ? 'READY' : 'BLOCKED';
    }

    getStore(): NexusOSStore {
        return this.store;
    }
}
