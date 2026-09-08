import { MissionControl } from '../src/core/worker-phase96';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
    if (condition) {
        passed++;
    } else {
        failed++;
        failures.push(message);
        console.error(`FAIL: ${message}`);
    }
}

function assertThrows(fn: () => any, message: string): void {
    try {
        fn();
        failed++;
        failures.push(`Expected throw: ${message}`);
        console.error(`FAIL (no throw): ${message}`);
    } catch {
        passed++;
    }
}

// ==================== TEST SUITE ====================
function runAllTests(): void {
    console.log('Starting Phase 96 test suite...');
    const mc = new MissionControl();

    // === Mission Creation & Duplicate Prevention ===
    const missionInput = {
        organizationId: 'org1',
        projectId: 'proj1',
        environmentId: 'env1',
        objective: 'Deploy service X',
        idempotencyKey: 'unique-key-1',
        risk: 'MEDIUM',
        deadline: new Date(Date.now() + 3600000).toISOString(),
        regions: ['us-east-1'],
        fleets: ['fleet1'],
        requiredCapabilities: ['compute'],
    };
    const mission1 = mc.createMission(missionInput);
    assert(mission1.id !== undefined, 'Mission created with ID');
    assert(mission1.state === 'INTAKE', 'Initial state is INTAKE');
    const missionDuplicate = mc.createMission(missionInput);
    assert(missionDuplicate.id === mission1.id, 'Duplicate mission returns same ID');

    // === Mission Retrieval & Versioning ===
    const retrieved = mc.getMission(mission1.id);
    assert(retrieved.objective === 'Deploy service X', 'Retrieved mission has correct objective');
    const version = mc.createMissionVersion(mission1.id, 'Update');
    assert(version.version === 2, 'New version number is 2');
    const store = mc.getStore();
    const versions = store.missionVersions.get(mission1.id)!;
    assert(versions.length === 2, 'Two versions exist');
    assert(JSON.parse(versions[0].snapshot).version === 1, 'First version snapshot has version 1');

    // === Intake & Normalization ===
    mc.normalizeMission(mission1.id, 'Deploy service X');
    assert(mc.getMission(mission1.id).state === 'NORMALIZED', 'Mission normalized');
    assertThrows(() => mc.normalizeMission(mission1.id, ''), 'Ambiguous intent throws');
    const badMissionInput = { ...missionInput, idempotencyKey: 'bad1', objective: '' };
    assertThrows(() => mc.createMission(badMissionInput), 'Missing objective fails');

    // === Objectives ===
    mc.addObjective(mission1.id, { type: 'PRIMARY', description: 'Primary objective', weight: 1.0, isHard: true });
    const obj = mc.addObjective(mission1.id, { type: 'SECONDARY', description: 'Secondary', weight: 0.5, isHard: false });
    assert(obj.objective_type === 'SECONDARY', 'Objective type stored');
    mc.addSuccessCriterion(mission1.id, 'Zero downtime');
    mc.addConstraint(mission1.id, 'BUDGET', '1000');
    const constraints = Array.from(store.constraints.values()).filter(c => c.mission_id === mission1.id);
    assert(constraints.length === 1, 'Constraint added');

    // === Alignment ===
    mc.alignMission(mission1.id, 'PORTFOLIO', 'portfolio1');
    const alignments = Array.from(store.alignments.values()).filter(a => a.mission_id === mission1.id);
    assert(alignments.length === 1, 'Alignment recorded');

    // === Dependencies ===
    const depMissionInput = { ...missionInput, idempotencyKey: 'dep1', objective: 'Dependency mission' };
    const depMission = mc.createMission(depMissionInput);
    const dep = mc.addDependency(mission1.id, depMission.id);
    assert(dep.is_satisfied === 0, 'Dependency initially unsatisfied');
    assertThrows(() => mc.addDependency(depMission.id, mission1.id), 'Circular dependency throws');

    // === Priority ===
    const priority = mc.calculatePriority(mission1.id);
    assert(priority > 0, 'Priority calculated');
    assert(mc.getMission(mission1.id).priority === priority, 'Priority persisted');

    // === Strategy ===
    const strategy = mc.generateStrategy(mission1.id);
    assert(strategy.status === 'DRAFT', 'Strategy initially draft');
    mc.activateStrategy(strategy.id);
    assert(mc.getStore().strategies.get(strategy.id).status === 'ACTIVE', 'Strategy activated');

    // === Simulation ===
    const simResult = mc.simulateMission(mission1.id, strategy.id);
    assert(simResult.status === 'PREDICTED', 'Simulation result is PREDICTED');
    assert(simResult.failureProbability >= 0, 'Failure probability present');

    // === Decision ===
    const alternatives = [
        { id: 'alt1', name: 'Option A', score: 0.7 },
        { id: 'alt2', name: 'Option B', score: 0.9 },
    ];
    const decision = mc.evaluateDecision(mission1.id, strategy.id, alternatives);
    assert(decision.selected_alternative_id === 'alt2', 'Best alternative selected');

    // === Resource Allocation ===
    const allocResult = mc.allocateResources(mission1.id, { computeUnits: 10, memoryMB: 512, budget: 1000 });
    assert(allocResult.envelope.compute_units === 10, 'Envelope created');
    assert(allocResult.allocation.allocated_amount === 10, 'Allocation created');

    // === Routing ===
    const route = mc.routeMission(mission1.id, { region: 'us-east-1', providerId: 'aws', agentId: 'agent1' });
    assert(route.region === 'us-east-1', 'Route region set');

    // === Governance & Safety ===
    assert(mc.evaluateGovernance(mission1.id) === 'ALLOW', 'Governance allows');
    assert(mc.evaluateSafety(mission1.id) === 'ALLOW', 'Safety allows');

    // === Approval ===
    const approval = mc.requestApproval(mission1.id, 'DEPLOY', 'admin');
    assert(approval.status === 'REQUESTED', 'Approval requested');
    mc.grantApproval(approval.id, 'admin');
    assert(mc.getStore().approvals.get(approval.id).status === 'GRANTED', 'Approval granted');

    // === Execution Plan ===
    const plan = mc.createExecutionPlan(mission1.id, strategy.id);
    const step1 = mc.addExecutionStep(plan.id, { order: 1, type: 'DEPLOY', checkpointAfter: true });
    const step2 = mc.addExecutionStep(plan.id, { order: 2, type: 'VERIFY' });
    assert(step1.order === 1, 'Step1 order');
    assert(step2.order === 2, 'Step2 order');

    // === Dispatch ===
    const dispatchedMission = mc.dispatchMission(mission1.id, plan.id);
    assert(dispatchedMission.state === 'EXECUTING', 'Mission dispatched');

    // === Checkpoints ===
    const checkpoint = mc.checkpointMission(mission1.id, step1.id, { progress: 50 });
    assert(checkpoint.status === 'ACTIVE', 'Checkpoint created');

    // === Health ===
    assert(mc.monitorHealth(mission1.id) === 'HEALTHY', 'Health is healthy');

    // === Replanning ===
    const replan = mc.replanMission(mission1.id, 'Resource loss');
    assert(replan.mission_id === mission1.id, 'Replan created');
    assert(mc.getMission(mission1.id).state === 'REPLANNING', 'State changed to REPLANNING');

    // === Recovery & Rollback ===
    const recoveryPlan = mc.createRecoveryPlan(mission1.id);
    const rollback = mc.createRollback(mission1.id, recoveryPlan.id);
    assert(rollback.status === 'PLANNED', 'Rollback planned');

    // === Verification & Completion ===
    const verification = mc.verifyMission(mission1.id);
    assert(verification.status === 'PASSED', 'Verification passed');
    const completed = mc.completeMission(mission1.id);
    assert(completed.state === 'COMPLETED', 'Mission completed');

    // === Incidents & Escalation ===
    const incident = mc.createIncident(mission1.id, 'MISSION_FAILURE', 'HIGH', 'Test incident');
    const duplicateIncident = mc.createIncident(mission1.id, 'MISSION_FAILURE', 'HIGH', 'Test incident');
    assert(incident.id === duplicateIncident.id, 'Duplicate incident prevented');
    const escalation = mc.escalateIncident(incident.id, 'Severe');
    assert(escalation.incident_id === incident.id, 'Escalation created');

    // === Human Intervention ===
    mc.pauseMission(mission1.id, 'admin', 'Pause for maintenance');
    assert(mc.getMission(mission1.id).state === 'PAUSED', 'Mission paused');
    mc.resumeMission(mission1.id, 'admin', 'Resume');
    assert(mc.getMission(mission1.id).state === 'EXECUTING', 'Mission resumed');
    mc.cancelMission(mission1.id, 'admin', 'Cancel');
    assert(mc.getMission(mission1.id).state === 'CANCELLED', 'Mission cancelled');

    // === Circuit Breakers ===
    const breaker = mc.openCircuitBreaker('MISSION', mission1.id);
    assert(breaker.state === 'OPEN', 'Breaker open');
    assertThrows(() => mc.dispatchMission(mission1.id, plan.id), 'Dispatch blocked by open breaker');
    mc.closeCircuitBreaker(breaker.id);
    assert(mc.getStore().circuitBreakers.get(breaker.id).state === 'CLOSED', 'Breaker closed');

    // === Evidence, Audit, Lineage, Learning, Replay ===
    const evidence = mc.recordEvidence(mission1.id, 'TEST', { secret: 'password=secret', token: 'abc123' }, 'system');
    assert(!evidence.evidence_data.includes('secret'), 'Evidence redacted');
    const auditEntries = Array.from(store.audit.values()).filter(a => a.mission_id === mission1.id);
    assert(auditEntries.length > 0, 'Audit entries created');
    const lineage = mc.getLineage(mission1.id);
    assert(lineage.length > 10, 'Lineage has many nodes');
    mc.recordLearning(mission1.id, 'SUCCESS', 'Mission succeeded');
    const replay = mc.replayMission(mission1.id, mc.computeDeterministicHash(mission1.id));
    assert(replay.divergence === 0, 'Replay no divergence');

    // === Isolation ===
    const otherMissionInput = { ...missionInput, idempotencyKey: 'other1', organizationId: 'org2', projectId: 'proj2', objective: 'Other mission' };
    const otherMission = mc.createMission(otherMissionInput);
    const otherLineage = mc.getLineage(otherMission.id);
    assert(otherLineage.every(n => n.mission_id === otherMission.id), 'Lineage isolated per mission');

    // === Stress Loops ===
    for (let i = 0; i < 50; i++) {
        const m = mc.createMission({ ...missionInput, idempotencyKey: `stress-mission-${i}`, objective: `Stress ${i}` });
        assert(m.id !== undefined, `Stress mission ${i} created`);
        assert(mc.getMission(m.id).state === 'INTAKE', `Stress mission ${i} initial state`);
    }
    for (let i = 0; i < 40; i++) {
        const obj = mc.addObjective(mission1.id, { description: `Obj ${i}`, type: 'SECONDARY' });
        assert(obj.id !== undefined, `Objective ${i} added`);
    }
    for (let i = 0; i < 40; i++) {
        const s = mc.generateStrategy(mission1.id);
        assert(s.id !== undefined, `Strategy ${i} generated`);
    }
    for (let i = 0; i < 40; i++) {
        const sim = mc.simulateMission(mission1.id, strategy.id);
        assert(sim.status === 'PREDICTED', `Simulation ${i} predicted`);
    }
    for (let i = 0; i < 40; i++) {
        const alloc = mc.allocateResources(mission1.id, { computeUnits: i + 1 });
        assert(alloc.envelope.compute_units === i + 1, `Allocation ${i} correct`);
    }
    for (let i = 0; i < 40; i++) {
        const r = mc.routeMission(mission1.id, { region: `region-${i}` });
        assert(r.region === `region-${i}`, `Route ${i} region`);
    }
    for (let i = 0; i < 30; i++) {
        const r = mc.replanMission(mission1.id, `Replan ${i}`);
        assert(r.id !== undefined, `Replan ${i} created`);
    }
    for (let i = 0; i < 30; i++) {
        const h = mc.monitorHealth(mission1.id);
        assert(['HEALTHY','DEGRADED','AT_RISK','CRITICAL','BLOCKED','UNKNOWN'].includes(h), `Health ${i} valid`);
    }
    const baseHash = mc.computeDeterministicHash(mission1.id);
    for (let i = 0; i < 30; i++) {
        const r = mc.replayMission(mission1.id, baseHash);
        assert(r.divergence === 0, `Replay ${i} no divergence`);
    }
    for (let i = 0; i < 20; i++) {
        const m = mc.createMission({ ...missionInput, idempotencyKey: `iso-${i}`, organizationId: `org-iso-${i}`, projectId: `proj-iso-${i}` });
        const mLineage = mc.getLineage(m.id);
        assert(mLineage.every(n => n.mission_id === m.id), `Isolation ${i} lineage isolated`);
    }

    // === Full Lifecycle End-to-End ===
    const e2eMission = mc.createMission({
        organizationId: 'e2e-org',
        projectId: 'e2e-proj',
        environmentId: 'e2e-env',
        objective: 'End-to-end mission',
        idempotencyKey: 'e2e-key',
        risk: 'LOW',
        regions: ['e2e-region'],
        fleets: [],
        requiredCapabilities: [],
    });
    mc.normalizeMission(e2eMission.id, 'End-to-end mission');
    mc.addObjective(e2eMission.id, { type: 'PRIMARY', description: 'Complete' });
    mc.addSuccessCriterion(e2eMission.id, 'Success');
    mc.addConstraint(e2eMission.id, 'SAFETY', 'MAX_BLAST_RADIUS=1');
    mc.calculatePriority(e2eMission.id);
    const e2eStrategy = mc.generateStrategy(e2eMission.id);
    mc.activateStrategy(e2eStrategy.id);
    mc.simulateMission(e2eMission.id, e2eStrategy.id);
    mc.evaluateDecision(e2eMission.id, e2eStrategy.id, [{ id: 'a', score: 1 }]);
    mc.allocateResources(e2eMission.id, { computeUnits: 1 });
    mc.routeMission(e2eMission.id, { region: 'e2e-region' });
    mc.evaluateGovernance(e2eMission.id);
    mc.evaluateSafety(e2eMission.id);
    const e2eApproval = mc.requestApproval(e2eMission.id, 'EXECUTE', 'admin');
    mc.grantApproval(e2eApproval.id, 'admin');
    const e2ePlan = mc.createExecutionPlan(e2eMission.id, e2eStrategy.id);
    const e2eStep = mc.addExecutionStep(e2ePlan.id, { order: 1, type: 'EXECUTE' });
    mc.dispatchMission(e2eMission.id, e2ePlan.id);
    mc.checkpointMission(e2eMission.id, e2eStep.id, { progress: 100 });
    mc.verifyMission(e2eMission.id);
    mc.completeMission(e2eMission.id);
    const e2eLineage = mc.getLineage(e2eMission.id);
    const requiredNodeTypes = ['MISSION', 'OBJECTIVE', 'SUCCESS_CRITERION', 'CONSTRAINT', 'PRIORITY', 'STRATEGY', 'SIMULATION', 'DECISION', 'RESOURCE_ENVELOPE', 'ROUTE', 'GOVERNANCE', 'SAFETY', 'APPROVAL', 'EXECUTION_PLAN', 'CHECKPOINT', 'VERIFICATION'];
    for (const nodeType of requiredNodeTypes) {
        assert(e2eLineage.some(n => n.node_type === nodeType), `Lineage contains ${nodeType}`);
    }

    console.log('----------------------------------------');
    console.log(`Phase 96 test suite completed.`);
    console.log(`Total tests: ${passed + failed}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    if (failed > 0) {
        console.error('Failures:');
        failures.forEach(f => console.error(`- ${f}`));
        process.exit(1);
    } else {
        console.log('All tests PASSED.');
        process.exit(0);
    }
}

runAllTests();
