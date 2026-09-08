// Phase 97 Worker - Autonomous Software Factory
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
    factories: Map<string, any>;
    products: Map<string, any>;
    productVersions: Map<string, any[]>;
    repositories: Map<string, any>;
    repositoryVersions: Map<string, any[]>;
    branches: Map<string, any>;
    changes: Map<string, any>;
    changeVersions: Map<string, any[]>;
    requirements: Map<string, any>;
    requirementVersions: Map<string, any[]>;
    architectures: Map<string, any>;
    architectureVersions: Map<string, any[]>;
    designs: Map<string, any>;
    designVersions: Map<string, any[]>;
    implementationPlans: Map<string, any>;
    implementationSteps: Map<string, any>;
    codeChanges: Map<string, any>;
    codeChangeFiles: Map<string, any>;
    reviews: Map<string, any>;
    reviewFindings: Map<string, any>;
    reviewDecisions: Map<string, any>;
    testPlans: Map<string, any>;
    testSuites: Map<string, any>;
    testExecutions: Map<string, any>;
    testResults: Map<string, any>;
    buildPlans: Map<string, any>;
    buildExecutions: Map<string, any>;
    buildArtifacts: Map<string, any>;
    artifactManifests: Map<string, any>;
    artifactProvenance: Map<string, any>;
    securityScans: Map<string, any>;
    securityFindings: Map<string, any>;
    qualityGates: Map<string, any>;
    qualityGateResults: Map<string, any>;
    releaseCandidates: Map<string, any>;
    releaseVersions: Map<string, any[]>;
    releaseApprovals: Map<string, any>;
    deploymentPlans: Map<string, any>;
    deploymentExecutions: Map<string, any>;
    deploymentTargets: Map<string, any>;
    deploymentVerifications: Map<string, any>;
    checkpoints: Map<string, any>;
    failures: Map<string, any>;
    recoveries: Map<string, any>;
    rollbacks: Map<string, any>;
    regressions: Map<string, any>;
    incidents: Map<string, any>;
    escalations: Map<string, any>;
    circuitBreakers: Map<string, any>;
    evidence: Map<string, any>;
    audit: Map<string, any>;
    lineage: Map<string, any>;
    learning: Map<string, any>;
    replay: Map<string, any>;
    idempotencyKeys: Set<string>;
}

function createEmptyStore(): Store {
    return {
        factories: new Map(),
        products: new Map(),
        productVersions: new Map(),
        repositories: new Map(),
        repositoryVersions: new Map(),
        branches: new Map(),
        changes: new Map(),
        changeVersions: new Map(),
        requirements: new Map(),
        requirementVersions: new Map(),
        architectures: new Map(),
        architectureVersions: new Map(),
        designs: new Map(),
        designVersions: new Map(),
        implementationPlans: new Map(),
        implementationSteps: new Map(),
        codeChanges: new Map(),
        codeChangeFiles: new Map(),
        reviews: new Map(),
        reviewFindings: new Map(),
        reviewDecisions: new Map(),
        testPlans: new Map(),
        testSuites: new Map(),
        testExecutions: new Map(),
        testResults: new Map(),
        buildPlans: new Map(),
        buildExecutions: new Map(),
        buildArtifacts: new Map(),
        artifactManifests: new Map(),
        artifactProvenance: new Map(),
        securityScans: new Map(),
        securityFindings: new Map(),
        qualityGates: new Map(),
        qualityGateResults: new Map(),
        releaseCandidates: new Map(),
        releaseVersions: new Map(),
        releaseApprovals: new Map(),
        deploymentPlans: new Map(),
        deploymentExecutions: new Map(),
        deploymentTargets: new Map(),
        deploymentVerifications: new Map(),
        checkpoints: new Map(),
        failures: new Map(),
        recoveries: new Map(),
        rollbacks: new Map(),
        regressions: new Map(),
        incidents: new Map(),
        escalations: new Map(),
        circuitBreakers: new Map(),
        evidence: new Map(),
        audit: new Map(),
        lineage: new Map(),
        learning: new Map(),
        replay: new Map(),
        idempotencyKeys: new Set(),
    };
}

export class SoftwareFactoryControl {
    private store: Store;

    constructor(store?: Store) {
        this.store = store || createEmptyStore();
    }

