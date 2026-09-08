import { NexusOS } from '../src/core/worker-phase100';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
    if (condition) { passed++; } else { failed++; failures.push(message); console.error(`FAIL: ${message}`); }
}
function assertThrows(fn: () => any, message: string): void {
    try { fn(); failed++; failures.push(`Expected throw: ${message}`); console.error(`FAIL (no throw): ${message}`); } catch { passed++; }
}

// ==================== TEST SUITE ====================
function runAllTests(): void {
    console.log('Starting Phase 100 test suite...');
    const os = new NexusOS();

    // === Basic Lifecycle ===
    const intent = os.ingestIntent({ description: 'Build feature X', organizationId: 'org1', idempotencyKey: 'intent1' });
    assert(intent.state === 'RECEIVED', 'Intent received');
    const intentDup = os.ingestIntent({ description: 'Build feature X', organizationId: 'org1', idempotencyKey: 'intent1' });
    assert(intentDup.id === intent.id, 'Duplicate intent prevented');

    const mission = os.createMission({ intentId: intent.id, organizationId: 'org1', description: 'Mission for feature X', idempotencyKey: 'mission1' });
    assert(mission.state === 'CREATED', 'Mission created');
    const missionDup = os.createMission({ intentId: intent.id, organizationId: 'org1', description: 'Mission for feature X', idempotencyKey: 'mission1' });
    assert(missionDup.id === mission.id, 'Duplicate mission prevented');

    os.planMission(mission.id);
    assert(os.getStore().missions.get(mission.id).state === 'PLANNED', 'Mission planned');

    const strategy = os.evaluateStrategy(mission.id);
    assert(strategy.id !== undefined, 'Strategy generated');
    const team = os.composeAgentTeam(mission.id);
    assert(team.id !== undefined, 'Team composed');
    const risk = os.evaluateRisk(mission.id);
    assert(risk.level === 'LOW', 'Risk evaluated');

    const govDecision = os.evaluateGovernance(mission.id);
    assert(govDecision === 'ALLOW', 'Governance allows');
    const safetyDecision = os.evaluateSafety(mission.id);
    assert(safetyDecision === 'ALLOW', 'Safety allows');

    const approval = os.requestApproval(mission.id, 'user1');
    assert(approval.state === 'REQUESTED', 'Approval requested');
    os.approveApproval(approval.id, 'approver1');
    assert(os.getStore().approvals.get(approval.id).state === 'APPROVED', 'Approval approved');

    const resource = os.allocateResources(mission.id, 'CPU', 100);
    assert(resource.amount === 100, 'Resource allocated');
    const reservation = os.reserveResource(resource.id, mission.id, 'resv1');
    assert(reservation.state === 'ACTIVE', 'Reservation active');

    const workload = os.scheduleWorkload(mission.id);
    assert(workload.state === 'SCHEDULED', 'Workload scheduled');
    os.dispatchWorkload(workload.id);
    assert(os.getStore().workloads.get(workload.id).state === 'DISPATCHED', 'Workload dispatched');
    const execution = os.executeWorkload(workload.id);
    assert(execution.state === 'RUNNING', 'Execution started');

    const obs = os.observe(execution.id, 'CPU', 85);
    assert(obs.value === 85, 'Observation recorded');
    const diag = os.diagnose(execution.id, 'HIGH_LOAD');
    assert(diag.cause === 'HIGH_LOAD', 'Diagnosis made');
    const rem = os.remediate(diag.id, 'RESTART');
    assert(rem.state === 'EXECUTED', 'Remediation executed');
    const ver = os.verify(execution.id, 'VERIFIED');
    assert(ver.status === 'VERIFIED', 'Verification passed');

    const rec = os.recover(execution.id);
    assert(rec.state === 'RECOVERED', 'Recovery completed');
    const rb = os.rollback(execution.id);
    assert(rb.state === 'ROLLED_BACK', 'Rollback completed');

    const incident = os.createIncident('EXECUTION', execution.id, 'FAILURE', 'HIGH');
    assert(incident.state === 'OPEN', 'Incident created');
    const incidentDup = os.createIncident('EXECUTION', execution.id, 'FAILURE', 'HIGH');
    assert(incidentDup.id === incident.id, 'Duplicate incident prevented');

    const evidence = os.generateEvidence('EXECUTION', execution.id, 'RESULT', { secret: 'password=test' });
    assert(!evidence.data.includes('password'), 'Evidence redacted');

    const lineage = os.queryLineage('MISSION', mission.id);
    assert(lineage.length > 0, 'Lineage populated');

    os.recordLearning('MISSION', mission.id, 'LIFECYCLE', 'Completed successfully');
    os.recordDecisionMemory('decision1', { outcome: 'SUCCESS' });

    const hash = os.computeDeterministicHash('MISSION', mission.id);
    const replay = os.replayDecision('MISSION', mission.id, hash);
    assert(replay.divergence === 0, 'Replay no divergence');
    const replayDiv = os.replayDecision('MISSION', mission.id, 'wronghash');
    assert(replayDiv.divergence === 1, 'Replay divergence detected');

    // === Failure Containment ===
    const projectA = os.createMission({ intentId: intent.id, organizationId: 'orgA', description: 'Project A mission', idempotencyKey: 'missionA' });
    const projectB = os.createMission({ intentId: intent.id, organizationId: 'orgB', description: 'Project B mission', idempotencyKey: 'missionB' });
    assert(projectA.id !== projectB.id, 'Different projects have different missions');
    const lineageA = os.queryLineage('MISSION', projectA.id);
    const lineageB = os.queryLineage('MISSION', projectB.id);
    assert(lineageA.every(n => n.entity_id === projectA.id), 'Lineage isolated for A');
    assert(lineageB.every(n => n.entity_id === projectB.id), 'Lineage isolated for B');

    // === Shutdown ===
    os.shutdownSafely();
    assertThrows(() => os.dispatchWorkload(workload.id), 'Dispatch blocked after shutdown');
    os.startupRecovery();
    assert(os.getStore().shutdownState.isShutdown === false, 'Startup recovery resets shutdown state');

    // === Concurrency ===
    const concurrencyResults = [];
    for (let i = 0; i < 10; i++) {
        concurrencyResults.push(os.createMission({ intentId: intent.id, organizationId: 'org1', description: `Concurrent ${i}`, idempotencyKey: `concurrent-${i}` }));
    }
    assert(new Set(concurrencyResults.map(m => m.id)).size === 10, 'Concurrent missions unique');

    // === Stress Loops ===
    for (let i = 0; i < 50; i++) {
        const in1 = os.ingestIntent({ description: `Intent ${i}`, organizationId: 'org', idempotencyKey: `intent-loop-${i}` });
        assert(in1.id !== undefined, `Intent loop ${i}`);
    }
    for (let i = 0; i < 50; i++) {
        const m = os.createMission({ intentId: intent.id, organizationId: 'org', description: `Mission ${i}`, idempotencyKey: `mission-loop-${i}` });
        assert(m.id !== undefined, `Mission loop ${i}`);
    }
    for (let i = 0; i < 50; i++) {
        const g = os.evaluateGovernance(`mission-loop-${i}`);
        assert(g === 'ALLOW', `Governance loop ${i}`);
    }
    for (let i = 0; i < 50; i++) {
        const w = os.scheduleWorkload(`mission-loop-${i}`);
        assert(w.id !== undefined, `Scheduling loop ${i}`);
    }
    for (let i = 0; i < 50; i++) {
        const a = os.requestApproval(`mission-loop-${i}`, `user-${i}`);
        assert(a.state === 'REQUESTED', `Authorization loop ${i}`);
    }
    for (let i = 0; i < 50; i++) {
        const r = os.allocateResources(`mission-loop-${i}`, 'CPU', i + 1);
        assert(r.amount > 0, `Resource loop ${i}`);
    }
    for (let i = 0; i < 50; i++) {
        const w = os.scheduleWorkload(`mission-loop-${i}`);
        const exec = os.executeWorkload(w.id);
        assert(exec.id !== undefined, `Execution loop ${i}`);
    }
    for (let i = 0; i < 50; i++) {
        const v = os.verify(`exec-${i}`, 'VERIFIED');
        assert(v.id !== undefined, `Verification loop ${i}`);
    }
    for (let i = 0; i < 40; i++) {
        const f = os.createIncident('TEST', `sub-${i}`, 'FAILURE', 'LOW');
        assert(f.id !== undefined, `Failure loop ${i}`);
    }
    for (let i = 0; i < 40; i++) {
        const r = os.recover(`exec-${i}`);
        assert(r.id !== undefined, `Recovery loop ${i}`);
    }
    for (let i = 0; i < 40; i++) {
        const ev = os.generateEvidence('TEST', `entity-${i}`, 'TEST', { data: i });
        assert(ev.id !== undefined, `Evidence loop ${i}`);
    }
    for (let i = 0; i < 40; i++) {
        const lin = os.queryLineage('TEST', `entity-${i}`);
        assert(Array.isArray(lin), `Lineage loop ${i}`);
    }
    for (let i = 0; i < 30; i++) {
        const r = os.replayDecision('TEST', `sub-${i}`, 'hash');
        assert(r.divergence === 1, `Replay loop ${i}`);
    }
    for (let i = 0; i < 30; i++) {
        const m1 = os.createMission({ intentId: intent.id, organizationId: 'orgIso', description: `Iso ${i}`, idempotencyKey: `iso-mission-${i}` });
        const lin1 = os.queryLineage('MISSION', m1.id);
        assert(lin1.every(n => n.entity_id === m1.id), `Isolation loop ${i}`);
    }

    // === Full Lifecycle Test ===
    const fullIntent = os.ingestIntent({ description: 'Full lifecycle', organizationId: 'orgFull', idempotencyKey: 'full-intent' });
    const fullMission = os.createMission({ intentId: fullIntent.id, organizationId: 'orgFull', description: 'Full mission', idempotencyKey: 'full-mission' });
    os.planMission(fullMission.id);
    os.evaluateStrategy(fullMission.id);
    os.composeAgentTeam(fullMission.id);
    os.evaluateRisk(fullMission.id);
    os.evaluateGovernance(fullMission.id);
    os.evaluateSafety(fullMission.id);
    const fullApproval = os.requestApproval(fullMission.id, 'user');
    os.approveApproval(fullApproval.id, 'approver');
    const fullResource = os.allocateResources(fullMission.id, 'CPU', 50);
    os.reserveResource(fullResource.id, fullMission.id, 'full-resv');
    const fullWorkload = os.scheduleWorkload(fullMission.id);
    os.dispatchWorkload(fullWorkload.id);
    const fullExec = os.executeWorkload(fullWorkload.id);
    os.observe(fullExec.id, 'MEMORY', 70);
    const fullDiag = os.diagnose(fullExec.id, 'NORMAL');
    os.remediate(fullDiag.id, 'NO_ACTION');
    os.verify(fullExec.id, 'VERIFIED');
    os.recover(fullExec.id);
    os.rollback(fullExec.id);
    os.createIncident('EXECUTION', fullExec.id, 'TEST', 'LOW');
    os.generateEvidence('MISSION', fullMission.id, 'COMPLETE', { status: 'OK' });
    os.recordLearning('MISSION', fullMission.id, 'FULL_LIFECYCLE', 'Success');
    os.recordDecisionMemory('full-decision', { result: 'OK' });
    os.replayDecision('MISSION', fullMission.id, os.computeDeterministicHash('MISSION', fullMission.id));
    const fullLineage = os.queryLineage('MISSION', fullMission.id);
    assert(fullLineage.length >= 8, 'Full lifecycle lineage has many nodes');

    // === Failure Lifecycle Test ===
    const failIntent = os.ingestIntent({ description: 'Failure lifecycle', organizationId: 'orgFail', idempotencyKey: 'fail-intent' });
    const failMission = os.createMission({ intentId: failIntent.id, organizationId: 'orgFail', description: 'Fail mission', idempotencyKey: 'fail-mission' });
    os.planMission(failMission.id);
    os.evaluateGovernance(failMission.id);
    os.evaluateSafety(failMission.id);
    const failApproval = os.requestApproval(failMission.id, 'user');
    os.approveApproval(failApproval.id, 'approver');
    const failWorkload = os.scheduleWorkload(failMission.id);
    os.dispatchWorkload(failWorkload.id);
    const failExec = os.executeWorkload(failWorkload.id);
    os.createIncident('EXECUTION', failExec.id, 'CRASH', 'HIGH');
    os.diagnose(failExec.id, 'CRASH_CAUSE');
    os.remediate('diag-fail', 'RESTART');
    os.verify(failExec.id, 'FAILED');
    os.rollback(failExec.id);
    os.recover(failExec.id);
    const unaffected = os.createMission({ intentId: intent.id, organizationId: 'orgUnrelated', description: 'Unrelated', idempotencyKey: 'unrelated' });
    assert(unaffected.state === 'CREATED', 'Unrelated mission unaffected by failure');

    // === Self-Healing Lifecycle Test ===
    const healObs = os.observe('exec-any', 'CPU', 95);
    const healDiag = os.diagnose('exec-any', 'CPU_SATURATION');
    os.remediate(healDiag.id, 'SCALE_UP');
    os.verify('exec-any', 'VERIFIED');
    os.recordLearning('EXECUTION', 'exec-any', 'HEALING', 'Successful scale up');

    // === Software Factory Lifecycle (simulated) ===
    const sfIntent = os.ingestIntent({ description: 'Software change', organizationId: 'orgSF', idempotencyKey: 'sf-intent' });
    const sfMission = os.createMission({ intentId: sfIntent.id, organizationId: 'orgSF', description: 'SF mission', idempotencyKey: 'sf-mission' });
    os.planMission(sfMission.id);
    os.evaluateStrategy(sfMission.id);
    os.composeAgentTeam(sfMission.id);
    os.generateEvidence('SOFTWARE', sfMission.id, 'BUILD', { status: 'SUCCESS' });
    os.generateEvidence('SOFTWARE', sfMission.id, 'TEST', { status: 'PASS' });
    os.generateEvidence('SOFTWARE', sfMission.id, 'ARTIFACT', { hash: 'abc' });
    os.generateEvidence('SOFTWARE', sfMission.id, 'RELEASE', { version: '1.0' });
    os.generateEvidence('SOFTWARE', sfMission.id, 'DEPLOYMENT', { env: 'prod' });
    assert(os.getStore().evidence.size > 0, 'Software factory steps produce evidence');

    // === Governance Lifecycle Test ===
    const govAction = os.evaluateGovernance('some-entity');
    assert(govAction === 'ALLOW', 'Governance ALLOW');

    // === Final Readiness ===
    const readiness = os.evaluateReadiness();
    assert(readiness === 'READY', 'System readiness is READY');

    console.log('----------------------------------------');
    console.log(`Phase 100 test suite completed.`);
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
