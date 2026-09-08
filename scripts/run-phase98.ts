import { InfrastructureControl } from '../src/core/worker-phase98';

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
    console.log('Starting Phase 98 test suite...');
    const control = new InfrastructureControl();

    // === Domain & Provider ===
    const domain = control.registerInfrastructureDomain({ name: 'Prod Domain', organizationId: 'org1', idempotencyKey: 'dom1' });
    assert(domain.id !== undefined, 'Domain created');
    const domainDup = control.registerInfrastructureDomain({ name: 'Prod Domain', organizationId: 'org1', idempotencyKey: 'dom1' });
    assert(domainDup.id === domain.id, 'Duplicate domain prevented');

    const provider = control.registerProvider({ domainId: domain.id, type: 'KUBERNETES', name: 'prod-k8s', state: 'HEALTHY', health: 'HEALTHY', idempotencyKey: 'prov1' });
    assert(provider.health === 'HEALTHY', 'Provider healthy');
    const providerDup = control.registerProvider({ domainId: domain.id, type: 'KUBERNETES', name: 'prod-k8s', idempotencyKey: 'prov1' });
    assert(providerDup.id === provider.id, 'Duplicate provider prevented');

    // === Resource ===
    const resource = control.registerResource({
        domainId: domain.id,
        providerId: provider.id,
        organizationId: 'org1',
        projectId: 'proj1',
        environment: 'prod',
        region: 'us-east-1',
        clusterId: 'cluster1',
        serviceId: 'svc1',
        type: 'KUBERNETES_NODE',
        identifier: 'node-1',
        health: 'HEALTHY',
        criticality: 'HIGH',
        risk: 'MEDIUM',
        idempotencyKey: 'res1',
    });
    assert(resource.id !== undefined, 'Resource registered');
    const resourceDup = control.registerResource({ ...resource, idempotencyKey: 'res1' });
    assert(resourceDup.id === resource.id, 'Duplicate resource prevented');

    // === Discovery ===
    const discovered = control.discoverResources({ domainId: domain.id, providerId: provider.id });
    assert(discovered.length === 1, 'Discovery returns resource');

    // === Observation ===
    const obs = control.observeInfrastructure({
        resourceId: resource.id,
        providerId: provider.id,
        observationType: 'CPU_USAGE',
        value: 85,
        unit: 'percent',
        idempotencyKey: 'obs1',
    });
    assert(obs.value === 85, 'Observation recorded');
    const obsDup = control.observeInfrastructure({ ...obs, idempotencyKey: 'obs1' });
    assert(obsDup.id === obs.id, 'Duplicate observation prevented');

    // === Baseline ===
    const baseline = control.createBaseline({ resourceId: resource.id, baselineData: { cpu: 50 } });
    assert(baseline.id !== undefined, 'Baseline created');
    control.markBaselineStale(baseline.id);
    assert(control.getStore().baselines.get(baseline.id).is_stale === 1, 'Baseline marked stale');

    // === Anomaly ===
    const anomaly = control.detectAnomaly({
        resourceId: resource.id,
        anomalyType: 'CPU_SATURATION',
        severity: 'CRITICAL',
        state: 'CRITICAL',
        idempotencyKey: 'anom1',
    });
    assert(anomaly.severity === 'CRITICAL', 'Anomaly detected');
    const anomalyDup = control.detectAnomaly({ ...anomaly, idempotencyKey: 'anom1' });
    assert(anomalyDup.id === anomaly.id, 'Duplicate anomaly prevented');

    // === Correlation ===
    const correlated = control.correlateSignals([resource.id]);
    assert(correlated.length > 0, 'Correlation produced results');

    // === Incident & Diagnosis ===
    const incident = control.createIncident({
        resourceId: resource.id,
        incidentType: 'CPU_EXHAUSTION',
        severity: 'HIGH',
        description: 'CPU usage above threshold',
        idempotencyKey: 'inc1',
    });
    assert(incident.id !== undefined, 'Incident created');
    const incidentDup = control.createIncident({ ...incident, idempotencyKey: 'inc1' });
    assert(incidentDup.id === incident.id, 'Duplicate incident prevented');

    const diagnosis = control.diagnoseInfrastructure({
        incidentId: incident.id,
        resourceId: resource.id,
        suspectedCause: 'RESOURCE_EXHAUSTION',
        confidence: 0.8,
        isConfirmed: true,
    });
    assert(diagnosis.suspected_cause === 'RESOURCE_EXHAUSTION', 'Diagnosis made');

    const rootCause = control.identifyRootCause({ diagnosisId: diagnosis.id, rootCause: 'HIGH_LOAD', confidence: 0.9 });
    assert(rootCause.root_cause === 'HIGH_LOAD', 'Root cause identified');

    const impact = control.assessInfrastructureImpact({
        diagnosisId: diagnosis.id,
        impactedResources: [resource.id],
        impactedServices: ['svc1'],
        blastRadius: 'NARROW',
        criticality: 'HIGH',
        failureDomain: 'RESOURCE',
    });
    assert(impact.blast_radius === 'NARROW', 'Impact assessed');

    const risk = control.assessRisk({ diagnosisId: diagnosis.id, riskScore: 0.7, riskLevel: 'HIGH', systemicRisk: false });
    assert(risk.risk_level === 'HIGH', 'Risk assessed');

    const prediction = control.predictFailure({ resourceId: resource.id, predictionType: 'CAPACITY_EXHAUSTION', confidence: 0.75, riskLevel: 'ELEVATED' });
    assert(prediction.prediction_type === 'CAPACITY_EXHAUSTION', 'Prediction made');

    // === Remediation ===
    const candidate = control.generateRemediationCandidates({
        diagnosisId: diagnosis.id,
        action: 'RESTART_SERVICE',
        supported: true,
        risk: 'LOW',
        reversibility: 'HIGH',
    });
    assert(candidate.supported === 1, 'Candidate supported');

    const plan = control.createRemediationPlan({
        diagnosisId: diagnosis.id,
        candidateId: candidate.id,
        resourceId: resource.id,
        planData: { steps: ['restart'] },
        idempotencyKey: 'plan1',
    });
    assert(plan.id !== undefined, 'Plan created');
    const planDup = control.createRemediationPlan({ ...plan, idempotencyKey: 'plan1' });
    assert(planDup.id === plan.id, 'Duplicate plan prevented');

    control.activateRemediationPlan(plan.id);
    assert(control.getStore().remediationPlans.get(plan.id).state === 'PLAN_READY', 'Plan activated');

    const sim = control.simulateRemediation(plan.id);
    assert(sim.status === 'SIMULATED', 'Simulation status');

    assert(control.evaluateGovernance(plan.id) === 'ALLOW', 'Governance allows');
    assert(control.evaluateSafety(plan.id) === 'ALLOW', 'Safety allows');

    const approval = control.requestApproval(plan.id, 'admin');
    assert(approval.decision === 'REQUESTED', 'Approval requested');
    control.approveRemediation(approval.id, 'APPROVED');

    const reservation = control.reserveResources({ resourceId: resource.id, amount: 1, type: 'CPU', idempotencyKey: 'resv1' });
    assert(reservation.id !== undefined, 'Reservation made');

    const execution = control.executeRemediation({ planId: plan.id, status: 'EXECUTING', idempotencyKey: 'exec1' });
    assert(execution.status === 'EXECUTING', 'Remediation executing');
    const execDup = control.executeRemediation({ ...execution, idempotencyKey: 'exec1' });
    assert(execDup.id === execution.id, 'Duplicate execution prevented');

    const verification = control.verifyRemediation(execution.id, 'VERIFIED', { health: 'OK' });
    assert(verification.status === 'VERIFIED', 'Remediation verified');

    const stabilization = control.stabilizeInfrastructure(execution.id);
    assert(stabilization.status === 'STABILIZED', 'Infrastructure stabilized');

    // === Rollback & Recovery ===
    const rollback = control.rollbackRemediation(execution.id, 'Rollback restart', 'rollback1');
    assert(rollback.status === 'PLANNED', 'Rollback planned');
    const rollbackDup = control.rollbackRemediation(execution.id, 'Rollback restart', 'rollback1');
    assert(rollbackDup.id === rollback.id, 'Duplicate rollback prevented');

    const recovery = control.recoverInfrastructure(execution.id, 'Retry restart');
    assert(recovery.status === 'PLANNED', 'Recovery planned');

    // === Circuit Breakers & Quarantine ===
    const breaker = control.openCircuitBreaker('RESOURCE', resource.id);
    assert(breaker.state === 'OPEN', 'Breaker opened');
    control.closeCircuitBreaker(breaker.id);
    assert(control.getStore().circuitBreakers.get(breaker.id).state === 'CLOSED', 'Breaker closed');

    const quarantine = control.quarantineResource('RESOURCE', resource.id, 'Unstable');
    assert(quarantine.id !== undefined, 'Resource quarantined');
    control.releaseQuarantine(quarantine.id);
    assert(control.getStore().quarantines.get(quarantine.id).released_at !== null, 'Quarantine released');

    // === Checkpoint ===
    const checkpoint = control.createCheckpoint('RESOURCE', resource.id, { state: 'RECOVERED' });
    assert(checkpoint.id !== undefined, 'Checkpoint created');

    // === Evidence, Learning, Replay ===
    const evidence = control.generateEvidence('RESOURCE', resource.id, 'REMEDIATION', { secret: 'password=secret', token: 'abc' });
    assert(!evidence.data.includes('password'), 'Evidence redacted');
    const lineage = control.queryLineage(resource.id);
    assert(lineage.length > 5, 'Lineage populated');
    const learning = control.recordLearning(resource.id, 'REMEDIATION', 'Restart resolved CPU issue');
    assert(learning.content === 'Restart resolved CPU issue', 'Learning recorded');
    const hash = control.computeDeterministicHash(resource.id);
    const replay = control.replayInfrastructureDecision(resource.id, hash);
    assert(replay.divergence === 0, 'Replay no divergence');
    const replayDiv = control.replayInfrastructureDecision(resource.id, 'badhash');
    assert(replayDiv.divergence === 1, 'Replay divergence detected');

    // === Isolation ===
    const resource2 = control.registerResource({
        domainId: domain.id,
        providerId: provider.id,
        organizationId: 'org2',
        projectId: 'proj2',
        environment: 'dev',
        region: 'us-west-2',
        type: 'VM',
        identifier: 'vm-1',
        idempotencyKey: 'res2',
    });
    const lineage1 = control.queryLineage(resource.id);
    const lineage2 = control.queryLineage(resource2.id);
    assert(lineage2.every(n => n.resource_id === resource2.id), 'Lineage isolated');
    assert(lineage1.every(n => n.resource_id === resource.id), 'Lineage1 isolated');

    // === Stress Loops ===
    for (let i = 0; i < 50; i++) {
        const r = control.registerResource({
            domainId: domain.id,
            providerId: provider.id,
            organizationId: 'org',
            environment: 'test',
            region: 'us-east',
            type: 'CONTAINER',
            identifier: `container-${i}`,
            idempotencyKey: `res-loop-${i}`,
        });
        assert(r.id !== undefined, `Resource ${i} registered`);
    }
    for (let i = 0; i < 50; i++) {
        const o = control.observeInfrastructure({
            resourceId: resource.id,
            providerId: provider.id,
            observationType: 'MEMORY',
            value: 100 + i,
            idempotencyKey: `obs-loop-${i}`,
        });
        assert(o.value === 100 + i, `Observation ${i} value`);
    }
    for (let i = 0; i < 50; i++) {
        const a = control.detectAnomaly({
            resourceId: resource.id,
            anomalyType: `ANOMALY_${i}`,
            severity: 'LOW',
            idempotencyKey: `anom-loop-${i}`,
        });
        assert(a.id !== undefined, `Anomaly ${i} created`);
    }
    for (let i = 0; i < 40; i++) {
        const d = control.diagnoseInfrastructure({
            incidentId: incident.id,
            resourceId: resource.id,
            suspectedCause: `CAUSE_${i}`,
            confidence: 0.5,
        });
        assert(d.id !== undefined, `Diagnosis ${i} created`);
    }
    for (let i = 0; i < 40; i++) {
        const imp = control.assessInfrastructureImpact({
            diagnosisId: diagnosis.id,
            impactedResources: [],
            blastRadius: 'NARROW',
        });
        assert(imp.id !== undefined, `Impact ${i} created`);
    }
    for (let i = 0; i < 40; i++) {
        const cand = control.generateRemediationCandidates({
            diagnosisId: diagnosis.id,
            action: `ACTION_${i}`,
            supported: true,
        });
        assert(cand.id !== undefined, `Candidate ${i} created`);
    }
    for (let i = 0; i < 40; i++) {
        const v = control.verifyRemediation(execution.id, 'VERIFIED', { index: i });
        assert(v.status === 'VERIFIED', `Verification ${i} passed`);
    }
    for (let i = 0; i < 30; i++) {
        const rec = control.recoverInfrastructure(execution.id, `Recovery ${i}`);
        assert(rec.status === 'PLANNED', `Recovery ${i} planned`);
    }
    for (let i = 0; i < 30; i++) {
        const rb = control.rollbackRemediation(execution.id, `Rollback ${i}`, `rollback-loop-${i}`);
        assert(rb.status === 'PLANNED', `Rollback ${i} planned`);
    }
    for (let i = 0; i < 30; i++) {
        const cb = control.openCircuitBreaker('SERVICE', `svc-${i}`);
        assert(cb.state === 'OPEN', `Breaker ${i} open`);
    }
    for (let i = 0; i < 30; i++) {
        const inc = control.createIncident({
            resourceId: resource.id,
            incidentType: `TYPE_${i}`,
            severity: 'MEDIUM',
            description: `Incident ${i}`,
            idempotencyKey: `inc-loop-${i}`,
        });
        assert(inc.id !== undefined, `Incident ${i} created`);
    }
    for (let i = 0; i < 20; i++) {
        const rp = control.replayInfrastructureDecision(resource.id, hash);
        assert(rp.divergence === 0, `Replay ${i} consistent`);
    }
    for (let i = 0; i < 20; i++) {
        const isoRes = control.registerResource({
            domainId: domain.id,
            providerId: provider.id,
            organizationId: `org-iso-${i}`,
            environment: 'isolated',
            region: 'isolated',
            type: 'DATABASE',
            identifier: `db-${i}`,
            idempotencyKey: `iso-res-${i}`,
        });
        const isoLineage = control.queryLineage(isoRes.id);
        assert(isoLineage.every(n => n.resource_id === isoRes.id), `Isolation ${i} verified`);
    }

    // === Full Lifecycle End-to-End ===
    const e2eDomain = control.registerInfrastructureDomain({ name: 'E2E Domain', organizationId: 'e2e', idempotencyKey: 'e2e-dom' });
    const e2eProvider = control.registerProvider({ domainId: e2eDomain.id, type: 'CLOUD', name: 'aws', state: 'HEALTHY', health: 'HEALTHY', idempotencyKey: 'e2e-prov' });
    const e2eResource = control.registerResource({
        domainId: e2eDomain.id,
        providerId: e2eProvider.id,
        organizationId: 'e2e',
        environment: 'prod',
        region: 'us-east-1',
        type: 'SERVICE',
        identifier: 'e2e-svc',
        idempotencyKey: 'e2e-res',
    });
    const e2eObs = control.observeInfrastructure({ resourceId: e2eResource.id, providerId: e2eProvider.id, observationType: 'LATENCY', value: 1000, idempotencyKey: 'e2e-obs' });
    const e2eBaseline = control.createBaseline({ resourceId: e2eResource.id, baselineData: { latency: 200 } });
    const e2eAnomaly = control.detectAnomaly({ resourceId: e2eResource.id, anomalyType: 'LATENCY_SPIKE', severity: 'CRITICAL', idempotencyKey: 'e2e-anom' });
    const e2eIncident = control.createIncident({ resourceId: e2eResource.id, incidentType: 'HIGH_LATENCY', severity: 'HIGH', description: 'Latency spike', idempotencyKey: 'e2e-inc' });
    const e2eDiagnosis = control.diagnoseInfrastructure({ incidentId: e2eIncident.id, resourceId: e2eResource.id, suspectedCause: 'DEPLOYMENT_REGRESSION', confidence: 0.9 });
    const e2eRootCause = control.identifyRootCause({ diagnosisId: e2eDiagnosis.id, rootCause: 'BAD_DEPLOYMENT', confidence: 0.95 });
    const e2eImpact = control.assessInfrastructureImpact({ diagnosisId: e2eDiagnosis.id, impactedResources: [e2eResource.id], blastRadius: 'NARROW' });
    const e2eRisk = control.assessRisk({ diagnosisId: e2eDiagnosis.id, riskScore: 0.8, riskLevel: 'HIGH' });
    const e2eCandidate = control.generateRemediationCandidates({ diagnosisId: e2eDiagnosis.id, action: 'ROLLBACK_RELEASE', supported: true });
    const e2ePlan = control.createRemediationPlan({ diagnosisId: e2eDiagnosis.id, candidateId: e2eCandidate.id, resourceId: e2eResource.id, planData: {}, idempotencyKey: 'e2e-plan' });
    control.activateRemediationPlan(e2ePlan.id);
    control.simulateRemediation(e2ePlan.id);
    control.evaluateGovernance(e2ePlan.id);
    control.evaluateSafety(e2ePlan.id);
    const e2eApproval = control.requestApproval(e2ePlan.id, 'admin');
    control.approveRemediation(e2eApproval.id, 'APPROVED');
    control.reserveResources({ resourceId: e2eResource.id, amount: 1, type: 'GENERIC', idempotencyKey: 'e2e-resv' });
    const e2eExec = control.executeRemediation({ planId: e2ePlan.id, status: 'EXECUTING', idempotencyKey: 'e2e-exec' });
    control.verifyRemediation(e2eExec.id, 'VERIFIED', { health: 'OK' });
    control.stabilizeInfrastructure(e2eExec.id);
    control.generateEvidence('RESOURCE', e2eResource.id, 'REMEDIATION', { result: 'SUCCESS' });
    control.recordLearning(e2eResource.id, 'REMEDIATION', 'Rollback resolved latency spike');
    control.replayInfrastructureDecision(e2eResource.id, control.computeDeterministicHash(e2eResource.id));
    const e2eLineage = control.queryLineage(e2eResource.id);
    const requiredNodes = ['RESOURCE', 'OBSERVATION', 'ANOMALY', 'INCIDENT', 'DIAGNOSIS', 'REMEDIATION_PLAN'];
    for (const nodeType of requiredNodes) {
        assert(e2eLineage.some(n => n.node_type === nodeType), `Lineage contains ${nodeType}`);
    }

    console.log('----------------------------------------');
    console.log(`Phase 98 test suite completed.`);
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
