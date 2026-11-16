# Phase 304a - Scripts Directory Inventory (corrected)

Generated: 2026-11-16 08:45:31
Files discovered: 564

This audit is READ-ONLY. No script was executed. No file modified.
All cleanup recommendations are REVIEW_REQUIRED, never DELETE.

## Classification Summary
| ACTIVE_TEST | 133 |
| DORMANT_TEST | 112 |
| CHILD_HELPER | 12 |
| PHASE_RUNNER | 217 |
| ACTIVE_UTILITY | 4 |
| BACKUP | 10 |
| DEBUG_SCRATCH | 8 |
| EVIDENCE | 8 |
| PROTECTED_RISK | 18 |
| UNKNOWN | 42 |
| **Total** | **564** |

## PROTECTED_RISK - evidence-backed

### run-operations-regression.ts
- Path: `scripts/run-operations-regression.ts`
- Risks: AGGREGATE
- Evidence: 
- Spawned-by: run-phase7-certification.ts, run-phase8-certification.ts
- Cleanup: REVIEW_REQUIRED

### run-security-regression.ts
- Path: `scripts/run-security-regression.ts`
- Risks: AGGREGATE
- Evidence: 
- Spawned-by: run-phase7-certification.ts, run-phase8-certification.ts
- Cleanup: REVIEW_REQUIRED

### test-approval-artifact-binding.ts
- Path: `scripts/test-approval-artifact-binding.ts`
- Risks: STATE_FILE_MUTATION
- Evidence: STATE_FILE_MUTATION: import { ApprovalService } from "../src/core/approval-service.ts";
- Spawned-by: run-security-regression.ts
- Cleanup: REVIEW_REQUIRED

### test-approval-protection.ts
- Path: `scripts/test-approval-protection.ts`
- Risks: STATE_FILE_MUTATION
- Evidence: STATE_FILE_MUTATION: import { ReleaseService } from "../src/core/release-service.ts";
- Spawned-by: run-security-regression.ts
- Cleanup: REVIEW_REQUIRED

### test-artifact-signing.ts
- Path: `scripts/test-artifact-signing.ts`
- Risks: SIGNING
- Evidence: SIGNING: const signResult = await artifactSigningService.sign(digestRef);
- Spawned-by: 
- Cleanup: REVIEW_REQUIRED

### test-fail-safe.ts
- Path: `scripts/test-fail-safe.ts`
- Risks: STATE_FILE_MUTATION
- Evidence: STATE_FILE_MUTATION: import { ReleaseService } from "../src/core/release-service.ts";
- Spawned-by: run-security-regression.ts
- Cleanup: REVIEW_REQUIRED

### test-phase132-ci-reconciliation.ts
- Path: `scripts/test-phase132-ci-reconciliation.ts`
- Risks: DOCKER,NETWORK_GITHUB
- Evidence: DOCKER: (c.includes("docker/build-push-action") || c.includes("docker buildx")) && | NETWORK_GITHUB: archive_download_url: "https://api.github.com/repos/x/y/actions/artifacts/" + id + "/zip",
- Spawned-by: 
- Cleanup: REVIEW_REQUIRED

### test-phase135-ci-reconciliation-integrity.ts
- Path: `scripts/test-phase135-ci-reconciliation-integrity.ts`
- Risks: NETWORK_GITHUB
- Evidence: NETWORK_GITHUB: archive_download_url: "https://api.github.com/repos/x/y/actions/artifacts/" + id + "/zip",
- Spawned-by: 
- Cleanup: REVIEW_REQUIRED

### test-phase225-release-deployment.ts
- Path: `scripts/test-phase225-release-deployment.ts`
- Risks: DOCKER
- Evidence: DOCKER: try { execSync("docker rm -f nexus-225X-real", { stdio: "ignore", timeout: 10_000 }); } catch {}
- Spawned-by: 
- Cleanup: REVIEW_REQUIRED

### test-phase226-deployment-lifecycle.ts
- Path: `scripts/test-phase226-deployment-lifecycle.ts`
- Risks: DOCKER
- Evidence: DOCKER: try { execSync(`docker rm -f ${containerName}`, { stdio: "ignore", timeout: 10_000 }); } catch {}
- Spawned-by: 
- Cleanup: REVIEW_REQUIRED

### test-phase227-production-activation.ts
- Path: `scripts/test-phase227-production-activation.ts`
- Risks: DOCKER
- Evidence: DOCKER: try { execSync(`docker rm -f ${containerName}`, { stdio: "ignore", timeout: 10_000 }); } catch {}
- Spawned-by: 
- Cleanup: REVIEW_REQUIRED

### test-phase228-production-activation-reconciliation.ts
- Path: `scripts/test-phase228-production-activation-reconciliation.ts`
- Risks: DOCKER
- Evidence: DOCKER: try { execSync(`docker rm -f ${containerName}`, { stdio: "ignore", timeout: 10_000 }); } catch {}
- Spawned-by: 
- Cleanup: REVIEW_REQUIRED

### test-phase229-aws-production-traffic-integration.ts
- Path: `scripts/test-phase229-aws-production-traffic-integration.ts`
- Risks: DOCKER
- Evidence: DOCKER: try { execSync(`docker rm -f ${containerName}`, { stdio: "ignore", timeout: 10_000 }); } catch {}
- Spawned-by: 
- Cleanup: REVIEW_REQUIRED

### test-phase231-production-e2e-lifecycle.ts
- Path: `scripts/test-phase231-production-e2e-lifecycle.ts`
- Risks: DOCKER
- Evidence: DOCKER: try { execSync(`docker rm -f ${containerName}`, { stdio: "ignore", timeout: 10_000 }); } catch {}
- Spawned-by: 
- Cleanup: REVIEW_REQUIRED

### test-phase304-safe-runner.ts
- Path: `scripts/test-phase304-safe-runner.ts`
- Risks: AGGREGATE
- Evidence: AGGREGATE: test-phase304-safe-runner.ts spawns an aggregate regression runner
- Spawned-by: 
- Cleanup: REVIEW_REQUIRED

### test-release-flow.ts
- Path: `scripts/test-release-flow.ts`
- Risks: STATE_FILE_MUTATION
- Evidence: STATE_FILE_MUTATION: import { ReleaseService } from "../src/core/release-service.ts";
- Spawned-by: run-security-regression.ts
- Cleanup: REVIEW_REQUIRED

### test-rollback-safety.ts
- Path: `scripts/test-rollback-safety.ts`
- Risks: STATE_FILE_MUTATION
- Evidence: STATE_FILE_MUTATION: import { rollbackService } from "../src/core/rollback-service.ts";
- Spawned-by: run-security-regression.ts
- Cleanup: REVIEW_REQUIRED

### test-tamper-detection.ts
- Path: `scripts/test-tamper-detection.ts`
- Risks: SIGNING
- Evidence: SIGNING: await artifactSigningService.sign(origDigestRef);
- Spawned-by: run-security-regression.ts
- Cleanup: REVIEW_REQUIRED

