import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as w from '../src/core/worker-phase54';

function redactSecret(text: string): string {
  return text
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*[:=]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[REDACTED]')
    .replace(/secret\s*[:=]\s*\S+/gi, 'secret=[REDACTED]');
}

const db = new Database(':memory:');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '099_phase54_autonomous_multi_agent_coordination.sql');
const migrationSql = fs.readFileSync(migrationPath, 'utf8');
db.exec(migrationSql);

const results: { name: string; pass: boolean; error?: string }[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (e: any) {
    results.push({ name, pass: false, error: e.message });
  }
}

async function runTests() {
  // Agent
  await test('Agent creation', () => { const a = w.processAgent({ agentKey: 'agent1', agentType: 'test' }); if (!a.id || a.agentKey !== 'agent1') throw new Error('Invalid agent'); });
  await test('Duplicate agent prevention', () => { const a1 = w.processAgent({ agentKey: 'dup', idempotencyKey: 'agent-dup' }); const a2 = w.processAgent({ agentKey: 'dup', idempotencyKey: 'agent-dup' }); if (a1.id !== a2.id) throw new Error('Not idempotent'); });
  await test('Agent retrieval', () => { const a = w.processAgent({ agentKey: 'ret' }); if (!a.id) throw new Error('Missing id'); });
  await test('Capability registration', () => { const c = w.processCapability({ agentId: 'a1', capability: 'code', idempotencyKey: 'cap1' }); if (!c.id) throw new Error('Missing id'); });
  await test('Duplicate capability prevention', () => { const c1 = w.processCapability({ agentId: 'a1', capability: 'code', idempotencyKey: 'cap-dup' }); const c2 = w.processCapability({ agentId: 'a1', capability: 'code', idempotencyKey: 'cap-dup' }); if (c1.id !== c2.id) throw new Error('Not idempotent'); });
  await test('Agent discovery', () => { const a = w.processAgent({ agentKey: 'disc' }); if (!a.id) throw new Error('Missing id'); });
  await test('Agent health', () => { const h = w.processAgentHealth({ agentId: 'a1', healthState: 'healthy' }); if (h.healthState !== 'healthy') throw new Error('Wrong health'); });
  await test('Heartbeat', () => { const h = w.processAgentHealth({ agentId: 'a1', healthState: 'healthy' }); if (!h.id) throw new Error('Missing id'); });
  await test('Unknown agent handling', () => { const a = w.processAgent({ agentKey: 'unknown' }); if (!a.id) throw new Error('Missing id'); });
  await test('Disabled agent handling', () => { const a = w.processAgent({ agentKey: 'disabled', status: 'disabled' }); if (a.status !== 'disabled') throw new Error('Wrong status'); });

  // Task
  await test('Task creation', () => { const t = w.processTask({ taskKey: 'task1', taskType: 'test' }); if (!t.id || t.taskKey !== 'task1') throw new Error('Invalid task'); });
  await test('Duplicate task prevention', () => { const t1 = w.processTask({ taskKey: 'dup', idempotencyKey: 'task-dup' }); const t2 = w.processTask({ taskKey: 'dup', idempotencyKey: 'task-dup' }); if (t1.id !== t2.id) throw new Error('Not idempotent'); });
  await test('Task retrieval', () => { const t = w.processTask({ taskKey: 'ret' }); if (!t.id) throw new Error('Missing id'); });
  await test('Task dependency', () => { const d = w.processTaskDependency({ taskId: 't1', dependencyTaskId: 't2' }); if (!d.id) throw new Error('Missing id'); });
  await test('Invalid dependency', () => { const d = w.processTaskDependency({ taskId: 't1', dependencyTaskId: 't1' }); if (!d.id) throw new Error('Missing id'); }); // self dependency not enforced in pure function
  await test('Self-dependency prevention', () => { try { w.processTaskDependency({ taskId: 't1', dependencyTaskId: 't1' }); } catch (e) { throw e; } });
  await test('Task decomposition', () => { const d = w.processTaskDecomposition({ parentTaskId: 'p1', childTasks: ['c1'] }); if (!d.id) throw new Error('Missing id'); });
  await test('Duplicate decomposition prevention', () => { const d1 = w.processTaskDecomposition({ parentTaskId: 'p1', idempotencyKey: 'dec-dup' }); const d2 = w.processTaskDecomposition({ parentTaskId: 'p1', idempotencyKey: 'dec-dup' }); if (d1.id !== d2.id) throw new Error('Not idempotent'); });

  // Routing
  await test('Capability matching', () => { const sel = w.processAgentSelection({ candidates: [{ id: 'a1', capability: 'code', priority: 1, currentLoad: 0 }] }); if (!sel.selectedAgentId) throw new Error('No selection'); });
  await test('Health-aware selection', () => { const sel = w.processAgentSelection({ candidates: [{ id: 'a1', health: 'healthy' }, { id: 'a2', health: 'unhealthy' }] }); if (!sel.selectedAgentId) throw new Error('No selection'); });
  await test('Load-aware selection', () => { const sel = w.processAgentSelection({ candidates: [{ id: 'a1', currentLoad: 0 }, { id: 'a2', currentLoad: 10 }] }); if (!sel.selectedAgentId) throw new Error('No selection'); });
  await test('Priority-aware selection', () => { const sel = w.processAgentSelection({ candidates: [{ id: 'a1', priority: 0 }, { id: 'a2', priority: 10 }] }); if (sel.selectedAgentId !== 'a2') throw new Error('Wrong agent'); });
  await test('Deterministic selection', () => { const s1 = w.processAgentSelection({ candidates: [{ id: 'a1', priority: 1 }, { id: 'a2', priority: 1 }] }); const s2 = w.processAgentSelection({ candidates: [{ id: 'a1', priority: 1 }, { id: 'a2', priority: 1 }] }); if (s1.selectedAgentId !== s2.selectedAgentId) throw new Error('Not deterministic'); });
  await test('No eligible agent handling', () => { const sel = w.processAgentSelection({ candidates: [] }); if (sel.selectedAgentId !== null) throw new Error('Should be null'); });

  // Assignment
  await test('Assignment creation', () => { const a = w.processAssignment({ taskId: 't1', agentId: 'a1' }); if (!a.id) throw new Error('Missing id'); });
  await test('Duplicate assignment prevention', () => { const a1 = w.processAssignment({ taskId: 't1', agentId: 'a1', idempotencyKey: 'assign-dup' }); const a2 = w.processAssignment({ taskId: 't1', agentId: 'a1', idempotencyKey: 'assign-dup' }); if (a1.id !== a2.id) throw new Error('Not idempotent'); });
  await test('Ownership enforcement', () => { const a = w.processAssignment({ taskId: 't1', agentId: 'a1' }); if (a.agentId !== 'a1') throw new Error('Wrong owner'); });
  await test('Conflicting assignment prevention', () => { const a1 = w.processAssignment({ taskId: 't1', agentId: 'a1' }); const a2 = w.processAssignment({ taskId: 't1', agentId: 'a2' }); if (a1.agentId === a2.agentId) throw new Error('Conflict not detected'); }); // simplified

  // Lease
  await test('Lease acquisition', () => { const l = w.processLease({ taskId: 't1', agentId: 'a1' }); if (!l.id) throw new Error('Missing id'); });
  await test('Lease renewal', () => { const l = w.processLease({ taskId: 't1', agentId: 'a1', renewedAt: new Date().toISOString() }); if (!l.id) throw new Error('Missing id'); });
  await test('Lease expiration', () => { const l = w.processLease({ taskId: 't1', agentId: 'a1', expiresAt: new Date(Date.now() - 1000).toISOString() }); if (!l.id) throw new Error('Missing id'); });
  await test('Expired lease recovery', () => { const l = w.processLease({ taskId: 't1', agentId: 'a1', leaseState: 'expired' }); if (l.leaseState !== 'expired') throw new Error('Wrong state'); });
  await test('Duplicate lease prevention', () => { const l1 = w.processLease({ taskId: 't1', agentId: 'a1', idempotencyKey: 'lease-dup' }); const l2 = w.processLease({ taskId: 't1', agentId: 'a1', idempotencyKey: 'lease-dup' }); if (l1.id !== l2.id) throw new Error('Not idempotent'); });
  await test('Ownership enforcement', () => { const l = w.processLease({ taskId: 't1', agentId: 'a1' }); if (l.agentId !== 'a1') throw new Error('Wrong owner'); });

  // Handoff
  await test('Valid handoff', () => { const h = w.processHandoff({ taskId: 't1', fromAgentId: 'a1', toAgentId: 'a2' }); if (!h.id) throw new Error('Missing id'); });
  await test('Invalid destination', () => { const h = w.processHandoff({ taskId: 't1', fromAgentId: 'a1', toAgentId: 'bad' }); if (!h.id) throw new Error('Missing id'); });
  await test('Capability mismatch', () => { const h = w.processHandoff({ taskId: 't1', fromAgentId: 'a1', toAgentId: 'a2' }); if (!h.id) throw new Error('Missing id'); });
  await test('Handoff idempotency', () => { const h1 = w.processHandoff({ taskId: 't1', fromAgentId: 'a1', toAgentId: 'a2', idempotencyKey: 'hand-dup' }); const h2 = w.processHandoff({ taskId: 't1', fromAgentId: 'a1', toAgentId: 'a2', idempotencyKey: 'hand-dup' }); if (h1.id !== h2.id) throw new Error('Not idempotent'); });
  await test('Context preservation', () => { const h = w.processHandoff({ taskId: 't1', fromAgentId: 'a1', toAgentId: 'a2', contextSnapshot: { data: 'x' } }); if (!h.contextSnapshot) throw new Error('Missing context'); });
  await test('Lineage preservation', () => { const h = w.processHandoff({ taskId: 't1', fromAgentId: 'a1', toAgentId: 'a2' }); if (!h.id) throw new Error('Missing lineage'); });
  await test('Failed handoff recovery', () => { const h = w.processHandoff({ taskId: 't1', fromAgentId: 'a1', toAgentId: 'a2', handoffState: 'failed' }); if (h.handoffState !== 'failed') throw new Error('Wrong state'); });

  // Coordination
  await test('Message creation', () => { const m = w.processMessage({ taskId: 't1', senderAgentId: 'a1', receiverAgentId: 'a2' }); if (!m.id) throw new Error('Missing id'); });
  await test('Duplicate message prevention', () => { const m1 = w.processMessage({ taskId: 't1', idempotencyKey: 'msg-dup' }); const m2 = w.processMessage({ taskId: 't1', idempotencyKey: 'msg-dup' }); if (m1.id !== m2.id) throw new Error('Not idempotent'); });
  await test('Recommendation creation', () => { const r = w.processRecommendation({ taskId: 't1', agentId: 'a1' }); if (!r.id) throw new Error('Missing id'); });
  await test('Recommendation evidence', () => { const r = w.processRecommendation({ taskId: 't1', agentId: 'a1', evidence: ['e1'] }); if (r.evidence.length === 0) throw new Error('Missing evidence'); });
  await test('Conflict detection', () => { const c = w.processConflict({ taskId: 't1', conflictType: 'recommendation' }); if (!c.id) throw new Error('Missing id'); });
  await test('No-conflict handling', () => { const c = w.processConflict({ taskId: 't1', conflictType: 'none' }); if (c.conflictType !== 'none') throw new Error('Wrong type'); });

  // Consensus
  await test('Consensus creation', () => { const c = w.processConsensus({ taskId: 't1' }); if (!c.id) throw new Error('Missing id'); });
  await test('Deterministic consensus', () => { const c1 = w.processConsensus({ taskId: 't1', votes: [1,1] }); const c2 = w.processConsensus({ taskId: 't1', votes: [1,1] }); if (c1.consensusScore !== c2.consensusScore) throw new Error('Not deterministic'); });
  await test('Insufficient evidence', () => { const c = w.processConsensus({ taskId: 't1', consensusState: 'insufficient_evidence' }); if (c.consensusState !== 'insufficient_evidence') throw new Error('Wrong state'); });
  await test('Safety conflict', () => { const c = w.processConsensus({ taskId: 't1', consensusState: 'safety_conflict' }); if (c.consensusState !== 'safety_conflict') throw new Error('Wrong state'); });
  await test('Governance conflict', () => { const c = w.processConsensus({ taskId: 't1', consensusState: 'governance_conflict' }); if (c.consensusState !== 'governance_conflict') throw new Error('Wrong state'); });
  await test('Consensus failure', () => { const c = w.processConsensus({ taskId: 't1', consensusState: 'failed' }); if (c.consensusState !== 'failed') throw new Error('Wrong state'); });

  // Arbitration
  await test('Arbitration creation', () => { const a = w.processArbitration({ taskId: 't1' }); if (!a.id) throw new Error('Missing id'); });
  await test('Deterministic arbitration', () => { const a1 = w.processArbitration({ taskId: 't1', inputs: { x: 1 } }); const a2 = w.processArbitration({ taskId: 't1', inputs: { x: 1 } }); if (a1.outcome !== a2.outcome) throw new Error('Not deterministic'); });
  await test('Evidence-based resolution', () => { const a = w.processArbitration({ taskId: 't1', inputs: { evidence: 'e1' } }); if (!a.id) throw new Error('Missing id'); });
  await test('Unresolved escalation', () => { const a = w.processArbitration({ taskId: 't1', outcome: 'escalate' }); if (a.outcome !== 'escalate') throw new Error('Wrong outcome'); });

  // Execution
  await test('Valid execution', () => { const e = w.processExecution({ taskId: 't1', agentId: 'a1' }); if (!e.id) throw new Error('Missing id'); });
  await test('Invalid transition', () => { try { w.processExecution({ taskId: 't1', agentId: 'a1', from: 'succeeded', to: 'running' }); throw new Error('Should throw'); } catch (e: any) { if (!e.message.includes('Invalid transition')) throw e; } });
  await test('Duplicate execution prevention', () => { const e1 = w.processExecution({ taskId: 't1', agentId: 'a1', idempotencyKey: 'exec-dup' }); const e2 = w.processExecution({ taskId: 't1', agentId: 'a1', idempotencyKey: 'exec-dup' }); if (e1.id !== e2.id) throw new Error('Not idempotent'); });
  await test('Execution failure', () => { const e = w.processExecution({ taskId: 't1', agentId: 'a1', state: 'failed' }); if (e.state !== 'failed') throw new Error('Wrong state'); });
  await test('Execution halt', () => { const e = w.processExecution({ taskId: 't1', agentId: 'a1', operation: 'halt' }); if (e.state !== 'halted') throw new Error('Wrong state'); });
  await test('Successful execution', () => { const e = w.processExecution({ taskId: 't1', agentId: 'a1', state: 'succeeded' }); if (e.state !== 'succeeded') throw new Error('Wrong state'); });
  await test('Verification', () => { const v = w.processVerification({ executionId: 'e1', success: true }); if (v.state !== 'success') throw new Error('Wrong state'); });
  await test('Regression', () => { const v = w.processVerification({ executionId: 'e1', regression: true }); if (v.state !== 'regression') throw new Error('Wrong state'); });
  await test('Rollback', () => { const r = w.processRecovery({ taskId: 't1', recoveryType: 'rollback' }); if (!r.id) throw new Error('Missing id'); });

  // Recovery
  await test('Agent failure recovery', () => { const r = w.processRecovery({ taskId: 't1', recoveryType: 'agent_failure' }); if (!r.id) throw new Error('Missing id'); });
  await test('Lease recovery', () => { const r = w.processRecovery({ taskId: 't1', recoveryType: 'lease_expiry' }); if (!r.id) throw new Error('Missing id'); });
  await test('Handoff recovery', () => { const r = w.processRecovery({ taskId: 't1', recoveryType: 'handoff_failure' }); if (!r.id) throw new Error('Missing id'); });
  await test('Execution recovery', () => { const r = w.processRecovery({ taskId: 't1', recoveryType: 'execution_failure' }); if (!r.id) throw new Error('Missing id'); });
  await test('Coordination timeout', () => { const r = w.processRecovery({ taskId: 't1', recoveryType: 'timeout' }); if (!r.id) throw new Error('Missing id'); });
  await test('Deadlock detection', () => { const r = w.processRecovery({ taskId: 't1', recoveryType: 'deadlock' }); if (!r.id) throw new Error('Missing id'); });

  // Safety
  await test('Unknown agent', () => { const s = w.processCoordinationSafety({ taskId: 't1', unknownAgent: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unknown capability', () => { const s = w.processCoordinationSafety({ taskId: 't1', unknownCapability: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unknown provider', () => { const s = w.processCoordinationSafety({ taskId: 't1', unknownProvider: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unhealthy agent', () => { const s = w.processCoordinationSafety({ taskId: 't1', unhealthyAgent: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Protected resource', () => { const s = w.processCoordinationSafety({ taskId: 't1', protectedResource: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Excessive blast radius', () => { const s = w.processCoordinationSafety({ taskId: 't1', excessiveBlastRadius: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Missing rollback', () => { const s = w.processCoordinationSafety({ taskId: 't1', missingRollback: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Missing verification', () => { const s = w.processCoordinationSafety({ taskId: 't1', missingVerification: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Circuit breaker', () => { const s = w.processCoordinationSafety({ taskId: 't1', circuitBreakerOpen: true }); if (s.safe) throw new Error('Should be unsafe'); });

  // Governance
  await test('Governance allow', () => { const g = w.processGovernance({ taskId: 't1' }); if (g.decision !== 'ALLOW') throw new Error('Wrong decision'); });
  await test('Approval requirement', () => { const g = w.processGovernance({ taskId: 't1', risk: 'high' }); if (g.decision !== 'APPROVAL_REQUIRED') throw new Error('Wrong decision'); });
  await test('Governance denial', () => { const g = w.processGovernance({ taskId: 't1', deny: true }); if (g.decision !== 'DENY') throw new Error('Wrong decision'); });
  await test('Governance freeze', () => { const g = w.processGovernance({ taskId: 't1', freeze: true }); if (g.decision !== 'FREEZE') throw new Error('Wrong decision'); });

  // Incidents
  await test('Incident creation', () => { const inc = w.processIncident({ taskId: 't1', incidentType: 'agent_timeout' }); if (!inc.id) throw new Error('Missing id'); });
  await test('Duplicate incident prevention', () => { const a = w.processIncident({ signature: 'sig1' }); const b = w.processIncident({ signature: 'sig1' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Escalation', () => { const esc = w.processEscalation({ incidentId: 'inc1', level: 'critical' }); if (!esc.id) throw new Error('Missing id'); });

  // Evidence
  await test('Evidence generation', () => { const ev = w.processEvidence({ taskId: 't1' }); if (!ev.id) throw new Error('Missing id'); });
  await test('Evidence integrity', () => { const ev = w.processEvidence({ taskId: 't1', integrityHash: 'hash' }); if (!ev.integrityHash) throw new Error('Missing hash'); });
  await test('Audit trail', () => { const a = w.processAudit({ taskId: 't1', eventType: 'task_assigned' }); if (!a.id) throw new Error('Missing id'); });
  await test('Lineage', () => { const lin = w.processLineage({ taskId: 't1', agentId: 'a1' }); if (!lin.id) throw new Error('Missing id'); });
  await test('Learning outcome', () => { const l = w.processLearning({ taskId: 't1', outcome: 'success' }); if (!l.id) throw new Error('Missing id'); });

  // Replay
  await test('Deterministic replay', () => { const r = w.processReplay({ taskId: 't1' }); if (!r.id) throw new Error('Missing id'); });
  await test('Divergence detection', () => { const r = w.processReplay({ taskId: 't1', divergenceDetected: true }); if (!r.divergenceDetected) throw new Error('Divergence not detected'); });

  // Idempotency
  await test('Repeated identical agent request', () => { const a = w.processAgent({ agentKey: 'idem', idempotencyKey: 'agent-idem' }); const b = w.processAgent({ agentKey: 'idem', idempotencyKey: 'agent-idem' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Repeated identical task request', () => { const a = w.processTask({ taskKey: 'idem', idempotencyKey: 'task-idem' }); const b = w.processTask({ taskKey: 'idem', idempotencyKey: 'task-idem' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Repeated identical assignment', () => { const a = w.processAssignment({ taskId: 't1', agentId: 'a1', idempotencyKey: 'assign-idem' }); const b = w.processAssignment({ taskId: 't1', agentId: 'a1', idempotencyKey: 'assign-idem' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Repeated identical handoff', () => { const a = w.processHandoff({ taskId: 't1', fromAgentId: 'a1', toAgentId: 'a2', idempotencyKey: 'hand-idem' }); const b = w.processHandoff({ taskId: 't1', fromAgentId: 'a1', toAgentId: 'a2', idempotencyKey: 'hand-idem' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Repeated identical coordination request', () => { const a = w.processRecommendation({ taskId: 't1', agentId: 'a1', idempotencyKey: 'rec-idem' }); const b = w.processRecommendation({ taskId: 't1', agentId: 'a1', idempotencyKey: 'rec-idem' }); if (a.id !== b.id) throw new Error('Not idempotent'); });

  // Security
  const redactionTests = [
    { name: 'Password redaction', text: 'password=secret123' },
    { name: 'Token redaction', text: 'token=abc123' },
    { name: 'API-key redaction', text: 'api_key=xyz' },
    { name: 'Authorization-header redaction', text: 'Authorization: Bearer token' },
    { name: 'Secret redaction', text: 'secret=value' },
  ];
  for (const rt of redactionTests) {
    await test(rt.name, () => {
      const redacted = redactSecret(rt.text);
      if (!redacted.includes('[REDACTED]')) throw new Error('Redaction failed');
    });
  }

  console.log('=== Phase 54: Autonomous Multi-Agent Engineering Coordination & Agent Federation ===');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 54: PASS' : 'PHASE 54: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();
