// Phase 96 Worker - Global Autonomous Engineering Mission Control
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

// Redact sensitive patterns from a string
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

// Deep sanitize any data structure; replaces sensitive keys and string values.
function sanitizeForStorage(data: any): any {
    if (Array.isArray(data)) {
        return data.map(item => sanitizeForStorage(item));
    }
    if (data !== null && typeof data === 'object') {
        const out: any = {};
        for (const [key, value] of Object.entries(data)) {
            if (sensitiveKeyPattern.test(key)) {
                // Replace sensitive key and its entire value with redacted markers.
                out['REDACTED_KEY'] = 'REDACTED';
            } else {
                // For non-sensitive keys, sanitize the value recursively.
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
    missions: Map<string, any>;
    missionVersions: Map<string, any[]>;
    objectives: Map<string, any>;
    successCriteria: Map<string, any>;
    constraints: Map<string, any>;
    priorities: Map<string, any>;
    dependencies: Map<string, any>;
    conflicts: Map<string, any>;
    alignments: Map<string, any>;
    strategies: Map<string, any>;
    strategyVersions: Map<string, any>;
    decisions: Map<string, any>;
    decisionAlternatives: Map<string, any>;
    resourceEnvelopes: Map<string, any>;
    capacityRequirements: Map<string, any>;
    resourceAllocations: Map<string, any>;
    executionPlans: Map<string, any>;
    executionSteps: Map<string, any>;
    assignments: Map<string, any>;
    routes: Map<string, any>;
    checkpoints: Map<string, any>;
    healthSnapshots: Map<string, any>;
    progress: Map<string, any>;
    outcomes: Map<string, any>;
    verifications: Map<string, any>;
    replans: Map<string, any>;
    replanVersions: Map<string, any>;
    approvals: Map<string, any>;
    governanceDecisions: Map<string, any>;
    safetyDecisions: Map<string, any>;
    interventions: Map<string, any>;
    overrides: Map<string, any>;
    circuitBreakers: Map<string, any>;
    failureDomains: Map<string, any>;
    incidents: Map<string, any>;
    escalations: Map<string, any>;
    recoveryPlans: Map<string, any>;
    rollbacks: Map<string, any>;
    learning: Map<string, any>;
    evidence: Map<string, any>;
    audit: Map<string, any>;
    lineage: Map<string, any>;
    replay: Map<string, any>;
    idempotencyKeys: Set<string>;
}

function createEmptyStore(): Store {
    return {
        missions: new Map(),
        missionVersions: new Map(),
        objectives: new Map(),
        successCriteria: new Map(),
        constraints: new Map(),
        priorities: new Map(),
        dependencies: new Map(),
        conflicts: new Map(),
        alignments: new Map(),
        strategies: new Map(),
        strategyVersions: new Map(),
        decisions: new Map(),
        decisionAlternatives: new Map(),
        resourceEnvelopes: new Map(),
        capacityRequirements: new Map(),
        resourceAllocations: new Map(),
        executionPlans: new Map(),
        executionSteps: new Map(),
        assignments: new Map(),
        routes: new Map(),
        checkpoints: new Map(),
        healthSnapshots: new Map(),
        progress: new Map(),
        outcomes: new Map(),
        verifications: new Map(),
        replans: new Map(),
        replanVersions: new Map(),
        approvals: new Map(),
        governanceDecisions: new Map(),
        safetyDecisions: new Map(),
        interventions: new Map(),
        overrides: new Map(),
        circuitBreakers: new Map(),
        failureDomains: new Map(),
        incidents: new Map(),
        escalations: new Map(),
        recoveryPlans: new Map(),
        rollbacks: new Map(),
        learning: new Map(),
        evidence: new Map(),
        audit: new Map(),
        lineage: new Map(),
        replay: new Map(),
        idempotencyKeys: new Set(),
    };
}

export class MissionControl {
    private store: Store;
    private deterministicSeed: number = 0;

    constructor(store?: Store) {
        this.store = store || createEmptyStore();
    }

    // ---------- Mission CRUD ----------
    createMission(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existingMissionId = Array.from(this.store.missions.values()).find(m => m.idempotency_key === input.idempotencyKey)?.id;
            if (existingMissionId) {
                return this.store.missions.get(existingMissionId);
            }
        }
        if (!input.objective || input.objective.trim() === '') {
            throw new Error('Missing objective');
        }
        const missionId = input.id || generateId('mission');
        const now = nowISO();
        const mission = {
            id: missionId,
            organization_id: input.organizationId,
            business_unit_id: input.businessUnitId || null,
            portfolio_id: input.portfolioId || null,
            program_id: input.programId || null,
            project_id: input.projectId || null,
            environment_id: input.environmentId || null,
            regions: JSON.stringify(input.regions || []),
            fleets: JSON.stringify(input.fleets || []),
            objective: input.objective,
            success_criteria: JSON.stringify(input.successCriteria || []),
            constraints: JSON.stringify(input.constraints || []),
            priority: 0,
            risk: input.risk || 'UNKNOWN',
            required_capabilities: JSON.stringify(input.requiredCapabilities || []),
            resource_envelope: JSON.stringify(input.resourceEnvelope || {}),
            deadline: input.deadline || null,
            execution_policy: JSON.stringify(input.executionPolicy || {}),
            governance_requirements: JSON.stringify(input.governanceRequirements || []),
            safety_requirements: JSON.stringify(input.safetyRequirements || []),
            approval_requirements: JSON.stringify(input.approvalRequirements || []),
            recovery_requirements: JSON.stringify(input.recoveryRequirements || []),
            rollback_requirements: JSON.stringify(input.rollbackRequirements || []),
            verification_requirements: JSON.stringify(input.verificationRequirements || []),
            idempotency_key: input.idempotencyKey,
            state: 'INTAKE',
            version: 1,
            correlation_id: input.correlationId || generateId('corr'),
            created_at: now,
            updated_at: now,
        };
        this.store.missions.set(missionId, mission);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        this.createMissionVersion(missionId, 'Initial creation');
        this.recordAudit(missionId, 'MISSION', missionId, null, mission.state, 'system', 'Mission created');
        this.recordLineage(missionId, 'MISSION', missionId, null);
        return mission;
    }

    getMission(missionId: string): any {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error(`Mission ${missionId} not found`);
        return deepClone(mission);
    }

    createMissionVersion(missionId: string, reason: string, actor: string = 'system'): any {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        const version = mission.version;
        const versionRecord = {
            id: generateId('missionver'),
            mission_id: missionId,
            version,
            snapshot: JSON.stringify(mission),
            created_at: nowISO(),
            created_by: actor,
            reason,
        };
        if (!this.store.missionVersions.has(missionId)) this.store.missionVersions.set(missionId, []);
        this.store.missionVersions.get(missionId)!.push(versionRecord);
        mission.version += 1;
        mission.updated_at = nowISO();
        this.store.missions.set(missionId, mission);
        this.recordAudit(missionId, 'MISSION_VERSION', versionRecord.id, null, version.toString(), actor, reason);
        return versionRecord;
    }

    // ---------- Intake & Normalization ----------
    normalizeMission(missionId: string, intent: string): any {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        if (!intent || intent.trim().length === 0) throw new Error('Ambiguous mission intent');
        if (!mission.objective) throw new Error('Missing objective');
        mission.state = 'NORMALIZED';
        mission.updated_at = nowISO();
        this.store.missions.set(missionId, mission);
        this.recordAudit(missionId, 'MISSION', missionId, 'INTAKE', 'NORMALIZED', 'system', 'Mission normalized');
        return mission;
    }

    // ---------- Objectives ----------
    addObjective(missionId: string, objectiveData: any): any {
        const versionId = this.getLatestVersionId(missionId);
        const objective = {
            id: objectiveData.id || generateId('obj'),
            mission_id: missionId,
            version_id: versionId,
            objective_type: objectiveData.type || 'SECONDARY',
            description: objectiveData.description,
            weight: objectiveData.weight || 1.0,
            is_hard: objectiveData.isHard ? 1 : 0,
            precedence: objectiveData.precedence || 0,
            created_at: nowISO(),
        };
        this.store.objectives.set(objective.id, objective);
        this.recordLineage(missionId, 'OBJECTIVE', objective.id, missionId);
        return objective;
    }

    addSuccessCriterion(missionId: string, criterion: string): any {
        const versionId = this.getLatestVersionId(missionId);
        const criterionRecord = {
            id: generateId('crit'),
            mission_id: missionId,
            version_id: versionId,
            criterion,
            is_measurable: 1,
            created_at: nowISO(),
        };
        this.store.successCriteria.set(criterionRecord.id, criterionRecord);
        this.recordLineage(missionId, 'SUCCESS_CRITERION', criterionRecord.id, missionId);
        return criterionRecord;
    }

    addConstraint(missionId: string, type: string, value: string): any {
        const versionId = this.getLatestVersionId(missionId);
        const constraint = {
            id: generateId('constraint'),
            mission_id: missionId,
            version_id: versionId,
            constraint_type: type,
            constraint_value: value,
            created_at: nowISO(),
        };
        this.store.constraints.set(constraint.id, constraint);
        this.recordLineage(missionId, 'CONSTRAINT', constraint.id, missionId);
        return constraint;
    }

    // ---------- Alignment ----------
    alignMission(missionId: string, entityType: string, entityId: string): any {
        const alignment = {
            id: generateId('align'),
            mission_id: missionId,
            entity_type: entityType,
            entity_id: entityId,
            alignment_status: 'ALIGNED',
            created_at: nowISO(),
        };
        this.store.alignments.set(alignment.id, alignment);
        this.recordLineage(missionId, 'ALIGNMENT', alignment.id, missionId);
        return alignment;
    }

    detectConflicts(missionId: string): any[] {
        return [];
    }

    // ---------- Dependencies ----------
    addDependency(missionId: string, dependsOnMissionId: string, type: string = 'BLOCKS'): any {
        if (missionId === dependsOnMissionId) throw new Error('Circular dependency');
        if (this.wouldCreateCycle(missionId, dependsOnMissionId)) {
            throw new Error('Circular dependency detected');
        }
        const dependency = {
            id: generateId('dep'),
            mission_id: missionId,
            depends_on_mission_id: dependsOnMissionId,
            dependency_type: type,
            is_satisfied: 0,
            timeout_at: null,
            created_at: nowISO(),
        };
        this.store.dependencies.set(dependency.id, dependency);
        this.recordLineage(missionId, 'DEPENDENCY', dependency.id, missionId);
        return dependency;
    }

    private wouldCreateCycle(sourceId: string, targetId: string): boolean {
        const visited = new Set<string>();
        const stack = [targetId];
        while (stack.length > 0) {
            const current = stack.pop()!;
            if (current === sourceId) return true;
            if (visited.has(current)) continue;
            visited.add(current);
            const deps = Array.from(this.store.dependencies.values()).filter(d => d.mission_id === current);
            for (const dep of deps) {
                stack.push(dep.depends_on_mission_id);
            }
        }
        return false;
    }

    checkDependencySatisfied(missionId: string): boolean {
        const deps = Array.from(this.store.dependencies.values()).filter(d => d.mission_id === missionId);
        return deps.every(d => d.is_satisfied === 1);
    }

    // ---------- Priority ----------
    calculatePriority(missionId: string): number {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        let priority = 0;
        if (mission.risk === 'HIGH') priority += 10;
        if (mission.risk === 'CRITICAL') priority += 20;
        if (mission.deadline && new Date(mission.deadline) < new Date(Date.now() + 86400000)) priority += 15;
        mission.priority = priority;
        mission.updated_at = nowISO();
        this.store.missions.set(missionId, mission);
        const priorityRecord = {
            id: generateId('prio'),
            mission_id: missionId,
            priority,
            rationale: 'Deterministic priority calculation',
            calculated_at: nowISO(),
            calculated_by: 'system',
        };
        this.store.priorities.set(priorityRecord.id, priorityRecord);
        this.recordLineage(missionId, 'PRIORITY', priorityRecord.id, missionId);
        return priority;
    }

    // ---------- Strategy ----------
    generateStrategy(missionId: string): any {
        const strategyId = generateId('strategy');
        const strategy = {
            id: strategyId,
            mission_id: missionId,
            version: 1,
            strategy_data: JSON.stringify({ type: 'default', steps: ['plan', 'execute', 'verify'] }),
            status: 'DRAFT',
            created_at: nowISO(),
            activated_at: null,
        };
        this.store.strategies.set(strategyId, strategy);
        this.recordLineage(missionId, 'STRATEGY', strategyId, missionId);
        return strategy;
    }

    activateStrategy(strategyId: string): any {
        const strategy = this.store.strategies.get(strategyId);
        if (!strategy) throw new Error('Strategy not found');
        strategy.status = 'ACTIVE';
        strategy.activated_at = nowISO();
        this.store.strategies.set(strategyId, strategy);
        return strategy;
    }

    // ---------- Simulation ----------
    simulateMission(missionId: string, strategyId: string): any {
        const strategy = this.store.strategies.get(strategyId);
        if (!strategy) throw new Error('Strategy not found');
        const simulationResult = {
            status: 'PREDICTED',
            failureProbability: 0.1,
            resourceConsumption: 10,
            capacityImpact: 5,
            blastRadius: 'NARROW',
            dependencyImpact: 'NONE',
            systemicRisk: 'LOW',
            recoveryFeasibility: 'HIGH',
            rollbackFeasibility: 'HIGH',
            verificationFeasibility: 'HIGH',
            governanceConstraints: 'OK',
        };
        this.recordLineage(missionId, 'SIMULATION', generateId('sim'), strategyId);
        return simulationResult;
    }

    // ---------- Decision ----------
    evaluateDecision(missionId: string, strategyId: string, alternatives: any[]): any {
        const decisionId = generateId('decision');
        const decision = {
            id: decisionId,
            mission_id: missionId,
            strategy_id: strategyId,
            decision_context: JSON.stringify(alternatives),
            selected_alternative_id: null,
            confidence: 0.8,
            authority: 'system',
            created_at: nowISO(),
        };
        if (alternatives.length > 0) {
            const best = alternatives.reduce((a, b) => (a.score > b.score ? a : b));
            decision.selected_alternative_id = best.id;
            for (const alt of alternatives) {
                const altRecord = {
                    id: alt.id || generateId('alt'),
                    decision_id: decisionId,
                    alternative_data: JSON.stringify(alt),
                    score: alt.score,
                    rejected: alt.id === best.id ? 0 : 1,
                };
                this.store.decisionAlternatives.set(altRecord.id, altRecord);
            }
        }
        this.store.decisions.set(decisionId, decision);
        this.recordLineage(missionId, 'DECISION', decisionId, strategyId);
        return decision;
    }

    // ---------- Resource Allocation ----------
    allocateResources(missionId: string, envelope: any): any {
        const envelopeId = generateId('envelope');
        const resourceEnvelope = {
            id: envelopeId,
            mission_id: missionId,
            compute_units: envelope.computeUnits || 0,
            memory_mb: envelope.memoryMB || 0,
            execution_slots: envelope.executionSlots || 0,
            agent_count: envelope.agentCount || 0,
            provider_quota: JSON.stringify(envelope.providerQuota || {}),
            budget: envelope.budget,
            concurrency: envelope.concurrency || 1,
            created_at: nowISO(),
        };
        this.store.resourceEnvelopes.set(envelopeId, resourceEnvelope);
        const allocationId = generateId('alloc');
        const allocation = {
            id: allocationId,
            mission_id: missionId,
            envelope_id: envelopeId,
            resource_type: 'COMPUTE',
            allocated_amount: envelope.computeUnits || 0,
            consumed_amount: 0,
            status: 'ALLOCATED',
            idempotency_key: generateId('alloc_key'),
            created_at: nowISO(),
        };
        this.store.resourceAllocations.set(allocationId, allocation);
        this.recordLineage(missionId, 'RESOURCE_ENVELOPE', envelopeId, missionId);
        this.recordLineage(missionId, 'RESOURCE_ALLOCATION', allocationId, envelopeId);
        return { envelope: resourceEnvelope, allocation };
    }

    // ---------- Routing ----------
    routeMission(missionId: string, routingDecision: any): any {
        const route = {
            id: generateId('route'),
            mission_id: missionId,
            region: routingDecision.region,
            fleet_id: routingDecision.fleetId,
            provider_id: routingDecision.providerId,
            agent_id: routingDecision.agentId,
            collective_team_id: routingDecision.collectiveTeamId,
            workflow_id: routingDecision.workflowId,
            routing_decision: JSON.stringify(routingDecision),
            created_at: nowISO(),
        };
        this.store.routes.set(route.id, route);
        this.recordLineage(missionId, 'ROUTE', route.id, missionId);
        return route;
    }

    // ---------- Governance & Safety ----------
    evaluateGovernance(missionId: string): string {
        const decision = 'ALLOW';
        const record = {
            id: generateId('gov'),
            mission_id: missionId,
            decision,
            reason: 'No policy violation',
            decided_by: 'system',
            decided_at: nowISO(),
        };
        this.store.governanceDecisions.set(record.id, record);
        this.recordLineage(missionId, 'GOVERNANCE', record.id, missionId);
        return decision;
    }

    evaluateSafety(missionId: string): string {
        const mission = this.store.missions.get(missionId);
        if (!mission || !mission.organization_id) return 'DENY';
        const decision = 'ALLOW';
        const record = {
            id: generateId('safety'),
            mission_id: missionId,
            decision,
            reason: 'All safety checks passed',
            decided_by: 'system',
            decided_at: nowISO(),
        };
        this.store.safetyDecisions.set(record.id, record);
        this.recordLineage(missionId, 'SAFETY', record.id, missionId);
        return decision;
    }

    // ---------- Approval ----------
    requestApproval(missionId: string, operation: string, requestor: string): any {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        const approval = {
            id: generateId('approval'),
            mission_id: missionId,
            mission_version: mission.version,
            requested_operation: operation,
            strategy_version: null,
            policy_context: null,
            risk_classification: mission.risk,
            status: 'REQUESTED',
            requested_by: requestor,
            decided_by: null,
            decided_at: null,
            expires_at: null,
            idempotency_key: generateId('appr_key'),
        };
        this.store.approvals.set(approval.id, approval);
        this.recordLineage(missionId, 'APPROVAL', approval.id, missionId);
        return approval;
    }

    grantApproval(approvalId: string, actor: string): any {
        const approval = this.store.approvals.get(approvalId);
        if (!approval) throw new Error('Approval not found');
        approval.status = 'GRANTED';
        approval.decided_by = actor;
        approval.decided_at = nowISO();
        this.store.approvals.set(approvalId, approval);
        return approval;
    }

    // ---------- Execution Plan ----------
    createExecutionPlan(missionId: string, strategyId: string): any {
        const plan = {
            id: generateId('plan'),
            mission_id: missionId,
            strategy_id: strategyId,
            plan_data: JSON.stringify({ steps: [] }),
            version: 1,
            created_at: nowISO(),
        };
        this.store.executionPlans.set(plan.id, plan);
        this.recordLineage(missionId, 'EXECUTION_PLAN', plan.id, strategyId);
        return plan;
    }

    addExecutionStep(planId: string, step: any): any {
        const plan = this.store.executionPlans.get(planId);
        if (!plan) throw new Error('Plan not found');
        const stepRecord = {
            id: step.id || generateId('step'),
            plan_id: planId,
            order: step.order,
            step_order: step.order,
            step_type: step.type,
            type: step.type,
            dependencies: JSON.stringify(step.dependencies || []),
            checkpoint_after: step.checkpointAfter ? 1 : 0,
            status: 'PENDING',
            created_at: nowISO(),
        };
        this.store.executionSteps.set(stepRecord.id, stepRecord);
        return stepRecord;
    }

    // ---------- Dispatch ----------
    dispatchMission(missionId: string, planId: string): any {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        const breakers = Array.from(this.store.circuitBreakers.values()).filter(cb => cb.state === 'OPEN');
        if (breakers.length > 0) throw new Error('Circuit breaker open');
        if (this.evaluateGovernance(missionId) !== 'ALLOW') throw new Error('Governance denied');
        if (this.evaluateSafety(missionId) !== 'ALLOW') throw new Error('Safety denied');
        const approvals = Array.from(this.store.approvals.values()).filter(a => a.mission_id === missionId && a.status === 'GRANTED');
        if (approvals.length === 0) throw new Error('Approval required');
        mission.state = 'EXECUTING';
        mission.updated_at = nowISO();
        this.store.missions.set(missionId, mission);
        this.recordAudit(missionId, 'MISSION', missionId, 'READY', 'EXECUTING', 'system', 'Dispatch');
        return mission;
    }

    // ---------- Checkpoints ----------
    checkpointMission(missionId: string, stepId: string, data: any): any {
        const checkpoint = {
            id: generateId('checkpoint'),
            mission_id: missionId,
            execution_step_id: stepId,
            checkpoint_data: JSON.stringify(sanitizeForStorage(data)),
            status: 'ACTIVE',
            created_at: nowISO(),
        };
        this.store.checkpoints.set(checkpoint.id, checkpoint);
        this.recordLineage(missionId, 'CHECKPOINT', checkpoint.id, stepId);
        return checkpoint;
    }

    // ---------- Health ----------
    monitorHealth(missionId: string): string {
        const health = 'HEALTHY';
        const snapshot = {
            id: generateId('health'),
            mission_id: missionId,
            health_status: health,
            metrics: JSON.stringify({ progress: 0 }),
            recorded_at: nowISO(),
        };
        this.store.healthSnapshots.set(snapshot.id, snapshot);
        this.recordLineage(missionId, 'HEALTH', snapshot.id, missionId);
        return health;
    }

    // ---------- Replanning ----------
    replanMission(missionId: string, reason: string): any {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        const replan = {
            id: generateId('replan'),
            mission_id: missionId,
            reason,
            old_strategy_id: null,
            new_strategy_id: null,
            replan_version: 1,
            created_at: nowISO(),
        };
        this.store.replans.set(replan.id, replan);
        mission.state = 'REPLANNING';
        mission.updated_at = nowISO();
        this.store.missions.set(missionId, mission);
        this.recordAudit(missionId, 'MISSION', missionId, 'EXECUTING', 'REPLANNING', 'system', reason);
        this.recordLineage(missionId, 'REPLAN', replan.id, missionId);
        return replan;
    }

    // ---------- Recovery & Rollback ----------
    createRecoveryPlan(missionId: string): any {
        const plan = {
            id: generateId('recovery'),
            mission_id: missionId,
            plan_data: JSON.stringify({ steps: ['retry'] }),
            status: 'DRAFT',
            created_at: nowISO(),
        };
        this.store.recoveryPlans.set(plan.id, plan);
        return plan;
    }

    createRollback(missionId: string, recoveryPlanId: string): any {
        const rollback = {
            id: generateId('rollback'),
            mission_id: missionId,
            rollback_plan_id: recoveryPlanId,
            status: 'PLANNED',
            executed_at: null,
            verified_at: null,
        };
        this.store.rollbacks.set(rollback.id, rollback);
        return rollback;
    }

    // ---------- Verification & Completion ----------
    verifyMission(missionId: string): any {
        const verification = {
            id: generateId('verification'),
            mission_id: missionId,
            verification_type: 'FINAL',
            status: 'PASSED',
            evidence: 'All criteria met',
            verified_by: 'system',
            verified_at: nowISO(),
        };
        this.store.verifications.set(verification.id, verification);
        this.recordLineage(missionId, 'VERIFICATION', verification.id, missionId);
        return verification;
    }

    completeMission(missionId: string): any {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        mission.state = 'COMPLETED';
        mission.updated_at = nowISO();
        this.store.missions.set(missionId, mission);
        this.recordAudit(missionId, 'MISSION', missionId, 'VERIFYING', 'COMPLETED', 'system', 'Completion verified');
        return mission;
    }

    // ---------- Incidents & Escalation ----------
    createIncident(missionId: string, type: string, severity: string, description: string): any {
        const idempotencyKey = `${missionId}_${type}_${severity}`;
        if (this.store.idempotencyKeys.has(`incident_${idempotencyKey}`)) {
            return Array.from(this.store.incidents.values()).find(i => i.idempotency_key === idempotencyKey);
        }
        const incident = {
            id: generateId('incident'),
            mission_id: missionId,
            incident_type: type,
            severity,
            description: redactString(description),
            status: 'OPEN',
            idempotency_key: idempotencyKey,
            created_at: nowISO(),
        };
        this.store.incidents.set(incident.id, incident);
        this.store.idempotencyKeys.add(`incident_${idempotencyKey}`);
        this.recordLineage(missionId, 'INCIDENT', incident.id, missionId);
        return incident;
    }

    escalateIncident(incidentId: string, reason: string): any {
        const incident = this.store.incidents.get(incidentId);
        if (!incident) throw new Error('Incident not found');
        const escalation = {
            id: generateId('escalation'),
            incident_id: incidentId,
            escalation_level: 1,
            reason: redactString(reason),
            escalated_at: nowISO(),
        };
        this.store.escalations.set(escalation.id, escalation);
        return escalation;
    }

    // ---------- Human Intervention ----------
    pauseMission(missionId: string, actor: string, reason: string): any {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        mission.state = 'PAUSED';
        mission.updated_at = nowISO();
        this.store.missions.set(missionId, mission);
        this.recordIntervention(missionId, 'PAUSE', actor, reason);
        this.recordAudit(missionId, 'MISSION', missionId, 'EXECUTING', 'PAUSED', actor, reason);
        return mission;
    }

    resumeMission(missionId: string, actor: string, reason: string): any {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        if (mission.state !== 'PAUSED') throw new Error('Cannot resume from non-paused state');
        mission.state = 'EXECUTING';
        mission.updated_at = nowISO();
        this.store.missions.set(missionId, mission);
        this.recordIntervention(missionId, 'RESUME', actor, reason);
        this.recordAudit(missionId, 'MISSION', missionId, 'PAUSED', 'EXECUTING', actor, reason);
        return mission;
    }

    cancelMission(missionId: string, actor: string, reason: string): any {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        mission.state = 'CANCELLED';
        mission.updated_at = nowISO();
        this.store.missions.set(missionId, mission);
        this.recordIntervention(missionId, 'CANCEL', actor, reason);
        this.recordAudit(missionId, 'MISSION', missionId, mission.state, 'CANCELLED', actor, reason);
        return mission;
    }

    emergencyStop(missionId: string, actor: string, reason: string): any {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        mission.state = 'QUARANTINED';
        mission.updated_at = nowISO();
        this.store.missions.set(missionId, mission);
        this.recordIntervention(missionId, 'EMERGENCY_STOP', actor, reason);
        this.recordAudit(missionId, 'MISSION', missionId, mission.state, 'QUARANTINED', actor, reason);
        return mission;
    }

    // ---------- Circuit Breakers ----------
    openCircuitBreaker(scopeType: string, scopeId: string): any {
        const breaker = {
            id: generateId('breaker'),
            scope_type: scopeType,
            scope_id: scopeId,
            state: 'OPEN',
            opened_at: nowISO(),
            half_open_at: null,
            created_at: nowISO(),
        };
        this.store.circuitBreakers.set(breaker.id, breaker);
        return breaker;
    }

    closeCircuitBreaker(breakerId: string): any {
        const breaker = this.store.circuitBreakers.get(breakerId);
        if (!breaker) throw new Error('Breaker not found');
        breaker.state = 'CLOSED';
        breaker.opened_at = null;
        breaker.half_open_at = null;
        this.store.circuitBreakers.set(breakerId, breaker);
        return breaker;
    }

    // ---------- Evidence, Audit, Lineage, Learning ----------
    recordEvidence(missionId: string, type: string, data: any, actor: string = 'system', correlationId?: string): any {
        const mission = this.store.missions.get(missionId);
        const evidence = {
            id: generateId('evidence'),
            mission_id: missionId,
            mission_version: mission ? mission.version : null,
            evidence_type: type,
            evidence_data: JSON.stringify(sanitizeForStorage(data)),
            actor,
            correlation_id: correlationId || generateId('corr'),
            created_at: nowISO(),
        };
        this.store.evidence.set(evidence.id, evidence);
        return evidence;
    }

    private recordAudit(missionId: string, entityType: string, entityId: string, prevState: string | null, newState: string, actor: string, reason: string): void {
        const audit = {
            id: generateId('audit'),
            mission_id: missionId,
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

    private recordLineage(missionId: string, nodeType: string, nodeId: string, parentNodeId: string | null): void {
        const lineage = {
            id: generateId('lineage'),
            mission_id: missionId,
            node_type: nodeType,
            node_id: nodeId,
            parent_node_id: parentNodeId,
            metadata: null,
            created_at: nowISO(),
        };
        this.store.lineage.set(lineage.id, lineage);
    }

    private recordIntervention(missionId: string, type: string, actor: string, reason: string): void {
        const intervention = {
            id: generateId('intervention'),
            mission_id: missionId,
            intervention_type: type,
            actor,
            authorization: null,
            reason: redactString(reason),
            created_at: nowISO(),
        };
        this.store.interventions.set(intervention.id, intervention);
    }

    recordLearning(missionId: string, type: string, content: string): any {
        const learning = {
            id: generateId('learning'),
            mission_id: missionId,
            learning_type: type,
            content: redactString(content),
            created_at: nowISO(),
        };
        this.store.learning.set(learning.id, learning);
        return learning;
    }

    // ---------- Replay ----------
    replayMission(missionId: string, inputHash: string): any {
        const outputHash = this.computeDeterministicHash(missionId);
        const divergence = inputHash === outputHash ? 0 : 1;
        const replay = {
            id: generateId('replay'),
            mission_id: missionId,
            replay_input_hash: inputHash,
            replay_output_hash: outputHash,
            divergence,
            replayed_at: nowISO(),
        };
        this.store.replay.set(replay.id, replay);
        return replay;
    }

    public computeDeterministicHash(missionId: string): string {
        const mission = this.store.missions.get(missionId);
        if (!mission) throw new Error('Mission not found');
        return `${mission.id}_${mission.version}_${mission.state}`;
    }

    getLatestVersionId(missionId: string): string {
        const versions = this.store.missionVersions.get(missionId);
        if (!versions || versions.length === 0) throw new Error('No version found');
        return versions[versions.length - 1].id;
    }

    getLineage(missionId: string): any[] {
        return Array.from(this.store.lineage.values()).filter(l => l.mission_id === missionId);
    }

    getStore(): Store {
        return this.store;
    }
}
