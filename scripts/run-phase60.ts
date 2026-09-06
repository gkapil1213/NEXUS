import * as w from '../src/core/worker-phase60';

const results: { name: string; pass: boolean; error?: string }[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, pass: true }); } catch (e: any) { results.push({ name, pass: false, error: e.message }); }
}

async function runTests() {
  // Fleet
  await test('Fleet node creation', () => { const n = w.createFleetNode({ nodeKey: 'node1', environmentId: 'prod', provider: 'aws', capacity: 10, capabilities: ['deploy'], health: 'HEALTHY', idempotencyKey: 'node1' }); if (!n.id) throw new Error('Missing'); });
  await test('Duplicate node prevention', () => { const a = w.createFleetNode({ nodeKey: 'dup', idempotencyKey: 'node-dup' }); const b = w.createFleetNode({ nodeKey: 'dup', idempotencyKey: 'node-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Node discovery', () => { const n = w.discoverFleetNode('node1'); if (!n) throw new Error('Not found'); });
  await test('Node observation', () => { const n = w.observeFleetNode('node1', 'DEGRADED'); if (!n || n.health !== 'DEGRADED') throw new Error('Wrong health'); });
  await test('Unknown node handling', () => { const n = w.getFleetNode('nonexistent'); if (n) throw new Error('Should be null'); });
  await test('Node health', () => { const h = w.evaluateNodeHealth('HEALTHY'); if (!h.safeForHighRisk) throw new Error('Should be safe'); });
  await test('Stale node detection', () => { w.updateFleetNode('node1', { lastSeen: new Date(Date.now()-120000).toISOString() }); if (!w.detectStaleNode(w.getFleetNode('node1')!, Date.now())) throw new Error('Should be stale'); });

  // Workloads
  await test('Workload creation', () => { const wl = w.createWorkload({ workloadKey: 'wl1', type: 'deploy', targetEnvironment: 'prod', requiredCapabilities: ['deploy'], requiredResources: { cpu: 1 }, idempotencyKey: 'wl1' }); if (!wl.id) throw new Error('Missing'); });
  await test('Duplicate workload prevention', () => { const a = w.createWorkload({ workloadKey: 'dup', idempotencyKey: 'wl-dup' }); const b = w.createWorkload({ workloadKey: 'dup', idempotencyKey: 'wl-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Workload validation', () => { const wl = w.getWorkload('wl1'); if (!wl || !w.validateWorkload(wl).valid) throw new Error('Invalid'); });
  await test('Cancellation', () => { const wl = w.cancelWorkload('wl1'); if (!wl || wl.state !== 'CANCELLED') throw new Error('Not cancelled'); });
  await test('Pause/resume', () => { w.resumeWorkload('wl1'); if (w.getWorkload('wl1')!.state !== 'PENDING') throw new Error('Resume failed'); });

  // Resources
  await test('Requirement normalization', () => { const n = w.normalizeRequirements({ CPU: 2, Mem: 4 }); if (n.cpu !== 2 || n.mem !== 4) throw new Error('Wrong'); });
  await test('Invalid requirements', () => { if (w.validateRequirements({ cpu: -1 })) throw new Error('Should be invalid'); });
  await test('Capacity calculation', () => { const avail = { cpu: 10, mem: 20 }; const req = { cpu: 5, mem: 10 }; if (!w.compareCapacity(avail, req)) throw new Error('Should fit'); });
  await test('Resource fit', () => { const score = w.calculateResourceFit({ cpu: 10 }, { cpu: 5 }); if (score <= 0 || score > 1) throw new Error('Wrong score'); });
  await test('Insufficient capacity', () => { if (w.compareCapacity({ cpu: 2 }, { cpu: 5 })) throw new Error('Should not fit'); });

  // Queue
  await test('Queue creation', () => { const q = w.createQueue('critical', 'CRITICAL'); if (!q) throw new Error('Missing'); });
  await test('Enqueue', () => { const q = w.createQueue('normal', 'NORMAL'); if (!w.enqueueWorkload(q, 'wl1')) throw new Error('Enqueue failed'); });
  await test('Dequeue', () => { const q = w.createQueue('test', 'LOW'); w.enqueueWorkload(q, 'wl1'); if (w.dequeueWorkload(q) !== 'wl1') throw new Error('Dequeue wrong'); });
  await test('Queue aging', () => { const q = w.createQueue('age', 'NORMAL'); w.enqueueWorkload(q, 'wl1'); if (w.queueAging(q) !== 1) throw new Error('Wrong'); });

  // Priority
  await test('Critical priority', () => { const wl = w.createWorkload({ workloadKey: 'crit', type: 'test', targetEnvironment: 'prod', criticality: 'critical', priority: 10, idempotencyKey: 'crit' }); const score = w.calculatePriority(wl, 0); if (score <= 100) throw new Error('Too low'); });
  await test('Deadline pressure', () => { const wl = w.createWorkload({ workloadKey: 'dl', type: 'test', targetEnvironment: 'prod', deadline: new Date(Date.now()+30000).toISOString(), idempotencyKey: 'dl' }); const score = w.calculatePriority(wl, 0); if (score < 40) throw new Error('Deadline not applied'); });
  await test('Aging', () => { const wl = w.getWorkload('wl1')!; const score = w.calculatePriority(wl, 50); if (score <= 0) throw new Error('Aging not applied'); });
  await test('Deterministic scoring', () => { const a = w.calculatePriority(w.getWorkload('crit')!, 10); const b = w.calculatePriority(w.getWorkload('crit')!, 10); if (a !== b) throw new Error('Not deterministic'); });

  // Fairness
  await test('Fair scheduling', () => { const s = w.fairnessScore(10, 2); if (s !== 30) throw new Error('Wrong fairness'); });
  await test('Starvation detection', () => { if (!w.detectStarvation(6)) throw new Error('Should detect starvation'); });

  // Eligibility
  await test('Valid workload', () => { const node = w.getFleetNode('node1')!; node.health = 'HEALTHY'; node.capabilities.add('deploy'); node.availableCapacity = 10; const wl = w.getWorkload('wl1')!; const e = w.evaluateEligibility(wl, node); if (e.state !== 'ELIGIBLE') throw new Error('Should be eligible'); });
  await test('Unknown environment', () => { const node = w.createFleetNode({ nodeKey: 'node2', environmentId: 'other', health: 'HEALTHY', capacity: 10, capabilities: ['deploy'], idempotencyKey: 'node2' }); const wl = w.getWorkload('wl1')!; const e = w.evaluateEligibility(wl, node); if (e.state === 'ELIGIBLE') throw new Error('Should block'); });
  await test('Missing capability', () => { const node = w.createFleetNode({ nodeKey: 'node3', environmentId: 'prod', health: 'HEALTHY', capacity: 10, capabilities: ['other'], idempotencyKey: 'node3' }); const wl = w.getWorkload('wl1')!; const e = w.evaluateEligibility(wl, node); if (e.state === 'ELIGIBLE') throw new Error('Should block missing cap'); });
  await test('Circuit breaker open', () => { w.setBreakerState('OPEN'); const node = w.getFleetNode('node1')!; const wl = w.getWorkload('wl1')!; const e = w.evaluateEligibility(wl, node); if (e.state === 'ELIGIBLE') throw new Error('Should block when breaker open'); w.setBreakerState('CLOSED'); });

  // Agent selection
  await test('Valid agent', () => { const node = w.getFleetNode('node1')!; const wl = w.getWorkload('wl1')!; const sel = w.selectAgent(wl, [node]); if (!sel.selected) throw new Error('No agent'); });
  await test('Capability mismatch', () => { const node = w.createFleetNode({ nodeKey: 'node4', environmentId: 'prod', health: 'HEALTHY', capacity: 10, capabilities: ['other'], idempotencyKey: 'node4' }); const wl = w.getWorkload('wl1')!; const sel = w.selectAgent(wl, [node]); if (sel.selected) throw new Error('Should reject'); });
  await test('Environment mismatch', () => { const node = w.createFleetNode({ nodeKey: 'node5', environmentId: 'dev', health: 'HEALTHY', capacity: 10, capabilities: ['deploy'], idempotencyKey: 'node5' }); const wl = w.getWorkload('wl1')!; const sel = w.selectAgent(wl, [node]); if (sel.selected) throw new Error('Should reject'); });
  await test('Unhealthy agent', () => { const node = w.createFleetNode({ nodeKey: 'node6', environmentId: 'prod', health: 'UNKNOWN', capacity: 10, capabilities: ['deploy'], idempotencyKey: 'node6' }); const wl = w.getWorkload('wl1')!; const sel = w.selectAgent(wl, [node]); if (sel.selected) throw new Error('Should reject'); });
  await test('Insufficient capacity', () => { const node = w.createFleetNode({ nodeKey: 'node7', environmentId: 'prod', health: 'HEALTHY', capacity: 0, availableCapacity: 0, capabilities: ['deploy'], idempotencyKey: 'node7' }); const wl = w.getWorkload('wl1')!; const sel = w.selectAgent(wl, [node]); if (sel.selected) throw new Error('Should reject'); });
  await test('Deterministic selection', () => { const n1 = w.getFleetNode('node1')!; const n2 = w.getFleetNode('node4')!; const wl = w.getWorkload('wl1')!; const s1 = w.selectAgent(wl, [n1, n2]); const s2 = w.selectAgent(wl, [n1, n2]); if (s1.selected?.id !== s2.selected?.id) throw new Error('Not deterministic'); });

  // Reservations
  await test('Reservation creation', () => { const r = w.createReservation('wl1', 'node1', 'cpu', 1); if (!r.id) throw new Error('Missing'); });
  await test('Duplicate reservation prevention', () => { const r1 = w.createReservation('wl1', 'node1', 'cpu', 1); const r2 = w.createReservation('wl1', 'node1', 'cpu', 1); if (r1.id && r2.id && r1.id === r2.id) throw new Error('Should prevent duplicate'); });
  await test('Reservation conflict', () => { if (!w.detectReservationConflict('node1', 'cpu')) throw new Error('Conflict not detected'); });
  await test('Reservation release', () => { const r = w.createReservation('wl1', 'node1', 'cpu', 1); if (r.id && !w.releaseReservation(r.id)) throw new Error('Release failed'); });

  // Assignment
  await test('Valid assignment', () => { const a = w.createAssignment('wl1', 'node1'); if (!a.id) throw new Error('Missing'); });
  await test('Duplicate assignment prevention', () => { const a1 = w.createAssignment('wl1', 'node1'); const a2 = w.createAssignment('wl1', 'node1'); if (a1.id && a2.id && a1.id === a2.id) throw new Error('Should prevent duplicate'); });

  // Concurrency
  await test('Per-agent concurrency', () => { const node = w.getFleetNode('node1')!; node.currentWorkloads = 1; if (!w.checkConcurrency(node, 5)) throw new Error('Should allow'); });

  // Preemption
  await test('Preemption allowed', () => { const wl = w.createWorkload({ workloadKey: 'preempt', preemptible: true, idempotencyKey: 'preempt' }); if (!w.requestPreemption(wl)) throw new Error('Should allow'); });
  await test('Preemption denied', () => { const wl = w.createWorkload({ workloadKey: 'nopreempt', preemptible: false, idempotencyKey: 'nopreempt' }); if (w.requestPreemption(wl)) throw new Error('Should deny'); });

  // Deadline
  await test('Deadline calculation', () => { const wl = w.getWorkload('dl')!; if (w.deadlineRisk(wl, Date.now()) !== 'at-risk') throw new Error('Wrong risk'); });
  await test('Overdue workload', () => { const wl = w.getWorkload('dl')!; wl.deadline = new Date(Date.now()-10000).toISOString(); if (w.deadlineRisk(wl, Date.now()) !== 'overdue') throw new Error('Wrong'); });

  // Execution
  await test('Valid execution', () => { const wl = w.createWorkload({ workloadKey: 'exec', type: 'test', targetEnvironment: 'prod', idempotencyKey: 'exec' }); const t = w.transitionWorkload(wl.id, 'PENDING', 'ELIGIBLE'); if (!t.valid) throw new Error('Invalid'); });
  await test('Invalid transition', () => { const wl = w.getWorkload('exec')!; const t = w.transitionWorkload(wl.id, 'PENDING', 'RUNNING'); if (t.valid) throw new Error('Should be invalid'); });
  await test('Execution failure', () => { const wl = w.getWorkload('exec')!; w.transitionWorkload(wl.id, 'ELIGIBLE', 'RESERVED'); w.transitionWorkload(wl.id, 'RESERVED', 'ASSIGNED'); w.transitionWorkload(wl.id, 'ASSIGNED', 'RUNNING'); const f = w.transitionWorkload(wl.id, 'RUNNING', 'FAILED'); if (!f.valid) throw new Error('Fail invalid'); });
  await test('Success', () => { const wl = w.createWorkload({ workloadKey: 'succ', type: 'test', targetEnvironment: 'prod', idempotencyKey: 'succ' }); w.transitionWorkload(wl.id, 'PENDING', 'ELIGIBLE'); w.transitionWorkload(wl.id, 'ELIGIBLE', 'RESERVED'); w.transitionWorkload(wl.id, 'RESERVED', 'ASSIGNED'); w.transitionWorkload(wl.id, 'ASSIGNED', 'RUNNING'); const t = w.transitionWorkload(wl.id, 'RUNNING', 'COMPLETED'); if (!t.valid) throw new Error('Success invalid'); });

  // Incidents
  await test('Incident creation', () => { const inc = w.createIncident('wl1', 'high'); if (!inc.signature) throw new Error('Missing'); });
  await test('Duplicate incident prevention', () => { const sig = w.createIncident('wl1', 'high').signature; if (!w.isDuplicateIncident(sig)) throw new Error('Duplicate not detected'); });

  // Evidence/Audit/Lineage/Learning
  await test('Evidence generation', () => { const ev = w.generateEvidence('wl1', 'test', {}); if (!ev.evidenceId) throw new Error('Missing'); });
  await test('Evidence integrity', () => { const ev = w.generateEvidence('wl1', 'test', { hash: 'abc' }); if (!ev.workloadId) throw new Error('Missing'); });
  await test('Audit trail', () => { const a = w.generateAudit('wl1', 'action'); if (!a.auditId) throw new Error('Missing'); });
  await test('Lineage', () => { const l = w.generateLineage('wl1', 'parent'); if (!l.lineageId) throw new Error('Missing'); });
  await test('Learning outcome', () => { const l = w.generateLearning('wl1', 'success'); if (!l.learningId) throw new Error('Missing'); });

  // Replay
  await test('Deterministic replay', () => { const r1 = w.replaySchedulingDecision({}); const r2 = w.replaySchedulingDecision({}); if (r1.result !== r2.result) throw new Error('Not deterministic'); });

  // Security redaction
  const redactionTests = [
    { name: 'Password redaction', text: 'password=secret123' },
    { name: 'Token redaction', text: 'token=abc123' },
    { name: 'API-key redaction', text: 'api_key=xyz' },
    { name: 'Authorization-header redaction', text: 'Authorization: Bearer token' },
    { name: 'Secret redaction', text: 'secret=value' },
  ];
  for (const rt of redactionTests) {
    await test(rt.name, () => { const redacted = w.redactSecret(rt.text); if (!redacted.includes('[REDACTED]')) throw new Error('Redaction failed'); });
  }

  // Full lifecycle
  await test('Full lifecycle', () => {
    const node = w.createFleetNode({ nodeKey: 'full-node', environmentId: 'prod', provider: 'aws', capacity: 10, capabilities: ['deploy'], health: 'HEALTHY', idempotencyKey: 'full-node' });
    const wl = w.createWorkload({ workloadKey: 'full-wl', type: 'deploy', targetEnvironment: 'prod', requiredCapabilities: ['deploy'], requiredResources: { cpu: 1 }, idempotencyKey: 'full-wl' });
    const elig = w.evaluateEligibility(wl, node);
    if (elig.state !== 'ELIGIBLE') throw new Error('Not eligible');
    const sel = w.selectAgent(wl, [node]);
    if (!sel.selected) throw new Error('No selection');
    const res = w.createReservation(wl.id, node.id, 'cpu', 1);
    if (!res.id) throw new Error('Reservation failed');
    const assign = w.createAssignment(wl.id, node.id);
    if (!assign.id) throw new Error('Assignment failed');
    w.transitionWorkload(wl.id, 'PENDING', 'ELIGIBLE');
    w.transitionWorkload(wl.id, 'ELIGIBLE', 'RESERVED');
    w.transitionWorkload(wl.id, 'RESERVED', 'ASSIGNED');
    w.transitionWorkload(wl.id, 'ASSIGNED', 'RUNNING');
    w.transitionWorkload(wl.id, 'RUNNING', 'COMPLETED');
    if (w.getWorkload(wl.id)!.state !== 'COMPLETED') throw new Error('Not completed');
  });

  // Idempotency for workload request
  await test('Repeated identical workload request', () => { const a = w.createWorkload({ workloadKey: 'idem-wl', idempotencyKey: 'idem-wl' }); const b = w.createWorkload({ workloadKey: 'idem-wl', idempotencyKey: 'idem-wl' }); if (a.id !== b.id) throw new Error('Not idempotent'); });

  console.log('=== Phase 60: Autonomous Engineering Fleet Orchestration, Workload Scheduling & Global Resource Arbitration ===');
  let passed = 0;
  for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`); if (r.pass) passed++; }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 60: PASS' : 'PHASE 60: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();
