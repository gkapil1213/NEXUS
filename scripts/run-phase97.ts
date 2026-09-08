import { SoftwareFactoryControl } from '../src/core/worker-phase97';

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

function assertDeepEqual(actual: any, expected: any, message: string): void {
    const actualStr = JSON.stringify(actual);
    const expectedStr = JSON.stringify(expected);
    if (actualStr === expectedStr) {
        passed++;
    } else {
        failed++;
        failures.push(`${message} - expected ${expectedStr}, got ${actualStr}`);
        console.error(`FAIL: ${message}`);
    }
}

// ==================== TEST SUITE ====================
function runAllTests(): void {
    console.log('Starting Phase 97 test suite...');
    const control = new SoftwareFactoryControl();

    // === Factory Management ===
    const factoryInput = { organizationId: 'org1', name: 'Test Factory', idempotencyKey: 'factory-key-1' };
    const factory = control.createSoftwareFactory(factoryInput);
    assert(factory.id !== undefined, 'Factory created');
    assert(factory.state === 'INTAKE', 'Factory initial state');
    const factoryDup = control.createSoftwareFactory(factoryInput);
    assert(factoryDup.id === factory.id, 'Duplicate factory returns same ID');

    // === Product ===
    const productInput = {
        factoryId: factory.id,
        organizationId: 'org1',
        name: 'Test Product',
        idempotencyKey: 'product-key-1',
        risk: 'MEDIUM',
        environments: ['dev', 'staging', 'prod'],
    };
    const product = control.createSoftwareProduct(productInput);
    assert(product.id !== undefined, 'Product created');
    assert(product.lifecycle_state === 'INTAKE', 'Product initial state');
    const productDup = control.createSoftwareProduct(productInput);
    assert(productDup.id === product.id, 'Duplicate product returns same ID');

    // === Repository ===
    const repo = control.registerRepository({
        productId: product.id,
        provider: 'github',
        defaultBranch: 'main',
        idempotencyKey: 'repo-key-1',
    });
    assert(repo.id !== undefined, 'Repository registered');
    const branch = control.createBranch(repo.id, 'feature/test', false);
    assert(branch.name === 'feature/test', 'Branch created');
    const protectedBranch = control.createBranch(repo.id, 'main', true);
    assert(protectedBranch.is_protected === 1, 'Protected branch flag');

    // === Requirements ===
    const req = control.createRequirement({
        productId: product.id,
        type: 'FUNCTIONAL',
        description: 'User login',
        acceptanceCriteria: ['User can login', 'Password hashed'],
        idempotencyKey: 'req-key-1',
    });
    assert(req.description === 'User login', 'Requirement created');
    const reqDup = control.createRequirement({ ...req, idempotencyKey: 'req-key-1' });
    assert(reqDup.id === req.id, 'Duplicate requirement prevented');
    // Ambiguous requirement
    const ambReq = control.createRequirement({
        productId: product.id,
        type: 'FUNCTIONAL',
        description: 'Do something',
        isAmbiguous: true,
        idempotencyKey: 'amb-req-1',
    });
    assert(ambReq.is_ambiguous === 1, 'Ambiguous flag set');

    // === Architecture ===
    const arch = control.createArchitecture({
        productId: product.id,
        type: 'SYSTEM',
        content: 'Microservices architecture',
    });
    assert(arch.content === 'Microservices architecture', 'Architecture created');
    const activatedArch = control.activateArchitecture(arch.id);
    assert(activatedArch.state === 'ACTIVE', 'Architecture activated');

    // === Technical Design ===
    const design = control.createTechnicalDesign({
        productId: product.id,
        type: 'API',
        content: 'REST API design',
    });
    assert(design.content === 'REST API design', 'Design created');

    // === Implementation Plan ===
    const plan = control.createImplementationPlan({
        productId: product.id,
        planData: { files: ['src/main.ts'] },
    });
    assert(plan.id !== undefined, 'Implementation plan created');
    const step1 = control.addImplementationStep(plan.id, { order: 1, type: 'CODEGEN' });
    const step2 = control.addImplementationStep(plan.id, { order: 2, type: 'TEST', dependencies: [step1.id] });
    assert(step1.step_order === 1, 'Step1 order');
    assert(step2.dependencies.length > 0, 'Step2 dependency set');

    // === Code Change ===
    const change = control.createCodeChange({
        productId: product.id,
        repositoryId: repo.id,
        branchId: branch.id,
        requirementId: req.id,
        authorAgentId: 'agent1',
        risk: 'LOW',
        idempotencyKey: 'change-key-1',
    });
    assert(change.id !== undefined, 'Code change created');
    const file = control.addCodeChangeFile(change.id, {
        path: 'src/index.ts',
        operation: 'MODIFY',
        content: 'console.log("hello")',
        checksum: 'abc123',
    });
    assert(file.file_path === 'src/index.ts', 'File added to change');

    // === Code Review ===
    const review = control.reviewCodeChange(change.id, 'reviewer1', [
        { severity: 'LOW', category: 'STYLE', description: 'Minor style issue' },
    ], 'PASS');
    assert(review.decision === 'PASS', 'Review PASS');
    const reviewBlock = control.reviewCodeChange(change.id, 'reviewer1', [
        { severity: 'CRITICAL', category: 'SECURITY', description: 'SQL injection' },
    ], 'BLOCK');
    assert(reviewBlock.decision === 'BLOCK', 'Review BLOCK');

    // === Test Plan & Execution ===
    const testPlan = control.createTestPlan({ productId: product.id, planData: { suites: ['unit', 'integration'] } });
    const suite = control.createTestSuite(testPlan.id, 'Unit Tests', 'unit');
    const testExec = control.executeTests({
        suiteId: suite.id,
        environment: 'dev',
        commitHash: 'abc123',
        status: 'PASSED',
        results: [{ name: 'test1', status: 'PASS' }],
        idempotencyKey: 'test-exec-1',
    });
    assert(testExec.status === 'PASSED', 'Test execution passed');
    const testExecDup = control.executeTests({ ...testExec, idempotencyKey: 'test-exec-1' });
    assert(testExecDup.id === testExec.id, 'Duplicate test execution prevented');

    // === Build ===
    const buildPlan = control.createBuildPlan({ productId: product.id, planData: { steps: ['compile'] } });
    const build = control.executeBuild({
        buildPlanId: buildPlan.id,
        sourceRevision: 'abc123',
        buildEnvironment: 'linux',
        status: 'SUCCESS',
        idempotencyKey: 'build-1',
    });
    assert(build.status === 'SUCCESS', 'Build success');
    const buildDup = control.executeBuild({ ...build, idempotencyKey: 'build-1' });
    assert(buildDup.id === build.id, 'Duplicate build prevented');

    // === Artifact ===
    const artifact = control.registerArtifact({
        buildExecutionId: build.id,
        path: '/artifacts/app.zip',
        checksum: 'sha256:abcdef',
        sourceCommitHash: 'abc123',
        creator: 'system',
    });
    assert(artifact.checksum === 'sha256:abcdef', 'Artifact registered');
    assert(control.verifyArtifactProvenance(artifact.id) === true, 'Artifact provenance verified');

    // === Security Scan ===
    const scan = control.runSecurityScan({
        productId: product.id,
        scanType: 'SAST',
        targetRef: 'abc123',
        status: 'COMPLETED',
        findings: [{ severity: 'LOW', description: 'Minor issue' }],
        idempotencyKey: 'scan-1',
    });
    assert(scan.status === 'COMPLETED', 'Security scan completed');
    const scanDup = control.runSecurityScan({ ...scan, idempotencyKey: 'scan-1' });
    assert(scanDup.id === scan.id, 'Duplicate scan prevented');

    // === Quality Gates ===
    const gate = control.createQualityGate({ productId: product.id, gateData: { conditions: ['review', 'test', 'build'] } });
    const gateResult = control.evaluateQualityGate(gate.id, { result: 'PASS' });
    assert(gateResult.result === 'PASS', 'Gate PASS');
    const gateBlock = control.evaluateQualityGate(gate.id, { result: 'BLOCK' });
    assert(gateBlock.result === 'BLOCK', 'Gate BLOCK');

    // === Release Candidate ===
    const rc = control.createReleaseCandidate({
        productId: product.id,
        sourceCommitHash: 'abc123',
        buildExecutionId: build.id,
        artifacts: [artifact.id],
        testResults: [testExec.id],
        securityResults: [scan.id],
        qualityGateResults: [gateResult.id],
    });
    assert(rc.id !== undefined, 'Release candidate created');

    // === Release Approval ===
    const approval = control.requestReleaseApproval(rc.id, 'admin', 'production');
    assert(approval.decision === 'REQUESTED', 'Approval requested');
    control.approveRelease(approval.id, 'APPROVED');
    assert(control.getStore().releaseCandidates.get(rc.id).state === 'APPROVED', 'Release candidate approved');

    // === Deployment ===
    const deployPlan = control.createDeploymentPlan({
        releaseCandidateId: rc.id,
        environment: 'prod',
        strategy: 'canary',
    });
    const deployment = control.deployRelease({
        deploymentPlanId: deployPlan.id,
        targetId: 'target-1',
        status: 'SUCCESS',
        idempotencyKey: 'deploy-1',
    });
    assert(deployment.status === 'SUCCESS', 'Deployment success');
    const deployDup = control.deployRelease({ ...deployment, idempotencyKey: 'deploy-1' });
    assert(deployDup.id === deployment.id, 'Duplicate deployment prevented');

    // === Deployment Verification ===
    const verification = control.verifyDeployment(deployment.id, 'VERIFIED', { health: 'OK' });
    assert(verification.status === 'VERIFIED', 'Deployment verified');

    // === Checkpoints ===
    const checkpoint = control.createCheckpoint('PRODUCT', product.id, { state: 'IMPLEMENTING' });
    assert(checkpoint.id !== undefined, 'Checkpoint created');

    // === Failures, Recovery, Rollback ===
    const failure = control.recordFailure('BUILD', build.id, 'COMPILATION_ERROR', { error: 'missing semicolon' });
    assert(failure.id !== undefined, 'Failure recorded');
    const recovery = control.recoverFailure(failure.id, 'Fix semicolon and rebuild');
    assert(recovery.status === 'PLANNED', 'Recovery planned');
    const rollback = control.rollbackEntity('DEPLOYMENT', deployment.id, 'Rollback to previous version', 'rollback-key-1');
    assert(rollback.status === 'PLANNED', 'Rollback planned');

    // === Incidents & Escalation ===
    const incident = control.createIncident('BUILD', build.id, 'BUILD_FAILURE', 'HIGH', 'Build failed');
    const incidentDup = control.createIncident('BUILD', build.id, 'BUILD_FAILURE', 'HIGH', 'Build failed');
    assert(incident.id === incidentDup.id, 'Duplicate incident prevented');
    const escalation = control.escalateIncident(incident.id, 2, 'Critical build issue');
    assert(escalation.level === 2, 'Escalation level set');

    // === Circuit Breakers ===
    const breaker = control.openCircuitBreaker('PRODUCT', product.id);
    assert(breaker.state === 'OPEN', 'Breaker open');
    control.closeCircuitBreaker(breaker.id);
    assert(control.getStore().circuitBreakers.get(breaker.id).state === 'CLOSED', 'Breaker closed');

    // === Regression Detection ===
    const regression = control.detectRegression(product.id, 'PERFORMANCE', 'HIGH', { metric: 'latency', baseline: 100, current: 500 });
    assert(regression.severity === 'HIGH', 'Regression detected');

    // === Learning ===
    const learning = control.recordLearning(product.id, 'DEPLOYMENT', 'Canary deployment successful');
    assert(learning.content === 'Canary deployment successful', 'Learning recorded');

    // === Replay ===
    const hash = control.computeDeterministicHash(product.id);
    const replay = control.replayProduct(product.id, hash);
    assert(replay.divergence === 0, 'Replay no divergence');
    const replayDivergent = control.replayProduct(product.id, 'wronghash');
    assert(replayDivergent.divergence === 1, 'Replay divergence detected');

    // === Isolation Tests ===
    const product2 = control.createSoftwareProduct({
        factoryId: factory.id,
        organizationId: 'org2',
        name: 'Product B',
        idempotencyKey: 'product-key-2',
    });
    const lineage1 = control.getLineage(product.id);
    const lineage2 = control.getLineage(product2.id);
    assert(lineage2.every(n => n.product_id === product2.id), 'Lineage isolated per product');
    assert(lineage1.every(n => n.product_id === product.id), 'Lineage1 isolated');

    // === Stress Loops ===
    for (let i = 0; i < 50; i++) {
        const f = control.createSoftwareFactory({ organizationId: 'org', name: `Factory ${i}`, idempotencyKey: `factory-loop-${i}` });
        assert(f.id !== undefined, `Factory ${i} created`);
    }
    for (let i = 0; i < 50; i++) {
        const p = control.createSoftwareProduct({ factoryId: factory.id, organizationId: 'org', name: `Product ${i}`, idempotencyKey: `product-loop-${i}` });
        assert(p.id !== undefined, `Product ${i} created`);
    }
    for (let i = 0; i < 50; i++) {
        const r = control.createRequirement({ productId: product.id, type: 'FUNCTIONAL', description: `Req ${i}`, idempotencyKey: `req-loop-${i}` });
        assert(r.id !== undefined, `Requirement ${i} created`);
    }
    for (let i = 0; i < 40; i++) {
        const a = control.createArchitecture({ productId: product.id, type: 'SYSTEM', content: `Arch ${i}` });
        assert(a.id !== undefined, `Architecture ${i} created`);
    }
    for (let i = 0; i < 40; i++) {
        const p = control.createImplementationPlan({ productId: product.id, planData: { index: i } });
        assert(p.id !== undefined, `Implementation plan ${i} created`);
    }
    for (let i = 0; i < 40; i++) {
        const c = control.createCodeChange({ productId: product.id, repositoryId: repo.id, branchId: branch.id, idempotencyKey: `change-loop-${i}` });
        assert(c.id !== undefined, `Change ${i} created`);
    }
    for (let i = 0; i < 40; i++) {
        const r = control.reviewCodeChange(change.id, 'reviewer', [], 'PASS');
        assert(r.decision === 'PASS', `Review ${i} passed`);
    }
    for (let i = 0; i < 40; i++) {
        const t = control.executeTests({ suiteId: suite.id, environment: 'dev', commitHash: 'abc123', status: 'PASSED', idempotencyKey: `test-loop-${i}` });
        assert(t.status === 'PASSED', `Test ${i} passed`);
    }
    for (let i = 0; i < 40; i++) {
        const b = control.executeBuild({ buildPlanId: buildPlan.id, sourceRevision: 'abc123', buildEnvironment: 'linux', status: 'SUCCESS', idempotencyKey: `build-loop-${i}` });
        assert(b.status === 'SUCCESS', `Build ${i} success`);
    }
    for (let i = 0; i < 30; i++) {
        const a = control.registerArtifact({ buildExecutionId: build.id, path: `/artifact-${i}.zip`, checksum: `sha256:${i}`, sourceCommitHash: 'abc123' });
        assert(a.id !== undefined, `Artifact ${i} registered`);
    }
    for (let i = 0; i < 30; i++) {
        const rc = control.createReleaseCandidate({ productId: product.id, sourceCommitHash: 'abc123', buildExecutionId: build.id });
        assert(rc.id !== undefined, `RC ${i} created`);
    }
    for (let i = 0; i < 30; i++) {
        const d = control.deployRelease({ deploymentPlanId: deployPlan.id, targetId: `target-${i}`, status: 'SUCCESS', idempotencyKey: `deploy-loop-${i}` });
        assert(d.status === 'SUCCESS', `Deployment ${i} success`);
    }
    for (let i = 0; i < 30; i++) {
        const v = control.verifyDeployment(deployment.id, 'VERIFIED', { health: 'OK' });
        assert(v.status === 'VERIFIED', `Verification ${i} verified`);
    }
    for (let i = 0; i < 20; i++) {
        const f = control.recordFailure('TEST', `test-${i}`, 'FAILURE', { detail: i });
        assert(f.id !== undefined, `Failure ${i} recorded`);
    }
    for (let i = 0; i < 20; i++) {
        const r = control.replayProduct(product.id, hash);
        assert(r.divergence === 0, `Replay ${i} consistent`);
    }
    for (let i = 0; i < 20; i++) {
        const p = control.createSoftwareProduct({ factoryId: factory.id, organizationId: `org-iso-${i}`, name: `IsoProduct ${i}`, idempotencyKey: `iso-product-${i}` });
        const lin = control.getLineage(p.id);
        assert(lin.every(n => n.product_id === p.id), `Isolation ${i} lineage`);
    }

    // === Full Lifecycle End-to-End ===
    const e2eFactory = control.createSoftwareFactory({ organizationId: 'e2e-org', name: 'E2E Factory', idempotencyKey: 'e2e-factory' });
    const e2eProduct = control.createSoftwareProduct({
        factoryId: e2eFactory.id,
        organizationId: 'e2e-org',
        name: 'E2E Product',
        idempotencyKey: 'e2e-product',
        risk: 'LOW',
    });
    const e2eRepo = control.registerRepository({ productId: e2eProduct.id, provider: 'github', idempotencyKey: 'e2e-repo' });
    const e2eBranch = control.createBranch(e2eRepo.id, 'main', true);
    const e2eReq = control.createRequirement({ productId: e2eProduct.id, type: 'FUNCTIONAL', description: 'E2E requirement', idempotencyKey: 'e2e-req' });
    const e2eArch = control.createArchitecture({ productId: e2eProduct.id, type: 'SYSTEM', content: 'E2E architecture' });
    control.activateArchitecture(e2eArch.id);
    const e2eDesign = control.createTechnicalDesign({ productId: e2eProduct.id, type: 'API', content: 'E2E design' });
    const e2ePlan = control.createImplementationPlan({ productId: e2eProduct.id, planData: { steps: ['code', 'test', 'deploy'] } });
    const e2eStep = control.addImplementationStep(e2ePlan.id, { order: 1, type: 'CODE' });
    const e2eChange = control.createCodeChange({ productId: e2eProduct.id, repositoryId: e2eRepo.id, branchId: e2eBranch.id, requirementId: e2eReq.id, idempotencyKey: 'e2e-change' });
    control.addCodeChangeFile(e2eChange.id, { path: 'src/index.ts', operation: 'ADD', content: 'hello', checksum: 'hash1' });
    const e2eReview = control.reviewCodeChange(e2eChange.id, 'reviewer', [], 'PASS');
    const e2eTestPlan = control.createTestPlan({ productId: e2eProduct.id, planData: {} });
    const e2eSuite = control.createTestSuite(e2eTestPlan.id, 'Unit', 'unit');
    const e2eTestExec = control.executeTests({ suiteId: e2eSuite.id, environment: 'dev', commitHash: 'abc123', status: 'PASSED', idempotencyKey: 'e2e-test' });
    const e2eBuildPlan = control.createBuildPlan({ productId: e2eProduct.id, planData: {} });
    const e2eBuild = control.executeBuild({ buildPlanId: e2eBuildPlan.id, sourceRevision: 'abc123', buildEnvironment: 'linux', status: 'SUCCESS', idempotencyKey: 'e2e-build' });
    const e2eArtifact = control.registerArtifact({ buildExecutionId: e2eBuild.id, path: '/app.zip', checksum: 'sha256:e2e', sourceCommitHash: 'abc123' });
    const e2eScan = control.runSecurityScan({ productId: e2eProduct.id, scanType: 'SAST', targetRef: 'abc123', status: 'COMPLETED', idempotencyKey: 'e2e-scan' });
    const e2eGate = control.createQualityGate({ productId: e2eProduct.id, gateData: {} });
    const e2eGateResult = control.evaluateQualityGate(e2eGate.id, { result: 'PASS' });
    const e2eRC = control.createReleaseCandidate({
        productId: e2eProduct.id,
        sourceCommitHash: 'abc123',
        buildExecutionId: e2eBuild.id,
        artifacts: [e2eArtifact.id],
        testResults: [e2eTestExec.id],
        securityResults: [e2eScan.id],
        qualityGateResults: [e2eGateResult.id],
    });
    const e2eApproval = control.requestReleaseApproval(e2eRC.id, 'admin');
    control.approveRelease(e2eApproval.id, 'APPROVED');
    const e2eDeployPlan = control.createDeploymentPlan({ releaseCandidateId: e2eRC.id, environment: 'prod', strategy: 'canary' });
    const e2eDeployment = control.deployRelease({ deploymentPlanId: e2eDeployPlan.id, targetId: 'prod-1', status: 'SUCCESS', idempotencyKey: 'e2e-deploy' });
    const e2eVerification = control.verifyDeployment(e2eDeployment.id, 'VERIFIED', { health: 'OK' });
    // Lineage check
    const e2eLineage = control.getLineage(e2eProduct.id);
    const requiredNodes = ['PRODUCT', 'REPOSITORY', 'REQUIREMENT', 'ARCHITECTURE', 'DESIGN', 'IMPLEMENTATION_PLAN', 'CODE_CHANGE', 'RELEASE_CANDIDATE'];
    for (const nodeType of requiredNodes) {
        assert(e2eLineage.some(n => n.node_type === nodeType), `Lineage contains ${nodeType}`);
    }

    console.log('----------------------------------------');
    console.log(`Phase 97 test suite completed.`);
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