## DORMANT_TEST - with indirect reference scan
- `nexus-host-bridge-redaction.mjs` (phase ) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `pin-actions.mjs` (phase ) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-failure-detection.ts` (phase ) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-pg-bootstrap-focused.ts` (phase ) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase117-rollback.ts` (phase 117) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase118-rollback-recovery.ts` (phase 118) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase119-rollback-recovery.ts` (phase 119) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase120-production-rollback-verification.ts` (phase 120) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase121-rollback-verification-evidence.ts` (phase 121) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase122-recovery-evidence-reconciliation.ts` (phase 122) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase123-production-recovery-evidence-integration.ts` (phase 123) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase124-durable-recovery-required.ts` (phase 124) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase125-recovery-supervisor.ts` (phase 125) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase126-execution-lifecycle.ts` (phase 126) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase127-execution-state-machine.ts` (phase 127) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase128-execution-completion.ts` (phase 128) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase135-ci-reconciliation-integrity.ts.phase135-backup` (phase 135) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase136-execution-recovery.ts` (phase 136) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase137-cancellation-timeout.ts` (phase 137) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase140-attempt-binding.ts` (phase 140) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase143-transactional-execution-recovery.ts` (phase 143) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase144-durable-recovery-operations.ts` (phase 144) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase145-reconciliation-integrity.ts` (phase 145) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase146-retry-budget-recovery.ts` (phase 146) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase147-durable-retry-scheduling.ts` (phase 147) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase147-retry-scheduling-integrity.ts` (phase 147) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase148-atomic-attempt-allocation.ts` (phase 148) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase149-attempt-lifecycle-integrity.ts` (phase 149) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase150-job-attempt-terminal-consistency.ts` (phase 150) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase151-recovery-finalization.ts` (phase 151) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase152-recovery-concurrency.ts` (phase 152) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase153-recovery-lease-fencing.ts` (phase 153) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase154-recovery-cancellation-shutdown.ts` (phase 154) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase155-strict-recovery-cancellation-fencing.ts` (phase 155) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase156-recovery-lifecycle-integrity.ts` (phase 156) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase157-recovery-operation-idempotency.ts` (phase 157) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase158-recovery-worker-heartbeat-lease.ts` (phase 158) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase159-recovery-admission-control.ts` (phase 159) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase160-recovery-scheduling-fairness.ts` (phase 160) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase161-recovery-scheduler-capacity.ts` (phase 161) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase162-worker-execution-authority.ts` (phase 162) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase163-execution-recovery-handoff.ts` (phase 163) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase164-execution-outcome-authority.ts` (phase 164) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase165-execution-evidence-provenance.ts` (phase 165) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase167-audit-provenance-control-plane.ts` (phase 167) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase169-project-membership-administration.ts` (phase 169) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase170-project-resource-authorization.ts` (phase 170) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase171-project-scoped-cicd-release-integrity.ts` (phase 171) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase183-final.ts` (phase 183) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase184-distributed-coordination.ts` (phase 184) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase185-distributed-scheduler.ts` (phase 185) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase186-distributed-dispatch.ts` (phase 186) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase187-attempt-lifecycle.ts` (phase 187) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase187-attempt-recovery.ts` (phase 187) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase188-attempt-completion.ts` (phase 188) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase189-result-integrity.ts` (phase 189) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase190-release-integrity.ts` (phase 190) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase192-restart-safety.ts` (phase 192) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase192-scheduler-lifecycle.ts` (phase 192) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase193-boot-failure.ts` (phase 193) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase193-concurrent-boot.ts` (phase 193) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase194-concurrent-lease.ts` (phase 194) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase194-execution-continuity.ts` (phase 194) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase195-migration-integrity.ts` (phase 195) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase196-execution-supervision.ts` (phase 196) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase197-stall-recovery.ts` (phase 197) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase198-ownership.ts` (phase 198) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase199-recovery-operation-reclaim.ts` (phase 199) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase200-recovery-finalization.ts` (phase 200) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase201-orchestrator-deps.ts` (phase 201) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase201-stage-dag.ts` (phase 201) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase204-execution-lifecycle.ts` (phase 204) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase209-verification-integrity.ts` (phase 209) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase210-release-safety.ts` (phase 210) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase212-release-recovery.ts` (phase 212) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase213-lifecycle-integrity.ts` (phase 213) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase214-engineering-run.ts` (phase 214) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase215-planning-architecture.ts` (phase 215) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase216-ai-provider.ts` (phase 216) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase217-external-provider.ts` (phase 217) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase217-implementation.ts` (phase 217) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase246-release-review-enforcement.ts` (phase 246) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase247-boundaries.ts` (phase 247) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase252-authorization-cas.ts` (phase 252) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase264-retry-eligibility.ts` (phase 264) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase265-recovery-reconciliation-integrity.ts` (phase 265) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase266-recovery-reconciliation-concurrency.ts` (phase 266) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase268-remote-result-integrity.ts` (phase 268) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase269-failure-injection.ts` (phase 269) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase269-recovery-observability.ts` (phase 269) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase286-worker-gateway-real-handler.ts` (phase 286) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase290b-worker-gateway-failure-modes.ts` (phase 290b) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase290-worker-gateway-concurrency.ts` (phase 290) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase291-migration-upgrade.ts` (phase 291) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase291-worker-gateway-recovery-acceptance.ts` (phase 291) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase291-worker-gateway-recovery-safety.ts` (phase 291) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase293c-persistent-sanitization.ts` (phase 293c) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase294-security-integrity.ts` (phase 294) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase295-security-mapping-integrity.ts` (phase 295) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase300-sqlite-race.ts` (phase 300) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase300-wp1-dispatch-persistence.ts` (phase 300) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase300-wp2-atomic-claiming.ts` (phase 300) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase300-wp3-cross-process.ts` (phase 300) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase300-wp4-gateway-routing.ts` (phase 300) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase300-wp5-reconciliation.ts` (phase 300) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase300-wp5-sqlite-fallback.ts` (phase 300) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase300-wp6-cancellation-status.ts` (phase 300) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-phase300-wp8-fresh-bootstrap.ts` (phase 300) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-security-scan-policy-adapter.ts` (phase ) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `test-worker-handler-schema-gate.ts` (phase ) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `verify-pass5.backup.mjs` (phase ) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)
- `verify-pass5.mjs` (phase ) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)

## PHASE_RUNNER - per-file removal safety
- `run-advanced-security-pipeline.ts` (phase , 9702 bytes) - REVIEW_REQUIRED
- `run-browser-smoke.ts` (phase , 2413 bytes) - REVIEW_REQUIRED
- `run-build-test-execution-tests.ts` (phase , 5911 bytes) - REVIEW_REQUIRED
- `run-canonical-deployment-e2e.ts` (phase , 7570 bytes) - REVIEW_REQUIRED
- `run-canonical-deployment-tests.ts` (phase , 81470 bytes) - REVIEW_REQUIRED
- `run-core-tests.ts` (phase , 2495 bytes) - REVIEW_REQUIRED
- `run-dast.ts` (phase , 919 bytes) - REVIEW_REQUIRED
- `run-docker-engineering-e2e.ts` (phase , 12389 bytes) - REVIEW_REQUIRED
- `run-dockerfile-validation-tests.ts` (phase , 3603 bytes) - REVIEW_REQUIRED
- `run-durable-gateway-tests.ts` (phase , 9799 bytes) - REVIEW_REQUIRED
- `run-execution-runtime-integration.ts` (phase , 22737 bytes) - REVIEW_REQUIRED
- `run-host-workspace-materialization-tests.mjs` (phase , 24193 bytes) - REVIEW_REQUIRED
- `run-host-workspace-tests.ts` (phase , 13190 bytes) - REVIEW_REQUIRED
- `run-kernel-gateway-integration.ts` (phase , 11413 bytes) - REVIEW_REQUIRED
- `run-observability.ts` (phase , 3574 bytes) - REVIEW_REQUIRED
- `run-phase100.ts` (phase 100, 13982 bytes) - REVIEW_REQUIRED
- `run-phase105-pass1.ts` (phase 105, 10142 bytes) - REVIEW_REQUIRED
- `run-phase105-pass2.ts` (phase 105, 30120 bytes) - REVIEW_REQUIRED
- `run-phase106-pass1.ts` (phase 106, 13122 bytes) - REVIEW_REQUIRED
- `run-phase10-pass1.ts` (phase 10, 17434 bytes) - REVIEW_REQUIRED
- `run-phase10-pass2.ts` (phase 10, 14560 bytes) - REVIEW_REQUIRED
- `run-phase10-pass3.ts` (phase 10, 21310 bytes) - REVIEW_REQUIRED
- `run-phase10-pass4.ts` (phase 10, 18269 bytes) - REVIEW_REQUIRED
- `run-phase10-pass5.ts` (phase 10, 22190 bytes) - REVIEW_REQUIRED
- `run-phase11-pass1.ts` (phase 11, 2845 bytes) - REVIEW_REQUIRED
- `run-phase12-pass1.ts` (phase 12, 13208 bytes) - REVIEW_REQUIRED
- `run-phase13-pass1.ts` (phase 13, 24495 bytes) - REVIEW_REQUIRED
- `run-phase14-pass1.ts` (phase 14, 29095 bytes) - REVIEW_REQUIRED
- `run-phase15-pass1.ts` (phase 15, 19306 bytes) - REVIEW_REQUIRED
- `run-phase16-pass1.ts` (phase 16, 23863 bytes) - REVIEW_REQUIRED
- `run-phase17-pass1.ts` (phase 17, 9350 bytes) - REVIEW_REQUIRED
- `run-phase17-pass10.ts` (phase 17, 17467 bytes) - REVIEW_REQUIRED
- `run-phase17-pass11.ts` (phase 17, 15827 bytes) - REVIEW_REQUIRED
- `run-phase17-pass12.ts` (phase 17, 16172 bytes) - REVIEW_REQUIRED
- `run-phase17-pass13.ts` (phase 17, 22199 bytes) - REVIEW_REQUIRED
- `run-phase17-pass14.ts` (phase 17, 18306 bytes) - REVIEW_REQUIRED
- `run-phase17-pass15.ts` (phase 17, 14529 bytes) - REVIEW_REQUIRED
- `run-phase17-pass16.ts` (phase 17, 27596 bytes) - REVIEW_REQUIRED
- `run-phase17-pass17.ts` (phase 17, 23578 bytes) - REVIEW_REQUIRED
- `run-phase17-pass18.ts` (phase 17, 16222 bytes) - REVIEW_REQUIRED
- `run-phase17-pass19.ts` (phase 17, 9470 bytes) - REVIEW_REQUIRED
- `run-phase17-pass2.ts` (phase 17, 11675 bytes) - REVIEW_REQUIRED
- `run-phase17-pass20.ts` (phase 17, 20694 bytes) - REVIEW_REQUIRED
- `run-phase17-pass21.ts` (phase 17, 15171 bytes) - REVIEW_REQUIRED
- `run-phase17-pass22.ts` (phase 17, 9646 bytes) - REVIEW_REQUIRED
- `run-phase17-pass23.ts` (phase 17, 15087 bytes) - REVIEW_REQUIRED
- `run-phase17-pass24.ts` (phase 17, 13613 bytes) - REVIEW_REQUIRED
- `run-phase17-pass25.ts` (phase 17, 14571 bytes) - REVIEW_REQUIRED
- `run-phase17-pass26.ts` (phase 17, 19325 bytes) - REVIEW_REQUIRED
- `run-phase17-pass27.ts` (phase 17, 17987 bytes) - REVIEW_REQUIRED
- `run-phase17-pass28.ts` (phase 17, 3087 bytes) - REVIEW_REQUIRED
- `run-phase17-pass29.ts` (phase 17, 19826 bytes) - REVIEW_REQUIRED
- `run-phase17-pass3.ts` (phase 17, 9704 bytes) - REVIEW_REQUIRED
- `run-phase17-pass30.ts` (phase 17, 9294 bytes) - REVIEW_REQUIRED
- `run-phase17-pass31.ts` (phase 17, 19258 bytes) - REVIEW_REQUIRED
- `run-phase17-pass32.ts` (phase 17, 14496 bytes) - REVIEW_REQUIRED
- `run-phase17-pass33.ts` (phase 17, 20080 bytes) - REVIEW_REQUIRED
- `run-phase17-pass34.ts` (phase 17, 12911 bytes) - REVIEW_REQUIRED
- `run-phase17-pass35.ts` (phase 17, 14503 bytes) - REVIEW_REQUIRED
- `run-phase17-pass36.ts` (phase 17, 14396 bytes) - REVIEW_REQUIRED
- `run-phase17-pass37.ts` (phase 17, 19465 bytes) - REVIEW_REQUIRED
- `run-phase17-pass38.ts` (phase 17, 18486 bytes) - REVIEW_REQUIRED
- `run-phase17-pass39.ts` (phase 17, 22556 bytes) - REVIEW_REQUIRED
- `run-phase17-pass4.ts` (phase 17, 12954 bytes) - REVIEW_REQUIRED
- `run-phase17-pass40.ts` (phase 17, 18311 bytes) - REVIEW_REQUIRED
- `run-phase17-pass41.ts` (phase 17, 17463 bytes) - REVIEW_REQUIRED
- `run-phase17-pass42.ts` (phase 17, 13750 bytes) - REVIEW_REQUIRED
- `run-phase17-pass5.ts` (phase 17, 22453 bytes) - REVIEW_REQUIRED
- `run-phase17-pass6.ts` (phase 17, 17641 bytes) - REVIEW_REQUIRED
- `run-phase17-pass7.ts` (phase 17, 20429 bytes) - REVIEW_REQUIRED
- `run-phase17-pass8.ts` (phase 17, 18543 bytes) - REVIEW_REQUIRED
- `run-phase17-pass9.ts` (phase 17, 19353 bytes) - REVIEW_REQUIRED
- `run-phase18.ts` (phase 18, 13303 bytes) - REVIEW_REQUIRED
- `run-phase19.ts` (phase 19, 7263 bytes) - REVIEW_REQUIRED
- `run-phase20.ts` (phase 20, 14015 bytes) - REVIEW_REQUIRED
- `run-phase21.ts` (phase 21, 7660 bytes) - REVIEW_REQUIRED
- `run-phase22.ts` (phase 22, 11768 bytes) - REVIEW_REQUIRED
- `run-phase23.ts` (phase 23, 9998 bytes) - REVIEW_REQUIRED
- `run-phase24.ts` (phase 24, 13617 bytes) - REVIEW_REQUIRED
- `run-phase25.ts` (phase 25, 11291 bytes) - REVIEW_REQUIRED
- `run-phase26.ts` (phase 26, 13976 bytes) - REVIEW_REQUIRED
- `run-phase27.ts` (phase 27, 11648 bytes) - REVIEW_REQUIRED
- `run-phase28.ts` (phase 28, 13052 bytes) - REVIEW_REQUIRED
- `run-phase29.ts` (phase 29, 14321 bytes) - REVIEW_REQUIRED
- `run-phase30.ts` (phase 30, 13026 bytes) - REVIEW_REQUIRED
- `run-phase31.ts` (phase 31, 14478 bytes) - REVIEW_REQUIRED
- `run-phase32.ts` (phase 32, 13733 bytes) - REVIEW_REQUIRED
- `run-phase33.ts` (phase 33, 12928 bytes) - REVIEW_REQUIRED
- `run-phase34.ts` (phase 34, 14285 bytes) - REVIEW_REQUIRED
- `run-phase35.ts` (phase 35, 22944 bytes) - REVIEW_REQUIRED
- `run-phase36.ts` (phase 36, 19467 bytes) - REVIEW_REQUIRED
- `run-phase37.ts` (phase 37, 19876 bytes) - REVIEW_REQUIRED
- `run-phase38.ts` (phase 38, 18146 bytes) - REVIEW_REQUIRED
- `run-phase39.ts` (phase 39, 22379 bytes) - REVIEW_REQUIRED
- `run-phase40.ts` (phase 40, 18357 bytes) - REVIEW_REQUIRED
- `run-phase41.ts` (phase 41, 19327 bytes) - REVIEW_REQUIRED
- `run-phase42.ts` (phase 42, 18943 bytes) - REVIEW_REQUIRED
- `run-phase43.ts` (phase 43, 23547 bytes) - REVIEW_REQUIRED
- `run-phase44.ts` (phase 44, 20489 bytes) - REVIEW_REQUIRED
- `run-phase45.ts` (phase 45, 17305 bytes) - REVIEW_REQUIRED
- `run-phase46.ts` (phase 46, 19986 bytes) - REVIEW_REQUIRED
- `run-phase47.ts` (phase 47, 16698 bytes) - REVIEW_REQUIRED
- `run-phase48.ts` (phase 48, 19368 bytes) - REVIEW_REQUIRED
- `run-phase49.ts` (phase 49, 15739 bytes) - REVIEW_REQUIRED
- `run-phase4-pass1-security.ts` (phase 4, 3175 bytes) - REVIEW_REQUIRED
- `run-phase4-pass2-real-scanners.ts` (phase 4, 6982 bytes) - REVIEW_REQUIRED
- `run-phase4-pass3-signing.ts` (phase 4, 1583 bytes) - REVIEW_REQUIRED
- `run-phase4-pass4-release-gate.ts` (phase 4, 4953 bytes) - REVIEW_REQUIRED
- `run-phase4-pass5-production-decision.ts` (phase 4, 6254 bytes) - REVIEW_REQUIRED
- `run-phase4-pass6-production-enforcement.ts` (phase 4, 9362 bytes) - REVIEW_REQUIRED
- `run-phase4-pass7-security-operations.ts` (phase 4, 13977 bytes) - REVIEW_REQUIRED
- `run-phase4-pass8-audit.ts` (phase 4, 4549 bytes) - REVIEW_REQUIRED
- `run-phase4-pass9.ts` (phase 4, 3331 bytes) - REVIEW_REQUIRED
- `run-phase50.ts` (phase 50, 14872 bytes) - REVIEW_REQUIRED
- `run-phase51.ts` (phase 51, 15921 bytes) - REVIEW_REQUIRED
- `run-phase52.ts` (phase 52, 13845 bytes) - REVIEW_REQUIRED
- `run-phase53.ts` (phase 53, 17235 bytes) - REVIEW_REQUIRED
- `run-phase54.ts` (phase 54, 22463 bytes) - REVIEW_REQUIRED
- `run-phase55.ts` (phase 55, 16059 bytes) - REVIEW_REQUIRED
- `run-phase56.ts` (phase 56, 12882 bytes) - REVIEW_REQUIRED
- `run-phase57.ts` (phase 57, 15010 bytes) - REVIEW_REQUIRED
- `run-phase58.ts` (phase 58, 17473 bytes) - REVIEW_REQUIRED
- `run-phase59.ts` (phase 59, 14235 bytes) - REVIEW_REQUIRED
- `run-phase5-observability.ts` (phase 5, 2328 bytes) - REVIEW_REQUIRED
- `run-phase5-pass1.ts` (phase 5, 5712 bytes) - REVIEW_REQUIRED
- `run-phase5-pass2.ts` (phase 5, 4736 bytes) - REVIEW_REQUIRED
- `run-phase5-pass3.ts` (phase 5, 7208 bytes) - REVIEW_REQUIRED
- `run-phase5-pass4.ts` (phase 5, 6849 bytes) - REVIEW_REQUIRED
- `run-phase5-pass5.ts` (phase 5, 4561 bytes) - REVIEW_REQUIRED
- `run-phase5-pass6.ts` (phase 5, 8606 bytes) - REVIEW_REQUIRED
- `run-phase5-pass7.ts` (phase 5, 5872 bytes) - REVIEW_REQUIRED
- `run-phase5-pass7-reader.ts` (phase 5, 496 bytes) - REVIEW_REQUIRED
- `run-phase60.ts` (phase 60, 16189 bytes) - REVIEW_REQUIRED
- `run-phase61.ts` (phase 61, 15397 bytes) - REVIEW_REQUIRED
- `run-phase62.ts` (phase 62, 14980 bytes) - REVIEW_REQUIRED
- `run-phase63.ts` (phase 63, 15157 bytes) - REVIEW_REQUIRED
- `run-phase64.ts` (phase 64, 16613 bytes) - REVIEW_REQUIRED
- `run-phase65.ts` (phase 65, 14490 bytes) - REVIEW_REQUIRED
- `run-phase66.ts` (phase 66, 13142 bytes) - REVIEW_REQUIRED
- `run-phase67.ts` (phase 67, 10851 bytes) - REVIEW_REQUIRED
- `run-phase68.ts` (phase 68, 5761 bytes) - REVIEW_REQUIRED
- `run-phase69.ts` (phase 69, 6566 bytes) - REVIEW_REQUIRED
- `run-phase6-pass1.ts` (phase 6, 3249 bytes) - REVIEW_REQUIRED
- `run-phase6-pass10.ts` (phase 6, 11983 bytes) - REVIEW_REQUIRED
- `run-phase6-pass11.ts` (phase 6, 7508 bytes) - REVIEW_REQUIRED
- `run-phase6-pass12.ts` (phase 6, 12865 bytes) - REVIEW_REQUIRED
- `run-phase6-pass13.ts` (phase 6, 14783 bytes) - REVIEW_REQUIRED
- `run-phase6-pass14.ts` (phase 6, 14789 bytes) - REVIEW_REQUIRED
- `run-phase6-pass15.ts` (phase 6, 6294 bytes) - REVIEW_REQUIRED
- `run-phase6-pass16.ts` (phase 6, 6854 bytes) - REVIEW_REQUIRED
- `run-phase6-pass2.ts` (phase 6, 7798 bytes) - REVIEW_REQUIRED
- `run-phase6-pass3.ts` (phase 6, 9043 bytes) - REVIEW_REQUIRED
- `run-phase6-pass4.ts` (phase 6, 9173 bytes) - REVIEW_REQUIRED
- `run-phase6-pass5.ts` (phase 6, 4123 bytes) - REVIEW_REQUIRED
- `run-phase6-pass6.ts` (phase 6, 10900 bytes) - REVIEW_REQUIRED
- `run-phase6-pass7.ts` (phase 6, 10563 bytes) - REVIEW_REQUIRED
- `run-phase6-pass8.ts` (phase 6, 11247 bytes) - REVIEW_REQUIRED
- `run-phase6-pass9.ts` (phase 6, 9422 bytes) - REVIEW_REQUIRED
- `run-phase7.ts` (phase 7, 8179 bytes) - REVIEW_REQUIRED
- `run-phase70.ts` (phase 70, 15954 bytes) - REVIEW_REQUIRED
- `run-phase71.ts` (phase 71, 16089 bytes) - REVIEW_REQUIRED
- `run-phase72.ts` (phase 72, 56506 bytes) - REVIEW_REQUIRED
- `run-phase73.ts` (phase 73, 32182 bytes) - REVIEW_REQUIRED
- `run-phase74.ts` (phase 74, 24116 bytes) - REVIEW_REQUIRED
- `run-phase75.ts` (phase 75, 11883 bytes) - REVIEW_REQUIRED
- `run-phase76.ts` (phase 76, 14438 bytes) - REVIEW_REQUIRED
- `run-phase77.ts` (phase 77, 15104 bytes) - REVIEW_REQUIRED
- `run-phase78.ts` (phase 78, 19421 bytes) - REVIEW_REQUIRED
- `run-phase79.ts` (phase 79, 20259 bytes) - REVIEW_REQUIRED
- `run-phase7-certification.ts` (phase 7, 3823 bytes) - REVIEW_REQUIRED
- `run-phase7-pass2.ts` (phase 7, 5295 bytes) - REVIEW_REQUIRED
- `run-phase7-pass3.ts` (phase 7, 9821 bytes) - REVIEW_REQUIRED
- `run-phase7-pass4.ts` (phase 7, 9091 bytes) - REVIEW_REQUIRED
- `run-phase7-pass5.ts` (phase 7, 10561 bytes) - REVIEW_REQUIRED
- `run-phase80.ts` (phase 80, 15525 bytes) - REVIEW_REQUIRED
- `run-phase81.ts` (phase 81, 13572 bytes) - REVIEW_REQUIRED
- `run-phase82.ts` (phase 82, 39610 bytes) - REVIEW_REQUIRED
- `run-phase83.ts` (phase 83, 22477 bytes) - REVIEW_REQUIRED
- `run-phase84.ts` (phase 84, 11077 bytes) - REVIEW_REQUIRED
- `run-phase85.ts` (phase 85, 27507 bytes) - REVIEW_REQUIRED
- `run-phase86.ts` (phase 86, 40017 bytes) - REVIEW_REQUIRED
- `run-phase87.ts` (phase 87, 24114 bytes) - REVIEW_REQUIRED
- `run-phase88.ts` (phase 88, 42322 bytes) - REVIEW_REQUIRED
- `run-phase89.ts` (phase 89, 25093 bytes) - REVIEW_REQUIRED
- `run-phase8-certification.ts` (phase 8, 3599 bytes) - REVIEW_REQUIRED
- `run-phase8-pass1.ts` (phase 8, 6882 bytes) - REVIEW_REQUIRED
- `run-phase8-pass2.ts` (phase 8, 12102 bytes) - REVIEW_REQUIRED
- `run-phase90.ts` (phase 90, 36360 bytes) - REVIEW_REQUIRED
- `run-phase91.ts` (phase 91, 48283 bytes) - REVIEW_REQUIRED
- `run-phase92.ts` (phase 92, 24172 bytes) - REVIEW_REQUIRED
- `run-phase93.ts` (phase 93, 34063 bytes) - REVIEW_REQUIRED
- `run-phase94.ts` (phase 94, 65852 bytes) - REVIEW_REQUIRED
- `run-phase95.ts` (phase 95, 10145 bytes) - REVIEW_REQUIRED
- `run-phase96.ts` (phase 96, 14747 bytes) - REVIEW_REQUIRED
- `run-phase97.ts` (phase 97, 21332 bytes) - REVIEW_REQUIRED
- `run-phase98.ts` (phase 98, 18666 bytes) - REVIEW_REQUIRED
- `run-phase99.ts` (phase 99, 16669 bytes) - REVIEW_REQUIRED
- `run-phase9-pass1.ts` (phase 9, 5566 bytes) - REVIEW_REQUIRED
- `run-phase9-pass2.ts` (phase 9, 5815 bytes) - REVIEW_REQUIRED
- `run-phase9-pass3.ts` (phase 9, 13207 bytes) - REVIEW_REQUIRED
- `run-phase9-pass4.ts` (phase 9, 12042 bytes) - REVIEW_REQUIRED
- `run-phase9-pass5.ts` (phase 9, 17530 bytes) - REVIEW_REQUIRED
- `run-phase9-pass6.ts` (phase 9, 18885 bytes) - REVIEW_REQUIRED
- `run-production-persistence-repair.ts` (phase , 7585 bytes) - REVIEW_REQUIRED
- `run-production-release-gate.ts` (phase , 7774 bytes) - REVIEW_REQUIRED
- `run-real-scan-fixture.ts` (phase , 1476 bytes) - REVIEW_REQUIRED
- `run-release-integrity-audit.ts` (phase , 9790 bytes) - REVIEW_REQUIRED
- `run-release-integrity-enforcement.ts` (phase , 6960 bytes) - REVIEW_REQUIRED
- `run-rollback-e2e.ts` (phase , 2919 bytes) - REVIEW_REQUIRED
- `run-safe-regression.ts` (phase , 5280 bytes) - REVIEW_REQUIRED
- `run-security-scan.ts` (phase , 3769 bytes) - REVIEW_REQUIRED
- `run-security-tests.ts` (phase , 518 bytes) - REVIEW_REQUIRED
- `run-server.ts` (phase , 4691 bytes) - REVIEW_REQUIRED
- `run-vite-ssr.mjs` (phase , 969 bytes) - REVIEW_REQUIRED
- `run-worker-gateway-agent-e2e.ts` (phase , 12601 bytes) - REVIEW_REQUIRED
- `run-worker-gateway-integration.ts` (phase , 8423 bytes) - REVIEW_REQUIRED
- `run-worker-gateway-remote-adapter-e2e.ts` (phase , 11729 bytes) - REVIEW_REQUIRED

## UNKNOWN - explicit review list
- `_phase182_child.ts` (.ts, 4779 bytes) - REVIEW_REQUIRED
- `_phase183a_child.ts` (.ts, 1984 bytes) - REVIEW_REQUIRED
- `_phase183b_intents_child.ts` (.ts, 3157 bytes) - REVIEW_REQUIRED
- `_phase183b_jobs_child.ts` (.ts, 4568 bytes) - REVIEW_REQUIRED
- `_phase183c_attempts_child.ts` (.ts, 2943 bytes) - REVIEW_REQUIRED
- `_phase183d_child.ts` (.ts, 1799 bytes) - REVIEW_REQUIRED
- `_phase263f_child.ts` (.ts, 1048 bytes) - REVIEW_REQUIRED
- `boot-once.ts` (.ts, 391 bytes) - REVIEW_REQUIRED
- `diag-137-10.ts` (.ts, 5271 bytes) - REVIEW_REQUIRED
- `diag-clean-migrations.ts` (.ts, 641 bytes) - REVIEW_REQUIRED
- `diag-migration-180.ts` (.ts, 2395 bytes) - REVIEW_REQUIRED
- `diag-schema.ts` (.ts, 520 bytes) - REVIEW_REQUIRED
- `diag-smoke.ts` (.ts, 308 bytes) - REVIEW_REQUIRED
- `host-bridge-node.ts` (.ts, 3842 bytes) - REVIEW_REQUIRED
- `nexus-host-bridge.mjs.phase298-backup` (.phase298-backup, 33781 bytes) - REVIEW_REQUIRED
- `nexus-host-bridge.mjs.phase298-hardening-backup` (.phase298-hardening-backup, 34253 bytes) - REVIEW_REQUIRED
- `nexus-host-bridge.mjs.phase298-preflight-backup` (.phase298-preflight-backup, 33781 bytes) - REVIEW_REQUIRED
- `nexus-host-bridge-redaction.d.mts` (.mts, 54 bytes) - REVIEW_REQUIRED
- `phase202-evidence.ts` (.ts, 3027 bytes) - REVIEW_REQUIRED
- `phase203-evidence.ts` (.ts, 3400 bytes) - REVIEW_REQUIRED
- `phase205-evidence.ts` (.ts, 2986 bytes) - REVIEW_REQUIRED
- `phase206-evidence.ts` (.ts, 3052 bytes) - REVIEW_REQUIRED
- `phase207-evidence.ts` (.ts, 5322 bytes) - REVIEW_REQUIRED
- `phase208-evidence.ts` (.ts, 4850 bytes) - REVIEW_REQUIRED
- `phase209-evidence.ts` (.ts, 3343 bytes) - REVIEW_REQUIRED
- `phase210-evidence.ts` (.ts, 3262 bytes) - REVIEW_REQUIRED
- `phase211-evidence.ts` (.ts, 3016 bytes) - REVIEW_REQUIRED
- `phase212-evidence.ts` (.ts, 3016 bytes) - REVIEW_REQUIRED
- `phase214-evidence.ts` (.ts, 3016 bytes) - REVIEW_REQUIRED
- `phase215-evidence.ts` (.ts, 3016 bytes) - REVIEW_REQUIRED
- `phase216-evidence.ts` (.ts, 3996 bytes) - REVIEW_REQUIRED
- `phase218-evidence.ts` (.ts, 3013 bytes) - REVIEW_REQUIRED
- `phase219-evidence.ts` (.ts, 3013 bytes) - REVIEW_REQUIRED
- `phase221-evidence.ts` (.ts, 3013 bytes) - REVIEW_REQUIRED
- `phase222-evidence.ts` (.ts, 3013 bytes) - REVIEW_REQUIRED
- `phase223-evidence.ts` (.ts, 3013 bytes) - REVIEW_REQUIRED
- `phase224-evidence.ts` (.ts, 3013 bytes) - REVIEW_REQUIRED
- `record-approval.ts` (.ts, 624 bytes) - REVIEW_REQUIRED
- `workspace (7).tar` (.tar, 1036451 bytes) - REVIEW_REQUIRED
- `wp2-claim-worker.ts` (.ts, 1017 bytes) - REVIEW_REQUIRED
- `wp3-cancel-worker.ts` (.ts, 2352 bytes) - REVIEW_REQUIRED
- `wp3-result-worker.ts` (.ts, 2906 bytes) - REVIEW_REQUIRED

## Full inventory (self-references excluded)
| Path | Class | npm | Spawned-by | Risks | Cleanup |
|---|---|---|---|---|---|
| `scripts/_phase182_child.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/_phase183_final_child.ts` | CHILD_HELPER | False | test-phase183-final.ts |  | REVIEW_REQUIRED |
| `scripts/_phase183a_child.ts` | UNKNOWN | False | test-phase183a-shared-idempotency.ts |  | REVIEW_REQUIRED |
| `scripts/_phase183b_intents_child.ts` | UNKNOWN | False | test-phase183b-release-intents.ts |  | REVIEW_REQUIRED |
| `scripts/_phase183b_jobs_child.ts` | UNKNOWN | False | test-phase183b-jobs-recovery.ts |  | REVIEW_REQUIRED |
| `scripts/_phase183c_attempts_child.ts` | UNKNOWN | False | test-phase183c-attempts-workers.ts |  | REVIEW_REQUIRED |
| `scripts/_phase183d_child.ts` | UNKNOWN | False | test-phase183d-runtime-consumers.ts |  | REVIEW_REQUIRED |
| `scripts/_phase184_distributed_child.ts` | CHILD_HELPER | False | test-phase184-distributed-coordination.ts |  | REVIEW_REQUIRED |
| `scripts/_phase185_scheduler_child.ts` | CHILD_HELPER | False | test-phase185-distributed-scheduler.ts, test-phase186-distributed-dispatch.ts, test-phase187-attempt-lifecycle.ts, test-phase188-attempt-completion.ts, test-phase189-result-integrity.ts, test-phase190-release-integrity.ts, test-phase207-production-scheduler.ts |  | REVIEW_REQUIRED |
| `scripts/_phase194_lease_race_child.ts` | CHILD_HELPER | False | test-phase194-concurrent-lease.ts |  | REVIEW_REQUIRED |
| `scripts/_phase198_pg_child.ts` | CHILD_HELPER | False | test-phase198-ownership.ts |  | REVIEW_REQUIRED |
| `scripts/_phase199_reclaim_child.ts` | CHILD_HELPER | False | test-phase199-recovery-operation-reclaim.ts, test-phase200-recovery-finalization.ts |  | REVIEW_REQUIRED |
| `scripts/_phase243_recovery_child.ts` | CHILD_HELPER | False | test-phase243-durable-recovery-orchestration.ts |  | REVIEW_REQUIRED |
| `scripts/_phase244_lifecycle_child.ts` | CHILD_HELPER | False | test-phase244-crash-safe-execution-lifecycle.ts |  | REVIEW_REQUIRED |
| `scripts/_phase245_supervision_child.ts` | CHILD_HELPER | False | test-phase245-production-supervision-boundary.ts |  | REVIEW_REQUIRED |
| `scripts/_phase252_auth_cas_child.ts` | CHILD_HELPER | False | test-phase252-authorization-cas.ts |  | REVIEW_REQUIRED |
| `scripts/_phase263f_child.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/_phase267_crash_child.ts` | CHILD_HELPER | False | test-phase267-crash-restart-recovery.ts |  | REVIEW_REQUIRED |
| `scripts/_phase270_pg_child.ts` | CHILD_HELPER | False | test-phase270-crash-restart-recovery.ts |  | REVIEW_REQUIRED |
| `scripts/apply-phase277.ps1` | DEBUG_SCRATCH | False |  |  | REVIEW_REQUIRED |
| `scripts/boot-once.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/debug-phase4-pass4.ts` | DEBUG_SCRATCH | False |  |  | REVIEW_REQUIRED |
| `scripts/dev-env.ps1` | ACTIVE_UTILITY | False |  |  | REVIEW_REQUIRED |
| `scripts/diag-137-10.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/diag-137-10-output.txt` | EVIDENCE | False |  |  | REVIEW_REQUIRED |
| `scripts/diag-clean-migrations.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/diag-migration-180.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/diagnose-security-detection.ts` | DEBUG_SCRATCH | False |  |  | REVIEW_REQUIRED |
| `scripts/diagnose-security-scans.ts` | DEBUG_SCRATCH | False |  |  | REVIEW_REQUIRED |
| `scripts/diag-schema.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/diag-smoke.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/host-bridge-node.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/nexus-host-bridge.mjs` | ACTIVE_TEST | False | run-host-workspace-materialization-tests.mjs, test-phase278-redaction-callsite-audit.ts |  | REVIEW_REQUIRED |
| `scripts/nexus-host-bridge.mjs.before-explicit-cmd-block-20261107-102809.bak` | BACKUP | False |  |  | REVIEW_REQUIRED |
| `scripts/nexus-host-bridge.mjs.phase298-backup` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/nexus-host-bridge.mjs.phase298-hardening-backup` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/nexus-host-bridge.mjs.phase298-preflight-backup` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/nexus-host-bridge-redaction.d.mts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/nexus-host-bridge-redaction.mjs` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/phase171-evidence.json` | EVIDENCE | False |  |  | REVIEW_REQUIRED |
| `scripts/phase172-evidence.json` | EVIDENCE | False |  |  | REVIEW_REQUIRED |
| `scripts/phase173-evidence.json` | EVIDENCE | False |  |  | REVIEW_REQUIRED |
| `scripts/phase174-evidence.json` | EVIDENCE | False |  |  | REVIEW_REQUIRED |
| `scripts/phase175-evidence.json` | EVIDENCE | False |  |  | REVIEW_REQUIRED |
| `scripts/phase202-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase203-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase205-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase206-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase207-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase208-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase209-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase210-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase211-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase212-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase214-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase215-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase216-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase218-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase219-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase221-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase222-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase223-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase224-evidence.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/phase266-verify.ps1` | ACTIVE_UTILITY | False |  |  | REVIEW_REQUIRED |
| `scripts/phase267-verify.ps1` | ACTIVE_UTILITY | False |  |  | REVIEW_REQUIRED |
| `scripts/phase268-verify.ps1` | ACTIVE_UTILITY | False |  |  | REVIEW_REQUIRED |
| `scripts/phase284-test-output-diagnostic.txt` | EVIDENCE | False |  |  | REVIEW_REQUIRED |
| `scripts/pin-actions.mjs` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/record-approval.ts` | UNKNOWN | False |  | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-advanced-security-pipeline.ts` | PHASE_RUNNER | False | run-operations-regression.ts | STATE_FILE_MUTATION,SIGNING | REVIEW_REQUIRED |
| `scripts/run-browser-smoke.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-build-test-execution-tests.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-canonical-deployment-e2e.ts` | PHASE_RUNNER | False | host-bridge-node.ts, test-phase250-production-incident-recovery.ts |  | REVIEW_REQUIRED |
| `scripts/run-canonical-deployment-tests.ts` | PHASE_RUNNER | False |  | DOCKER | REVIEW_REQUIRED |
| `scripts/run-core-tests.ts` | PHASE_RUNNER | True |  |  | REVIEW_REQUIRED |
| `scripts/run-dast.ts` | PHASE_RUNNER | False | run-advanced-security-pipeline.ts, run-production-release-gate.ts, run-release-integrity-audit.ts |  | REVIEW_REQUIRED |
| `scripts/run-docker-engineering-e2e.ts` | PHASE_RUNNER | False | host-bridge-node.ts | DOCKER | REVIEW_REQUIRED |
| `scripts/run-dockerfile-validation-tests.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-durable-gateway-tests.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-execution-runtime-integration.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-host-workspace-materialization-tests.mjs` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-host-workspace-materialization-tests.mjs.before-cmd-block-test-20261107-102826.bak` | BACKUP | False |  |  | REVIEW_REQUIRED |
| `scripts/run-host-workspace-tests.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-kernel-gateway-integration.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-observability.ts` | PHASE_RUNNER | False |  | PROTECTED_FILE_REF | REVIEW_REQUIRED |
| `scripts/run-operations-regression.ts` | PROTECTED_RISK | True | run-phase7-certification.ts, run-phase8-certification.ts | AGGREGATE | REVIEW_REQUIRED |
| `scripts/run-phase100.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase105-pass1.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase105-pass2.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase106-pass1.ts` | PHASE_RUNNER | False |  | DOCKER | REVIEW_REQUIRED |
| `scripts/run-phase10-pass1.ts` | PHASE_RUNNER | False | run-phase10-pass5.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase10-pass2.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase10-pass3.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase10-pass4.ts` | PHASE_RUNNER | False | run-phase10-pass5.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase10-pass5.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase11-pass1.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase12-pass1.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase13-pass1.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase14-pass1.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase15-pass1.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase16-pass1.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass1.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass10.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass11.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass12.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass13.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass14.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass15.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass16.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass17.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass18.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass19.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass2.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass20.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass21.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass22.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass23.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass24.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass25.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass26.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass27.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass28.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass29.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass3.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass30.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass31.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass32.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass33.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass34.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass35.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass36.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass37.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass38.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass39.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass4.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass40.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass41.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass42.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass5.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass6.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass7.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass8.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase17-pass9.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase18.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase19.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase20.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase21.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase22.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase23.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase24.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase25.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase26.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase27.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase28.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase29.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase30.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase31.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase32.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase33.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase34.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase35.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase36.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase37.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase38.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase39.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase40.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase41.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase42.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase43.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase44.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase45.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase46.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase47.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase48.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase49.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase4-pass1-security.ts` | PHASE_RUNNER | False | run-security-regression.ts | SIGNING | REVIEW_REQUIRED |
| `scripts/run-phase4-pass2-real-scanners.ts` | PHASE_RUNNER | False | run-security-regression.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase4-pass3-signing.ts` | PHASE_RUNNER | False | run-security-regression.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase4-pass4-release-gate.ts` | PHASE_RUNNER | False | run-security-regression.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase4-pass5-production-decision.ts` | PHASE_RUNNER | False | run-security-regression.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase4-pass6-production-enforcement.ts` | PHASE_RUNNER | False | run-security-regression.ts | SIGNING | REVIEW_REQUIRED |
| `scripts/run-phase4-pass7-security-operations.ts` | PHASE_RUNNER | False | run-phase4-pass8-audit.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase4-pass8-audit.ts` | PHASE_RUNNER | False |  | SIGNING | REVIEW_REQUIRED |
| `scripts/run-phase4-pass9.ts` | PHASE_RUNNER | False | run-security-regression.ts | SIGNING | REVIEW_REQUIRED |
| `scripts/run-phase50.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase51.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase52.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase53.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase54.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase55.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase56.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase57.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase58.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase59.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase5-observability.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase5-pass1.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase5-pass2.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase5-pass3.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase5-pass4.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase5-pass5.ts` | PHASE_RUNNER | False | run-operations-regression.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase5-pass6.ts` | PHASE_RUNNER | False | run-operations-regression.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase5-pass7.ts` | PHASE_RUNNER | False | run-operations-regression.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase5-pass7-reader.ts` | PHASE_RUNNER | False | run-phase5-pass7.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase60.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase61.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase62.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase63.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase64.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase65.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase66.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase67.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase68.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase69.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase6-pass1.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase6-pass10.ts` | PHASE_RUNNER | False |  | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-phase6-pass11.ts` | PHASE_RUNNER | False |  | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-phase6-pass12.ts` | PHASE_RUNNER | False |  | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-phase6-pass13.ts` | PHASE_RUNNER | False |  | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-phase6-pass14.ts` | PHASE_RUNNER | False |  | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-phase6-pass15.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase6-pass16.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase6-pass2.ts` | PHASE_RUNNER | False |  | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-phase6-pass3.ts` | PHASE_RUNNER | False |  | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-phase6-pass4.ts` | PHASE_RUNNER | False |  | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-phase6-pass5.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase6-pass6.ts` | PHASE_RUNNER | False |  | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-phase6-pass7.ts` | PHASE_RUNNER | False |  | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-phase6-pass8.ts` | PHASE_RUNNER | False |  | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-phase6-pass9.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase7.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase70.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase71.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase72.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase73.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase74.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase75.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase76.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase77.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase78.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase79.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase7-certification.ts` | PHASE_RUNNER | False |  | AGGREGATE | REVIEW_REQUIRED |
| `scripts/run-phase7-pass2.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase7-pass3.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase7-pass4.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase7-pass5.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase80.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase81.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase82.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase83.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase84.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase85.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase86.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase87.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase88.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase89.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase8-certification.ts` | PHASE_RUNNER | False |  | AGGREGATE | REVIEW_REQUIRED |
| `scripts/run-phase8-pass1.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase8-pass2.ts` | PHASE_RUNNER | False |  | SIGNING | REVIEW_REQUIRED |
| `scripts/run-phase90.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase91.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase92.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase93.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase94.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase95.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase96.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase97.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase98.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase99.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase9-pass1.ts` | PHASE_RUNNER | False | run-phase10-pass5.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase9-pass2.ts` | PHASE_RUNNER | False | run-phase10-pass5.ts |  | REVIEW_REQUIRED |
| `scripts/run-phase9-pass3.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase9-pass4.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase9-pass5.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-phase9-pass6.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-production-persistence-repair.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-production-release-gate.ts` | PHASE_RUNNER | False |  | STATE_FILE_MUTATION,SIGNING | REVIEW_REQUIRED |
| `scripts/run-real-scan-fixture.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-release-integrity-audit.ts` | PHASE_RUNNER | False | run-security-regression.ts | STATE_FILE_MUTATION,PROTECTED_FILE_REF,SIGNING | REVIEW_REQUIRED |
| `scripts/run-release-integrity-enforcement.ts` | PHASE_RUNNER | False | run-security-regression.ts | STATE_FILE_MUTATION,SIGNING | REVIEW_REQUIRED |
| `scripts/run-rollback-e2e.ts` | PHASE_RUNNER | False | run-operations-regression.ts | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/run-safe-regression.ts` | PHASE_RUNNER | True | test-phase304-safe-runner.ts |  | REVIEW_REQUIRED |
| `scripts/run-safe-regression.ts.before-v3-20261115085329` | BACKUP | False |  |  | REVIEW_REQUIRED |
| `scripts/run-security-regression.ts` | PROTECTED_RISK | True | run-phase7-certification.ts, run-phase8-certification.ts | AGGREGATE | REVIEW_REQUIRED |
| `scripts/run-security-scan.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-security-tests.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-server.ts` | PHASE_RUNNER | True | test-phase180-http-production-hardening.ts |  | REVIEW_REQUIRED |
| `scripts/run-vite-ssr.mjs` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-worker-gateway-agent-e2e.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-worker-gateway-integration.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/run-worker-gateway-remote-adapter-e2e.ts` | PHASE_RUNNER | False |  |  | REVIEW_REQUIRED |
| `scripts/test-approval-artifact-binding.ts` | PROTECTED_RISK | False | run-security-regression.ts | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/test-approval-protection.ts` | PROTECTED_RISK | False | run-security-regression.ts | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/test-artifact-signing.ts` | PROTECTED_RISK | False |  | SIGNING | REVIEW_REQUIRED |
| `scripts/test-backup-restore.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-fail-safe.ts` | PROTECTED_RISK | False | run-security-regression.ts | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/test-failure-detection.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-graceful-shutdown.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-pg-bootstrap-focused.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase117-rollback.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase118-rollback-recovery.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase119-rollback-recovery.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase120-production-rollback-verification.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase121-rollback-verification-evidence.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase122-recovery-evidence-reconciliation.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase123-production-recovery-evidence-integration.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase124-durable-recovery-required.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase125-recovery-supervisor.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase126-execution-lifecycle.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase127-execution-state-machine.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase128-execution-completion.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase129-execution-integration.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase130-release-deployment.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase131-end-to-end-integration.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase132-ci-reconciliation.ts` | PROTECTED_RISK | True |  | DOCKER,NETWORK_GITHUB | REVIEW_REQUIRED |
| `scripts/test-phase133-scheduler.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase134-durable-ci-ownership.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase135-ci-reconciliation-integrity.ts` | PROTECTED_RISK | True |  | NETWORK_GITHUB | REVIEW_REQUIRED |
| `scripts/test-phase135-ci-reconciliation-integrity.ts.phase135-backup` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase136-execution-recovery.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase137-cancellation-timeout.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase138-attempt-authority.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase138-cancellation.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase138-recovery.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase140-attempt-binding.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase141-deployment-evidence.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase142-atomic-claim.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase143-transactional-execution-recovery.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase144-durable-recovery-operations.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase145-reconciliation-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase146-retry-budget-recovery.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase147-durable-retry-scheduling.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase147-retry-scheduling-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase148-atomic-attempt-allocation.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase149-attempt-lifecycle-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase150-job-attempt-terminal-consistency.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase151-recovery-finalization.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase152-recovery-concurrency.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase153-recovery-lease-fencing.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase154-recovery-cancellation-shutdown.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase155-strict-recovery-cancellation-fencing.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase156-recovery-lifecycle-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase157-recovery-operation-idempotency.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase158-recovery-worker-heartbeat-lease.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase159-recovery-admission-control.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase160-recovery-scheduling-fairness.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase161-recovery-scheduler-capacity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase162-worker-execution-authority.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase163-execution-recovery-handoff.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase164-execution-outcome-authority.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase165-execution-evidence-provenance.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase166-audit-provenance-integrity.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase167-audit-provenance-control-plane.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase168-project-authorization.ts` | ACTIVE_TEST | False | test-phase217-implementation.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase169-project-membership-administration.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase170-project-resource-authorization.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase171-project-scoped-cicd-release-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase172-production-release-execution-safety.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase173-release-recovery-crash-safety.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase174-recovery-concurrency-and-rollback-safety.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase175-recovery-supervisor-admission.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase176-authoritative-reconciliation.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase177-durable-recovery-control-loop.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase178-recovery-operations-control.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase179-recovery-control-api.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase180-http-production-hardening.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase181-persistence-durability.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase182-multi-instance-coordination.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase183a-shared-idempotency.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase183b-jobs-recovery.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase183b-release-intents.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase183c-attempts-workers.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase183d-runtime-consumers.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase183-final.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase184-distributed-coordination.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase185-distributed-scheduler.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase186-distributed-dispatch.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase187-attempt-lifecycle.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase187-attempt-recovery.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase188-attempt-completion.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase189-result-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase190-release-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase191-deployment-execution.ts` | ACTIVE_TEST | False | host-bridge-node.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase192-restart-safety.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase192-scheduler-lifecycle.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase193-boot-failure.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase193-concurrent-boot.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase194-concurrent-lease.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase194-execution-continuity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase195-migration-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase196-execution-supervision.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase197-stall-recovery.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase198-ownership.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase199-recovery-operation-reclaim.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase200-recovery-finalization.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase201-orchestrator-deps.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase201-stage-dag.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase202b-retry-eligibility.ts` | ACTIVE_TEST | False | phase202-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase202c-concurrency.ts` | ACTIVE_TEST | False | phase202-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase202d-shared-admission.ts` | ACTIVE_TEST | False | phase202-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase202-durable-admission.ts` | ACTIVE_TEST | False | phase202-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase202e-admission-stress.ts` | ACTIVE_TEST | False | phase202-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase203a-stage-dispatch.ts` | ACTIVE_TEST | False | phase203-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase203b-worker-failure.ts` | ACTIVE_TEST | False | phase203-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase203c-dag-convergence.ts` | ACTIVE_TEST | False | phase203-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase203d-restart-durability.ts` | ACTIVE_TEST | False | phase203-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase203e-concurrency-stress.ts` | ACTIVE_TEST | False | phase203-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase204-execution-lifecycle.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase205-execution-reconciliation.ts` | ACTIVE_TEST | False | phase205-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase206-worker-fencing.ts` | ACTIVE_TEST | False | phase206-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase207-production-scheduler.ts` | ACTIVE_TEST | False | phase207-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase208-worker-execution-runtime.ts` | ACTIVE_TEST | False | phase208-evidence.ts, test-phase210-release-safety.ts, test-phase211-release-execution.ts, test-phase212-release-recovery.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase209-verification-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase210-release-safety.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase211-release-execution.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase212-release-recovery.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase213-lifecycle-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase214-engineering-run.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase215-planning-architecture.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase216-ai-provider.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase217-external-provider.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase217-implementation.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase218-stage-execution.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase219-build-stage-execution.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase220-test-stage-execution.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase221-diagnosis-stage-execution.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase222-repair-stage-execution.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase223-security-review-stage-execution.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase224-release-ready-stage-execution.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase225-release-deployment.ts` | PROTECTED_RISK | True |  | DOCKER | REVIEW_REQUIRED |
| `scripts/test-phase226-deployment-lifecycle.ts` | PROTECTED_RISK | True |  | DOCKER | REVIEW_REQUIRED |
| `scripts/test-phase227-production-activation.ts` | PROTECTED_RISK | True |  | DOCKER | REVIEW_REQUIRED |
| `scripts/test-phase228-production-activation-reconciliation.ts` | PROTECTED_RISK | True |  | DOCKER | REVIEW_REQUIRED |
| `scripts/test-phase229-aws-production-traffic-integration.ts` | PROTECTED_RISK | True |  | DOCKER | REVIEW_REQUIRED |
| `scripts/test-phase230-alb-traffic-cutover.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase231-production-e2e-lifecycle.ts` | PROTECTED_RISK | True |  | DOCKER | REVIEW_REQUIRED |
| `scripts/test-phase232-provider-uncertainty-reconciliation.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase233-post-cutover-verification.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase234-active-health-monitoring.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase235-active-health-recovery.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase236-active-health-lifecycle.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase237-fair-active-health.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase238-durable-active-health.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase239-supervisor-leases.ts` | ACTIVE_TEST | True | test-phase240-supervisor-lease-hardening.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase240-supervisor-lease-hardening.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase241-execution-recovery-claims.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase242-durable-retry.ts` | ACTIVE_TEST | True | test-phase243-durable-recovery-orchestration.ts, test-phase244-crash-safe-execution-lifecycle.ts, test-phase245-production-supervision-boundary.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase243-durable-recovery-orchestration.ts` | ACTIVE_TEST | True | test-phase244-crash-safe-execution-lifecycle.ts, test-phase245-production-supervision-boundary.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase244-crash-safe-execution-lifecycle.ts` | ACTIVE_TEST | True | test-phase245-production-supervision-boundary.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase245-production-supervision-boundary.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase246-canonical-security-decision.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase246-release-review-enforcement.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase247-boundaries.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase247-security-assurance.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase248-deployment-security-continuity.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase249-post-deployment-integrity.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase250-production-incident-recovery.ts` | ACTIVE_TEST | True | test-phase255-resolved-deployment-lifecycle.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase251-incident-lifecycle-durability.ts` | ACTIVE_TEST | True | test-phase255-resolved-deployment-lifecycle.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase252-authorization-cas.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase252-drift-observation-loop.ts` | ACTIVE_TEST | True | test-phase255-resolved-deployment-lifecycle.ts, test-phase257-recovery-handoff-convergence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase253-recovery-handoff-integrity.ts` | ACTIVE_TEST | True | test-phase255-resolved-deployment-lifecycle.ts, test-phase257-recovery-handoff-convergence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase254-recovery-completion-integrity.ts` | ACTIVE_TEST | True | test-phase255-resolved-deployment-lifecycle.ts, test-phase257-recovery-handoff-convergence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase255-resolved-deployment-lifecycle.ts` | ACTIVE_TEST | True | test-phase257-recovery-handoff-convergence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase256-deployment-convergence.ts` | ACTIVE_TEST | True | test-phase257-recovery-handoff-convergence.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase257-recovery-handoff-convergence.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase258-stage-executor-error-hardening.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase259-stage-executor-persistence-honesty.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase260-stage-reconciliation.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase261-outbox-drainer.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase262l-outbox-drain-lifecycle.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase262-outbox-claim-concurrency.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase263a-pg-client-cleanup.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase263d-drift-lifecycle.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase263e-kernel-shutdown-drain.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase263f-event-sequence-atomicity.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase264-retry-eligibility.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase265-recovery-reconciliation-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase266-recovery-reconciliation-concurrency.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase267-crash-restart-recovery.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase267-shutdown-reconciliation.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase268-audit-boundary.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase268-recovery-races.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase268-remote-result-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase268-shutdown-parity.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase269-failure-injection.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase269-recovery-observability.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase270-crash-restart-recovery.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase270-postgres-shutdown-reconciliation.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase270-server-restart.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase271-event-redaction.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase272-evidence-redaction.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase273-end-to-end-redaction.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase274-executor-sanitize.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase275-bearer-hardening.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase276-redaction-bypass-audit.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase277-redaction-coverage.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase278-redaction-callsite-audit.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase279-redaction-boundary-integration.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase280-redaction-serialization.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase281-audit-metadata-normalization.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase282-audit-metadata-security.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase283-redaction-getter-safety.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase284-redaction-policy-contracts.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase285-audit-and-gateway-error-redaction.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase285-runtime-redaction-callsite-audit.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase286-worker-gateway-real-handler.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase286-worker-gateway-validation.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase288-worker-gateway-adversarial.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase290b-worker-gateway-failure-modes.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase290-worker-gateway-concurrency.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase291-migration-upgrade.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase291-worker-gateway-recovery-acceptance.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase291-worker-gateway-recovery-safety.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase292b-aws-cli.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase292b-aws-provider.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase292b-gateway-quarantine.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase292b-inspection.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase292b-key-provider.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase292b-replay.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase292-envelope-persistence.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase293c-persistent-sanitization.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase293-failure-modes.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase293-log-sanitization.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase293-provider-gate.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase293-rotation.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase294-security-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase295-security-mapping-integrity.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-sqlite-race.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-wp1-dispatch-persistence.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-wp2-atomic-claiming.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-wp3-cross-process.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-wp4-gateway-routing.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-wp5-reconciliation.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-wp5-reconciliation.ts.phase300-wp5-before-corrections.bak` | BACKUP | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-wp5-reconciliation.ts.phase300-wp5-before-race-test.bak` | BACKUP | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-wp5-reconciliation.ts.phase300-wp5-before-retry-test.bak` | BACKUP | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-wp5-reconciliation.ts.phase300-wp5-before-terminal-expansion.bak` | BACKUP | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-wp5-sqlite-fallback.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-wp6-cancellation-status.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase300-wp8-fresh-bootstrap.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-phase301-bridge-lifecycle.ts` | ACTIVE_TEST | True | test-phase303-kernel-boot-failure.ts |  | REVIEW_REQUIRED |
| `scripts/test-phase301-startrun-honesty.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase302-dispatch-run-details.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase303-kernel-boot-failure.ts` | ACTIVE_TEST | True |  |  | REVIEW_REQUIRED |
| `scripts/test-phase304-safe-runner.ts` | PROTECTED_RISK | True |  | AGGREGATE | REVIEW_REQUIRED |
| `scripts/test-release-flow.ts` | PROTECTED_RISK | False | run-security-regression.ts | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/test-rollback-safety.ts` | PROTECTED_RISK | False | run-security-regression.ts | STATE_FILE_MUTATION | REVIEW_REQUIRED |
| `scripts/test-security-scan-policy-adapter.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/test-tamper-detection.ts` | PROTECTED_RISK | False | run-security-regression.ts | SIGNING | REVIEW_REQUIRED |
| `scripts/test-worker-handler-schema-gate.ts` | DORMANT_TEST | False |  |  | REVIEW_REQUIRED |
| `scripts/verify-pass5.backup.mjs` | DORMANT_TEST | False |  | DOCKER | REVIEW_REQUIRED |
| `scripts/verify-pass5.mjs` | DORMANT_TEST | False |  | DOCKER | REVIEW_REQUIRED |
| `scripts/verify-pass5-corrected.txt` | EVIDENCE | False |  |  | REVIEW_REQUIRED |
| `scripts/verify-pass5-fixed-windows.mjs` | ACTIVE_TEST | False | run-operations-regression.ts | DOCKER | REVIEW_REQUIRED |
| `scripts/verify-pass5-fixed-windows.mjs.before-port-fix` | BACKUP | False |  |  | REVIEW_REQUIRED |
| `scripts/verify-pass5-fixed-windows.mjs.before-stage-logging-20261024-091230` | BACKUP | False |  |  | REVIEW_REQUIRED |
| `scripts/verify-phase.ts` | DEBUG_SCRATCH | False | phase209-evidence.ts, phase210-evidence.ts, phase211-evidence.ts, phase212-evidence.ts, phase214-evidence.ts, phase215-evidence.ts, phase216-evidence.ts, phase218-evidence.ts, phase219-evidence.ts, phase221-evidence.ts, phase222-evidence.ts, phase223-evidence.ts, phase224-evidence.ts |  | REVIEW_REQUIRED |
| `scripts/verify-phase1.mjs` | DEBUG_SCRATCH | False | verify-pass5.backup.mjs, verify-pass5.mjs, verify-pass5-fixed-windows.mjs |  | REVIEW_REQUIRED |
| `scripts/verify-phase208-evidence.ts` | DEBUG_SCRATCH | False |  |  | REVIEW_REQUIRED |
| `scripts/verify-phase3-rollback.ps1` | DEBUG_SCRATCH | False |  |  | REVIEW_REQUIRED |
| `scripts/verify-phase3-rollback.ps1.backup` | BACKUP | False |  |  | REVIEW_REQUIRED |
| `scripts/workspace (7).tar` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/wp2-claim-worker.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/wp3-cancel-worker.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |
| `scripts/wp3-result-worker.ts` | UNKNOWN | False |  |  | REVIEW_REQUIRED |

## Validation
- Total rows: 564
- Unique paths: 564
- Classification sum: 564 (must equal 564)
- Self-references: 0 (filtered at collection)
- Cleanup DELETE recommendations: 0 (all REVIEW_REQUIRED)
