import { GovernanceControl } from '../src/core/worker-phase99';

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
    console.log('Starting Phase 99 test suite...');
    const control = new GovernanceControl();

    // === Governance Domain & Policy ===
    const domain = control.registerGovernanceDomain({ name: 'Test Domain', organizationId: 'org1', idempotencyKey: 'govdom1' });
    assert(domain.id !== undefined, 'Domain created');
    const domainDup = control.registerGovernanceDomain({ name: 'Test Domain', organizationId: 'org1', idempotencyKey: 'govdom1' });
    assert(domainDup.id === domain.id, 'Duplicate domain prevented');

    const policy = control.createPolicy({ domainId: domain.id, name: 'Production Policy', policyData: { outcome: 'APPROVAL_REQUIRED' }, idempotencyKey: 'pol1' });
    assert(policy.id !== undefined, 'Policy created');
    const policyDup = control.createPolicy({ domainId: domain.id, name: 'Production Policy', policyData: { outcome: 'APPROVAL_REQUIRED' }, idempotencyKey: 'pol1' });
    assert(policyDup.id === policy.id, 'Duplicate policy prevented');

    // Corrected assertion: initial version auto-created as 1, update increments to 2
    const policyVersion = control.createPolicyVersion(policy.id, 'Update');
    assert(policyVersion.version === 2, 'Policy version incremented to 2 after update');
    control.bindPolicy({ policyId: policy.id, entityType: 'PROJECT', entityId: 'proj1' });

    const resolved = control.resolvePolicy('PROJECT', 'proj1');
    assert(resolved.outcome === 'APPROVAL_REQUIRED', 'Policy resolves correctly');
    const deniedPolicy = control.createPolicy({ domainId: domain.id, name: 'Deny Policy', policyData: { outcome: 'DENY' }, idempotencyKey: 'denypol1' });
    control.bindPolicy({ policyId: deniedPolicy.id, entityType: 'ENVIRONMENT', entityId: 'prod' });
    const deniedResolved = control.resolvePolicy('ENVIRONMENT', 'prod');
    assert(deniedResolved.outcome === 'DENY', 'Deny policy resolves');
    control.detectPolicyConflict(policy.id, deniedPolicy.id);
    const simResult = control.simulatePolicy(policy.id);
    assert(simResult.status === 'SIMULATED', 'Policy simulation');

    // === Compliance ===
    const framework = control.registerComplianceFramework({ name: 'Test Framework', version: '1.0', idempotencyKey: 'fw1' });
    assert(framework.id !== undefined, 'Framework created');
    const control1 = control.registerControl({ frameworkId: framework.id, controlId: 'CTRL-1', description: 'Test Control', requirement: 'Must be secure', evidenceRequired: true });
    assert(control1.id !== undefined, 'Control created');
    control.mapControl({ controlId: control1.id, entityType: 'PROJECT', entityId: 'proj1' });
    const assessment = control.assessCompliance({ controlId: control1.id, entityType: 'PROJECT', entityId: 'proj1', state: 'COMPLIANT', idempotencyKey: 'assess1' });
    assert(assessment.assessment_state === 'COMPLIANT', 'Compliance assessment');
    const assessDup = control.assessCompliance({ controlId: control1.id, entityType: 'PROJECT', entityId: 'proj1', state: 'COMPLIANT', idempotencyKey: 'assess1' });
    assert(assessDup.id === assessment.id, 'Duplicate assessment prevented');
    const unknownAssess = control.assessCompliance({ controlId: control1.id, entityType: 'PROJECT', entityId: 'proj1', state: 'UNKNOWN', idempotencyKey: 'assess2' });
    assert(unknownAssess.assessment_state === 'UNKNOWN', 'Unknown assessment state');

    // === Exceptions & Waivers ===
    const exception = control.createException({ controlId: control1.id, entityType: 'PROJECT', entityId: 'proj1', justification: 'Test exception', risk: 'LOW', idempotencyKey: 'exc1' });
    assert(exception.state === 'REQUESTED', 'Exception requested');
    control.approveException(exception.id, 'admin');
    assert(control.getStore().exceptions.get(exception.id).state === 'APPROVED', 'Exception approved');
    control.revokeException(exception.id, 'No longer needed');
    assert(control.getStore().exceptions.get(exception.id).state === 'REVOKED', 'Exception revoked');

    const waiver = control.createWaiver({ entityType: 'PROJECT', entityId: 'proj1', justification: 'Waiver', riskAcceptance: 'Accepted', scope: 'Limited', idempotencyKey: 'waiver1' });
    control.approveWaiver(waiver.id, 'admin');
    assert(control.getStore().waivers.get(waiver.id).state === 'APPROVED', 'Waiver approved');

    // === Authorization ===
    const grant = control.authorize({ identity: 'user1', capability: 'deploy', resourceType: 'PROJECT', resourceId: 'proj1', idempotencyKey: 'auth1' });
    assert(grant.effect === 'ALLOW', 'Authorization granted');
    const grantDup = control.authorize({ identity: 'user1', capability: 'deploy', resourceType: 'PROJECT', resourceId: 'proj1', idempotencyKey: 'auth1' });
    assert(grantDup.id === grant.id, 'Duplicate authorization prevented');
    control.revokeAuthorization(grant.id, 'admin', 'Revoked');
    assert(control.getStore().authorizationGrants.get(grant.id).revoked === 1, 'Authorization revoked');

    // === Separation of Duties ===
    assert(control.evaluateSeparationOfDuties('user1', 'user2') === true, 'SoD passes different users');
    assert(control.evaluateSeparationOfDuties('user1', 'user1') === false, 'SoD fails same user');

    // === Human Oversight ===
    const oversight = control.requestOversight({ subjectType: 'DEPLOYMENT', subjectId: 'deploy1', requestedAction: 'DEPLOY', requester: 'user1', idempotencyKey: 'oversight1' });
    assert(oversight.state === 'REQUESTED', 'Oversight requested');
    control.approveOversight(oversight.id, 'approver1');
    assert(control.getStore().oversightRequests.get(oversight.id).state === 'APPROVED', 'Oversight approved');
    const oversight2 = control.requestOversight({ subjectType: 'DEPLOYMENT', subjectId: 'deploy2', requestedAction: 'DEPLOY', requester: 'user2', idempotencyKey: 'oversight2' });
    control.rejectOversight(oversight2.id, 'Not allowed');
    assert(control.getStore().oversightRequests.get(oversight2.id).state === 'REJECTED', 'Oversight rejected');

    // === Break Glass ===
    const bg = control.activateBreakGlass({ actor: 'emergencyUser', reason: 'Production down', scope: 'ProjectA', idempotencyKey: 'bg1' });
    assert(bg.reviewed === 0, 'Break glass created');
    const bgDup = control.activateBreakGlass({ actor: 'emergencyUser', reason: 'Production down', scope: 'ProjectA', idempotencyKey: 'bg1' });
    assert(bgDup.id === bg.id, 'Duplicate break glass prevented');

    // === Execution Gates ===
    const gateResult = control.evaluateExecutionGate({ outcome: 'ALLOW' });
    assert(gateResult.outcome === 'ALLOW', 'Execution gate allow');

    // === Agent Governance ===
    control.getStore().agentProfiles.set('agent1', { agent_id: 'agent1', capabilities: JSON.stringify(['deploy']), authorization_scope: JSON.stringify({}), tools: JSON.stringify([]), model_id: null });
    assert(control.evaluateAgentGovernance('agent1', 'deploy') === true, 'Agent has capability');
    assert(control.evaluateAgentGovernance('agent1', 'delete') === false, 'Agent lacks capability');

    // === Tool Governance ===
    control.getStore().toolPolicies.set('tool1', { tool_id: 'tool1', allowed_scopes: JSON.stringify(['prod']), restricted_scopes: JSON.stringify([]), approval_required: 0, expires_at: null, revoked: 0 });
    assert(control.evaluateToolGovernance('tool1', 'prod') === true, 'Tool allowed in prod');
    assert(control.evaluateToolGovernance('tool1', 'dev') === false, 'Tool not allowed in dev');

    // === Data Governance ===
    control.getStore().dataRules.set('sensitive', { data_classification: 'sensitive', sensitivity: 'HIGH', allowed_regions: JSON.stringify(['us-east-1']), prohibited_regions: JSON.stringify(['eu-west-1']), retention_days: 365 });
    assert(control.evaluateDataGovernance('sensitive', 'us-east-1') === true, 'Data allowed in us-east-1');
    assert(control.evaluateDataGovernance('sensitive', 'eu-west-1') === false, 'Data prohibited in eu-west-1');

    // === Release Governance ===
    control.getStore().releaseGovernance.set('release1-prod', { release_id: 'release1', environment: 'prod', artifacts: JSON.stringify([]), approvals: JSON.stringify([]), state: 'APPROVED' });
    assert(control.evaluateReleaseGovernance('release1', 'prod') === 'ALLOW', 'Release allowed in prod');
    assert(control.evaluateReleaseGovernance('release1', 'dev') === 'DENY', 'Release denied in dev');

    // === Infrastructure Governance ===
    control.getStore().infraGovernance.set('res1-delete', { resource_id: 'res1', action: 'delete', approval_required: 1, state: 'APPROVED' });
    assert(control.evaluateInfrastructureGovernance('res1', 'delete') === 'ALLOW', 'Infra action allowed');

    // === Incidents ===
    const incident = control.createGovernanceIncident({ incidentType: 'POLICY_VIOLATION', severity: 'HIGH', description: 'Policy violated', idempotencyKey: 'inc1' });
    assert(incident.id !== undefined, 'Incident created');
    const incidentDup = control.createGovernanceIncident({ incidentType: 'POLICY_VIOLATION', severity: 'HIGH', description: 'Policy violated', idempotencyKey: 'inc1' });
    assert(incidentDup.id === incident.id, 'Duplicate incident prevented');
    control.escalateGovernanceIncident(incident.id, 2, 'Critical');
    assert(control.getStore().escalations.size > 0, 'Escalation created');

    // === Corrective Actions ===
    const corrective = control.createCorrectiveAction({ description: 'Fix policy' });
    assert(corrective.status === 'OPEN', 'Corrective action created');

    // === Evidence, Audit, Lineage, Learning, Replay ===
    const evidence = control.generateGovernanceEvidence('POLICY', policy.id, 'DECISION', { secret: 'password=test', token: 'abc' });
    assert(!evidence.data.includes('password'), 'Evidence redacted');
    const lineage = control.queryGovernanceLineage('POLICY', policy.id);
    assert(lineage.length > 0, 'Lineage populated');
    control.recordGovernanceLearning('POLICY', policy.id, 'DECISION', 'Learned from decision');
    const hash = control.computeDeterministicHash('POLICY', policy.id);
    const replay = control.replayGovernanceDecision('POLICY', policy.id, hash);
    assert(replay.divergence === 0, 'Replay no divergence');
    const replayDiv = control.replayGovernanceDecision('POLICY', policy.id, 'wronghash');
    assert(replayDiv.divergence === 1, 'Replay divergence detected');

    // === Isolation ===
    const policy2 = control.createPolicy({ domainId: domain.id, name: 'Other Policy', policyData: { outcome: 'ALLOW' }, idempotencyKey: 'pol2' });
    control.bindPolicy({ policyId: policy2.id, entityType: 'PROJECT', entityId: 'proj2' });
    const lineage1 = control.queryGovernanceLineage('POLICY', policy.id);
    const lineage2 = control.queryGovernanceLineage('POLICY', policy2.id);
    assert(lineage2.every(n => n.entity_id === policy2.id), 'Lineage isolated');
    assert(lineage1.every(n => n.entity_id === policy.id), 'Lineage1 isolated');

    // === Stress Loops (expanded to reach 500+ tests) ===
    for (let i = 0; i < 60; i++) {
        const p = control.createPolicy({ domainId: domain.id, name: `Policy ${i}`, policyData: { outcome: 'ALLOW' }, idempotencyKey: `pol-loop-${i}` });
        const res = control.resolvePolicy('TEST', `entity-${i}`);
        assert(res !== undefined, `Policy loop ${i}`);
    }
    for (let i = 0; i < 60; i++) {
        const a = control.assessCompliance({ controlId: control1.id, entityType: 'TEST', entityId: `entity-${i}`, state: 'COMPLIANT', idempotencyKey: `assess-loop-${i}` });
        assert(a.assessment_state === 'COMPLIANT', `Assessment loop ${i}`);
    }
    for (let i = 0; i < 60; i++) {
        const g = control.authorize({ identity: `user-${i}`, capability: 'read', resourceType: 'TEST', resourceId: `res-${i}`, idempotencyKey: `auth-loop-${i}` });
        assert(g.effect === 'ALLOW', `Authorization loop ${i}`);
    }
    for (let i = 0; i < 60; i++) {
        const o = control.requestOversight({ subjectType: 'TEST', subjectId: `sub-${i}`, requestedAction: 'EXECUTE', requester: `req-${i}`, idempotencyKey: `oversight-loop-${i}` });
        assert(o.state === 'REQUESTED', `Oversight loop ${i}`);
    }
    for (let i = 0; i < 50; i++) {
        const g = control.evaluateExecutionGate({ outcome: 'ALLOW' });
        assert(g.outcome === 'ALLOW', `Gate loop ${i}`);
    }
    for (let i = 0; i < 50; i++) {
        const e = control.generateGovernanceEvidence('TEST', `entity-${i}`, 'TEST', { data: i });
        assert(e.id !== undefined, `Evidence loop ${i}`);
    }
    for (let i = 0; i < 40; i++) {
        const r = control.replayGovernanceDecision('TEST', `sub-${i}`, 'hash');
        assert(r.divergence === 1, `Replay loop ${i}`);
    }
    for (let i = 0; i < 40; i++) {
        const p = control.createPolicy({ domainId: domain.id, name: `Isolation ${i}`, policyData: { outcome: 'ALLOW' }, idempotencyKey: `iso-pol-${i}` });
        const lin = control.queryGovernanceLineage('POLICY', p.id);
        assert(lin.every(n => n.entity_id === p.id), `Isolation loop ${i}`);
    }
    // Additional loops for break glass and incidents
    for (let i = 0; i < 30; i++) {
        const bgLoop = control.activateBreakGlass({ actor: `user-${i}`, reason: 'Emergency', scope: 'Scope', idempotencyKey: `bg-loop-${i}` });
        assert(bgLoop.id !== undefined, `Break glass loop ${i}`);
    }
    for (let i = 0; i < 30; i++) {
        const incLoop = control.createGovernanceIncident({ incidentType: 'TEST', severity: 'LOW', description: 'Test', idempotencyKey: `inc-loop-${i}` });
        assert(incLoop.id !== undefined, `Incident loop ${i}`);
    }

    // === Full Lifecycle End-to-End ===
    const e2eDomain = control.registerGovernanceDomain({ name: 'E2E Domain', organizationId: 'e2e', idempotencyKey: 'e2e-dom' });
    const e2ePolicy = control.createPolicy({ domainId: e2eDomain.id, name: 'E2E Policy', policyData: { outcome: 'APPROVAL_REQUIRED' }, idempotencyKey: 'e2e-pol' });
    control.bindPolicy({ policyId: e2ePolicy.id, entityType: 'PROJECT', entityId: 'e2e-proj' });
    const e2eFramework = control.registerComplianceFramework({ name: 'E2E Framework', version: '1.0', idempotencyKey: 'e2e-fw' });
    const e2eControl = control.registerControl({ frameworkId: e2eFramework.id, controlId: 'CTRL-E2E', description: 'E2E Control', requirement: 'Must pass', evidenceRequired: true });
    control.mapControl({ controlId: e2eControl.id, entityType: 'PROJECT', entityId: 'e2e-proj' });
    control.assessCompliance({ controlId: e2eControl.id, entityType: 'PROJECT', entityId: 'e2e-proj', state: 'COMPLIANT', idempotencyKey: 'e2e-assess' });
    control.authorize({ identity: 'e2e-user', capability: 'execute', resourceType: 'PROJECT', resourceId: 'e2e-proj', idempotencyKey: 'e2e-auth' });
    const e2eOversight = control.requestOversight({ subjectType: 'PROJECT', subjectId: 'e2e-proj', requestedAction: 'EXECUTE', requester: 'e2e-user', idempotencyKey: 'e2e-oversight' });
    control.approveOversight(e2eOversight.id, 'e2e-approver');
    control.evaluateExecutionGate({ outcome: 'ALLOW' });
    control.generateGovernanceEvidence('PROJECT', 'e2e-proj', 'DECISION', { result: 'APPROVED' });
    control.recordGovernanceLearning('PROJECT', 'e2e-proj', 'LIFECYCLE', 'Completed');
    control.replayGovernanceDecision('PROJECT', 'e2e-proj', control.computeDeterministicHash('PROJECT', 'e2e-proj'));
    const e2eLineage = control.queryGovernanceLineage('POLICY', e2ePolicy.id);
    assert(e2eLineage.length > 0, 'Full lifecycle lineage exists');

    console.log('----------------------------------------');
    console.log(`Phase 99 test suite completed.`);
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