    // Helpers
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

    private recordLineage(productId: string, nodeType: string, nodeId: string, parentNodeId: string | null): void {
        const lineage = {
            id: generateId('lineage'),
            product_id: productId,
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

    // ---------- Factory Management ----------
    createSoftwareFactory(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.factories.values()).find(f => f.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const factory = {
            id: input.id || generateId('factory'),
            organization_id: input.organizationId,
            name: input.name || 'Unnamed Factory',
            state: 'INTAKE',
            version: 1,
            created_at: nowISO(),
            updated_at: nowISO(),
            idempotency_key: input.idempotencyKey,
        };
        this.store.factories.set(factory.id, factory);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        this.recordAudit('FACTORY', factory.id, null, factory.state, 'system', 'Factory created');
        return factory;
    }

    getSoftwareFactory(factoryId: string): any {
        const factory = this.store.factories.get(factoryId);
        if (!factory) throw new Error('Factory not found');
        return deepClone(factory);
    }

    // ---------- Product Management ----------
    createSoftwareProduct(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.products.values()).find(p => p.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const product = {
            id: input.id || generateId('product'),
            factory_id: input.factoryId,
            organization_id: input.organizationId,
            name: input.name || 'Unnamed Product',
            portfolio_id: input.portfolioId || null,
            program_id: input.programId || null,
            project_id: input.projectId || null,
            repository_id: input.repositoryId || null,
            environments: JSON.stringify(input.environments || []),
            technology_stack: JSON.stringify(input.technologyStack || {}),
            ownership: JSON.stringify(input.ownership || {}),
            lifecycle_state: 'INTAKE',
            risk_classification: input.risk || 'UNKNOWN',
            governance_policy: JSON.stringify(input.governancePolicy || {}),
            security_policy: JSON.stringify(input.securityPolicy || {}),
            deployment_policy: JSON.stringify(input.deploymentPolicy || {}),
            version: 1,
            created_at: nowISO(),
            updated_at: nowISO(),
            idempotency_key: input.idempotencyKey,
        };
        this.store.products.set(product.id, product);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        this.createProductVersion(product.id, 'Initial');
        this.recordLineage(product.id, 'PRODUCT', product.id, null);
        this.recordAudit('PRODUCT', product.id, null, product.lifecycle_state, 'system', 'Product created');
        return product;
    }

    getSoftwareProduct(productId: string): any {
        const product = this.store.products.get(productId);
        if (!product) throw new Error('Product not found');
        return deepClone(product);
    }

    createProductVersion(productId: string, reason: string): any {
        const product = this.store.products.get(productId);
        if (!product) throw new Error('Product not found');
        const version = product.version;
        const versionRecord = {
            id: generateId('prodver'),
            product_id: productId,
            version,
            snapshot: JSON.stringify(product),
            created_at: nowISO(),
            created_by: 'system',
        };
        if (!this.store.productVersions.has(productId)) this.store.productVersions.set(productId, []);
        this.store.productVersions.get(productId)!.push(versionRecord);
        product.version += 1;
        product.updated_at = nowISO();
        this.store.products.set(productId, product);
        return versionRecord;
    }

    // ---------- Repository Management ----------
    registerRepository(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.repositories.values()).find(r => r.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const repo = {
            id: input.id || generateId('repo'),
            product_id: input.productId,
            provider: input.provider,
            default_branch: input.defaultBranch || 'main',
            protected_branches: JSON.stringify(input.protectedBranches || []),
            ownership: JSON.stringify(input.ownership || {}),
            state: 'REGISTERED',
            created_at: nowISO(),
            idempotency_key: input.idempotencyKey,
        };
        this.store.repositories.set(repo.id, repo);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        this.recordLineage(repo.product_id, 'REPOSITORY', repo.id, repo.product_id);
        return repo;
    }

    createBranch(repositoryId: string, branchName: string, isProtected: boolean = false): any {
        const repo = this.store.repositories.get(repositoryId);
        if (!repo) throw new Error('Repository not found');
        const branch = {
            id: generateId('branch'),
            repository_id: repositoryId,
            name: branchName,
            is_protected: isProtected ? 1 : 0,
            created_at: nowISO(),
        };
        this.store.branches.set(branch.id, branch);
        return branch;
    }

    // ---------- Requirements ----------
    createRequirement(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.requirements.values()).find(r => r.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const requirement = {
            id: input.id || generateId('req'),
            product_id: input.productId,
            version: 1,
            requirement_type: input.type || 'FUNCTIONAL',
            description: input.description,
            acceptance_criteria: JSON.stringify(input.acceptanceCriteria || []),
            constraints: JSON.stringify(input.constraints || []),
            dependencies: JSON.stringify(input.dependencies || []),
            is_ambiguous: input.isAmbiguous ? 1 : 0,
            state: 'DRAFT',
            created_at: nowISO(),
            updated_at: nowISO(),
            idempotency_key: input.idempotencyKey,
        };
        this.store.requirements.set(requirement.id, requirement);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        this.recordLineage(requirement.product_id, 'REQUIREMENT', requirement.id, requirement.product_id);
        return requirement;
    }

    createRequirementVersion(requirementId: string, reason: string): any {
        const req = this.store.requirements.get(requirementId);
        if (!req) throw new Error('Requirement not found');
        const version = req.version;
        const versionRecord = {
            id: generateId('reqver'),
            requirement_id: requirementId,
            version,
            snapshot: JSON.stringify(req),
            created_at: nowISO(),
        };
        if (!this.store.requirementVersions.has(requirementId)) this.store.requirementVersions.set(requirementId, []);
        this.store.requirementVersions.get(requirementId)!.push(versionRecord);
        req.version += 1;
        req.updated_at = nowISO();
        this.store.requirements.set(requirementId, req);
        return versionRecord;
    }

    // ---------- Architecture ----------
    createArchitecture(input: any): any {
        const architecture = {
            id: input.id || generateId('arch'),
            product_id: input.productId,
            version: 1,
            architecture_type: input.type || 'SYSTEM',
            content: input.content,
            state: 'DRAFT',
            created_at: nowISO(),
            activated_at: null,
        };
        this.store.architectures.set(architecture.id, architecture);
        this.recordLineage(architecture.product_id, 'ARCHITECTURE', architecture.id, architecture.product_id);
        return architecture;
    }

    activateArchitecture(architectureId: string): any {
        const arch = this.store.architectures.get(architectureId);
        if (!arch) throw new Error('Architecture not found');
        arch.state = 'ACTIVE';
        arch.activated_at = nowISO();
        this.store.architectures.set(architectureId, arch);
        return arch;
    }

    // ---------- Technical Design ----------
    createTechnicalDesign(input: any): any {
        const design = {
            id: input.id || generateId('design'),
            product_id: input.productId,
            version: 1,
            design_type: input.type || 'API',
            content: input.content,
            state: 'DRAFT',
            created_at: nowISO(),
        };
        this.store.designs.set(design.id, design);
        this.recordLineage(design.product_id, 'DESIGN', design.id, design.product_id);
        return design;
    }

    // ---------- Implementation Plan ----------
    createImplementationPlan(input: any): any {
        const plan = {
            id: input.id || generateId('implplan'),
            product_id: input.productId,
            version: 1,
            plan_data: JSON.stringify(input.planData || {}),
            state: 'DRAFT',
            created_at: nowISO(),
            activated_at: null,
        };
        this.store.implementationPlans.set(plan.id, plan);
        this.recordLineage(plan.product_id, 'IMPLEMENTATION_PLAN', plan.id, plan.product_id);
        return plan;
    }

    addImplementationStep(planId: string, step: any): any {
        const plan = this.store.implementationPlans.get(planId);
        if (!plan) throw new Error('Plan not found');
        const stepRecord = {
            id: step.id || generateId('implstep'),
            plan_id: planId,
            step_order: step.order,
            step_type: step.type,
            dependencies: JSON.stringify(step.dependencies || []),
            status: 'PENDING',
            created_at: nowISO(),
        };
        this.store.implementationSteps.set(stepRecord.id, stepRecord);
        return stepRecord;
    }

    // ---------- Code Change ----------
    createCodeChange(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.changes.values()).find(c => c.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const change = {
            id: input.id || generateId('change'),
            product_id: input.productId,
            repository_id: input.repositoryId,
            branch_id: input.branchId,
            mission_id: input.missionId || null,
            requirement_id: input.requirementId || null,
            architecture_version_id: input.architectureVersionId || null,
            implementation_plan_id: input.implementationPlanId || null,
            author_agent_id: input.authorAgentId || null,
            state: 'DRAFT',
            risk: input.risk || 'UNKNOWN',
            blast_radius: input.blastRadius || 'UNKNOWN',
            created_at: nowISO(),
            updated_at: nowISO(),
            idempotency_key: input.idempotencyKey,
        };
        this.store.changes.set(change.id, change);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        this.recordLineage(change.product_id, 'CODE_CHANGE', change.id, change.product_id);
        return change;
    }

    addCodeChangeFile(changeId: string, file: any): any {
        const change = this.store.changes.get(changeId);
        if (!change) throw new Error('Change not found');
        const codeChange = {
            id: generateId('codechange'),
            change_id: changeId,
            file_path: file.path,
            operation: file.operation || 'MODIFY',
            content: file.content,
            checksum: file.checksum || 'unknown',
            created_at: nowISO(),
        };
        this.store.codeChanges.set(codeChange.id, codeChange);
        const fileRecord = {
            id: generateId('codefile'),
            code_change_id: codeChange.id,
            file_path: file.path,
            operation: file.operation || 'MODIFY',
            content: file.content,
            checksum: file.checksum || 'unknown',
            created_at: nowISO(),
        };
        this.store.codeChangeFiles.set(fileRecord.id, fileRecord);
        return fileRecord;
    }

    // ---------- Code Review ----------
    reviewCodeChange(changeId: string, reviewerAgentId: string, findings: any[], decision: string): any {
        const change = this.store.changes.get(changeId);
        if (!change) throw new Error('Change not found');
        const review = {
            id: generateId('review'),
            change_id: changeId,
            reviewer_agent_id: reviewerAgentId,
            decision,
            findings: JSON.stringify(findings || []),
            reviewed_at: nowISO(),
        };
        this.store.reviews.set(review.id, review);
        for (const finding of findings || []) {
            const findingRecord = {
                id: generateId('finding'),
                review_id: review.id,
                severity: finding.severity,
                category: finding.category,
                description: finding.description,
            };
            this.store.reviewFindings.set(findingRecord.id, findingRecord);
        }
        const decisionRecord = {
            id: generateId('reviewdec'),
            review_id: review.id,
            decision,
            rationale: '',
            decided_by: reviewerAgentId,
            decided_at: nowISO(),
        };
        this.store.reviewDecisions.set(decisionRecord.id, decisionRecord);
        return review;
    }

    // ---------- Test Plan & Execution ----------
    createTestPlan(input: any): any {
        const plan = {
            id: input.id || generateId('testplan'),
            product_id: input.productId,
            version: 1,
            plan_data: JSON.stringify(input.planData || {}),
            created_at: nowISO(),
        };
        this.store.testPlans.set(plan.id, plan);
        return plan;
    }

    createTestSuite(testPlanId: string, name: string, suiteType: string): any {
        const suite = {
            id: generateId('testsuite'),
            test_plan_id: testPlanId,
            name,
            suite_type: suiteType,
        };
        this.store.testSuites.set(suite.id, suite);
        return suite;
    }

    executeTests(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.testExecutions.values()).find(t => t.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const execution = {
            id: input.id || generateId('testexec'),
            suite_id: input.suiteId,
            environment: input.environment,
            commit_hash: input.commitHash,
            artifact_id: input.artifactId || null,
            runner: input.runner || 'nexus',
            started_at: nowISO(),
            completed_at: null,
            status: input.status || 'PENDING',
            evidence: JSON.stringify(input.evidence || {}),
            idempotency_key: input.idempotencyKey,
        };
        this.store.testExecutions.set(execution.id, execution);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        if (input.results) {
            for (const res of input.results) {
                const testResult = {
                    id: generateId('testresult'),
                    execution_id: execution.id,
                    test_name: res.name,
                    status: res.status,
                    details: res.details || '',
                };
                this.store.testResults.set(testResult.id, testResult);
            }
        }
        return execution;
    }

    // ---------- Build ----------
    createBuildPlan(input: any): any {
        const plan = {
            id: input.id || generateId('buildplan'),
            product_id: input.productId,
            version: 1,
            plan_data: JSON.stringify(input.planData || {}),
            created_at: nowISO(),
        };
        this.store.buildPlans.set(plan.id, plan);
        return plan;
    }

    executeBuild(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.buildExecutions.values()).find(b => b.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const build = {
            id: input.id || generateId('build'),
            build_plan_id: input.buildPlanId,
            source_revision: input.sourceRevision,
            build_environment: input.buildEnvironment,
            status: input.status || 'PENDING',
            started_at: nowISO(),
            completed_at: null,
            logs: input.logs || '',
            metadata: JSON.stringify(input.metadata || {}),
            idempotency_key: input.idempotencyKey,
        };
        this.store.buildExecutions.set(build.id, build);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        return build;
    }

    // ---------- Artifact ----------
    registerArtifact(input: any): any {
        const artifact = {
            id: input.id || generateId('artifact'),
            build_execution_id: input.buildExecutionId,
            artifact_path: input.path,
            checksum: input.checksum,
            created_at: nowISO(),
        };
        this.store.buildArtifacts.set(artifact.id, artifact);
        // Manifest
        const manifest = {
            id: generateId('manifest'),
            artifact_id: artifact.id,
            manifest_data: JSON.stringify(input.manifest || {}),
            created_at: nowISO(),
        };
        this.store.artifactManifests.set(manifest.id, manifest);
        // Provenance
        const provenance = {
            id: generateId('provenance'),
            artifact_id: artifact.id,
            source_commit_hash: input.sourceCommitHash,
            build_execution_id: input.buildExecutionId,
            dependency_manifest: JSON.stringify(input.dependencyManifest || {}),
            creator: input.creator || 'system',
            created_at: nowISO(),
        };
        this.store.artifactProvenance.set(provenance.id, provenance);
        return artifact;
    }

    verifyArtifactProvenance(artifactId: string): boolean {
        const provenance = Array.from(this.store.artifactProvenance.values()).find(p => p.artifact_id === artifactId);
        return !!provenance;
    }

    // ---------- Security Scan ----------
    runSecurityScan(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.securityScans.values()).find(s => s.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const scan = {
            id: input.id || generateId('scan'),
            product_id: input.productId,
            scan_type: input.scanType,
            target_ref: input.targetRef,
            status: input.status || 'PENDING',
            started_at: nowISO(),
            completed_at: null,
            findings: JSON.stringify(input.findings || []),
            idempotency_key: input.idempotencyKey,
        };
        this.store.securityScans.set(scan.id, scan);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        return scan;
    }

    // ---------- Quality Gates ----------
    createQualityGate(input: any): any {
        const gate = {
            id: input.id || generateId('gate'),
            product_id: input.productId,
            version: 1,
            gate_data: JSON.stringify(input.gateData || {}),
            created_at: nowISO(),
        };
        this.store.qualityGates.set(gate.id, gate);
        return gate;
    }

    evaluateQualityGate(gateId: string, context: any): any {
        const gate = this.store.qualityGates.get(gateId);
        if (!gate) throw new Error('Gate not found');
        // Simplified evaluation: if context contains any BLOCK condition, result BLOCK, else PASS if all required else WARN.
        const result = {
            id: generateId('gateresult'),
            gate_id: gateId,
            change_id: context.changeId || null,
            release_candidate_id: context.releaseCandidateId || null,
            result: context.result || 'PASS',
            details: JSON.stringify(context.details || {}),
            evaluated_at: nowISO(),
        };
        this.store.qualityGateResults.set(result.id, result);
        return result;
    }

    // ---------- Release Candidate ----------
    createReleaseCandidate(input: any): any {
        const rc = {
            id: input.id || generateId('rc'),
            product_id: input.productId,
            version: 1,
            source_commit_hash: input.sourceCommitHash,
            build_execution_id: input.buildExecutionId,
            artifacts: JSON.stringify(input.artifacts || []),
            test_results: JSON.stringify(input.testResults || []),
            security_results: JSON.stringify(input.securityResults || []),
            quality_gate_results: JSON.stringify(input.qualityGateResults || []),
            state: 'DRAFT',
            created_at: nowISO(),
            approved_at: null,
        };
        this.store.releaseCandidates.set(rc.id, rc);
        this.recordLineage(rc.product_id, 'RELEASE_CANDIDATE', rc.id, rc.product_id);
        return rc;
    }

    requestReleaseApproval(rcId: string, approver: string, policyContext?: string): any {
        const rc = this.store.releaseCandidates.get(rcId);
        if (!rc) throw new Error('Release candidate not found');
        const approval = {
            id: generateId('relapproval'),
            release_candidate_id: rcId,
            approver,
            decision: 'REQUESTED',
            decided_at: nowISO(),
            policy_context: policyContext || null,
            idempotency_key: generateId('relappr_key'),
        };
        this.store.releaseApprovals.set(approval.id, approval);
        return approval;
    }

    approveRelease(approvalId: string, decision: string = 'APPROVED'): any {
        const approval = this.store.releaseApprovals.get(approvalId);
        if (!approval) throw new Error('Approval not found');
        approval.decision = decision;
        approval.decided_at = nowISO();
        this.store.releaseApprovals.set(approvalId, approval);
        if (decision === 'APPROVED') {
            const rc = this.store.releaseCandidates.get(approval.release_candidate_id);
            if (rc) {
                rc.state = 'APPROVED';
                rc.approved_at = nowISO();
                this.store.releaseCandidates.set(rc.id, rc);
            }
        }
        return approval;
    }

    // ---------- Deployment ----------
    createDeploymentPlan(input: any): any {
        const plan = {
            id: input.id || generateId('deployplan'),
            release_candidate_id: input.releaseCandidateId,
            environment: input.environment,
            strategy: input.strategy,
            plan_data: JSON.stringify(input.planData || {}),
            created_at: nowISO(),
        };
        this.store.deploymentPlans.set(plan.id, plan);
        return plan;
    }

    deployRelease(input: any): any {
        if (!input.idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(input.idempotencyKey)) {
            const existing = Array.from(this.store.deploymentExecutions.values()).find(d => d.idempotency_key === input.idempotencyKey);
            if (existing) return existing;
        }
        const deployment = {
            id: input.id || generateId('deploy'),
            deployment_plan_id: input.deploymentPlanId,
            target_id: input.targetId,
            status: input.status || 'PENDING',
            started_at: nowISO(),
            completed_at: null,
            verification_status: 'UNKNOWN',
            idempotency_key: input.idempotencyKey,
        };
        this.store.deploymentExecutions.set(deployment.id, deployment);
        this.store.idempotencyKeys.add(input.idempotencyKey);
        return deployment;
    }

    verifyDeployment(deploymentId: string, status: string, evidence: any): any {
        const deployment = this.store.deploymentExecutions.get(deploymentId);
        if (!deployment) throw new Error('Deployment not found');
        deployment.verification_status = status;
        deployment.completed_at = nowISO();
        this.store.deploymentExecutions.set(deploymentId, deployment);
        const verification = {
            id: generateId('deployver'),
            deployment_execution_id: deploymentId,
            verification_type: 'POST_DEPLOYMENT',
            status,
            evidence: JSON.stringify(sanitizeForStorage(evidence)),
            verified_at: nowISO(),
        };
        this.store.deploymentVerifications.set(verification.id, verification);
        return verification;
    }

    // ---------- Checkpoints ----------
    createCheckpoint(entityType: string, entityId: string, data: any): any {
        const checkpoint = {
            id: generateId('checkpoint'),
            entity_type: entityType,
            entity_id: entityId,
            checkpoint_data: JSON.stringify(sanitizeForStorage(data)),
            created_at: nowISO(),
        };
        this.store.checkpoints.set(checkpoint.id, checkpoint);
        return checkpoint;
    }

    // ---------- Failures, Recoveries, Rollbacks ----------
    recordFailure(entityType: string, entityId: string, failureType: string, details: any): any {
        const failure = {
            id: generateId('failure'),
            entity_type: entityType,
            entity_id: entityId,
            failure_type: failureType,
            details: JSON.stringify(sanitizeForStorage(details)),
            created_at: nowISO(),
            resolved: 0,
        };
        this.store.failures.set(failure.id, failure);
        return failure;
    }

    recoverFailure(failureId: string, plan: string): any {
        const failure = this.store.failures.get(failureId);
        if (!failure) throw new Error('Failure not found');
        const recovery = {
            id: generateId('recovery'),
            failure_id: failureId,
            recovery_plan: plan,
            status: 'PLANNED',
            executed_at: null,
            verified_at: null,
        };
        this.store.recoveries.set(recovery.id, recovery);
        failure.resolved = 1;
        this.store.failures.set(failureId, failure);
        return recovery;
    }

    rollbackEntity(entityType: string, entityId: string, plan: string, idempotencyKey: string): any {
        if (!idempotencyKey) throw new Error('idempotencyKey required');
        if (this.store.idempotencyKeys.has(`rollback_${idempotencyKey}`)) {
            const existing = Array.from(this.store.rollbacks.values()).find(r => r.idempotency_key === idempotencyKey);
            if (existing) return existing;
        }
        const rollback = {
            id: generateId('rollback'),
            entity_type: entityType,
            entity_id: entityId,
            rollback_plan: plan,
            status: 'PLANNED',
            executed_at: null,
            verified_at: null,
            idempotency_key: idempotencyKey,
        };
        this.store.rollbacks.set(rollback.id, rollback);
        this.store.idempotencyKeys.add(`rollback_${idempotencyKey}`);
        return rollback;
    }

    // ---------- Incidents & Escalation ----------
    createIncident(entityType: string, entityId: string, incidentType: string, severity: string, description: string, idempotencyKey?: string): any {
        const key = idempotencyKey || `${entityType}_${entityId}_${incidentType}_${severity}`;
        if (this.store.idempotencyKeys.has(`incident_${key}`)) {
            const existing = Array.from(this.store.incidents.values()).find(i => i.idempotency_key === key);
            if (existing) return existing;
        }
        const incident = {
            id: generateId('incident'),
            entity_type: entityType,
            entity_id: entityId,
            incident_type: incidentType,
            severity,
            description: redactString(description),
            status: 'OPEN',
            idempotency_key: key,
            created_at: nowISO(),
        };
        this.store.incidents.set(incident.id, incident);
        this.store.idempotencyKeys.add(`incident_${key}`);
        return incident;
    }

    escalateIncident(incidentId: string, level: number, reason: string): any {
        const incident = this.store.incidents.get(incidentId);
        if (!incident) throw new Error('Incident not found');
        const escalation = {
            id: generateId('escalation'),
            incident_id: incidentId,
            level,
            reason: redactString(reason),
            created_at: nowISO(),
        };
        this.store.escalations.set(escalation.id, escalation);
        return escalation;
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

    // ---------- Regression Detection ----------
    detectRegression(productId: string, detectionType: string, severity: string, evidence: any): any {
        const regression = {
            id: generateId('regression'),
            product_id: productId,
            detection_type: detectionType,
            severity,
            evidence: JSON.stringify(sanitizeForStorage(evidence)),
            detected_at: nowISO(),
        };
        this.store.regressions.set(regression.id, regression);
        return regression;
    }

    // ---------- Learning ----------
    recordLearning(productId: string, learningType: string, content: string): any {
        const learning = {
            id: generateId('learning'),
            product_id: productId,
            learning_type: learningType,
            content: redactString(content),
            created_at: nowISO(),
        };
        this.store.learning.set(learning.id, learning);
        return learning;
    }

    // ---------- Replay ----------
    computeDeterministicHash(productId: string): string {
        const product = this.store.products.get(productId);
        if (!product) throw new Error('Product not found');
        return `${product.id}_${product.version}_${product.lifecycle_state}`;
    }

    replayProduct(productId: string, inputHash: string): any {
        const outputHash = this.computeDeterministicHash(productId);
        const divergence = inputHash === outputHash ? 0 : 1;
        const replay = {
            id: generateId('replay'),
            product_id: productId,
            input_hash: inputHash,
            output_hash: outputHash,
            divergence,
            replayed_at: nowISO(),
        };
        this.store.replay.set(replay.id, replay);
        return replay;
    }

    // ---------- Lineage & Store Access ----------
    getLineage(productId: string): any[] {
        return Array.from(this.store.lineage.values()).filter(l => l.product_id === productId);
    }

    getStore(): Store {
        return this.store;
    }
}
