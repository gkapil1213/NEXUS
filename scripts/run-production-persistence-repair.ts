import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { MigrationRunner } from '../src/core/migration-runner';
import { ExecutionStore } from '../src/core/execution-store';
import { LeaseManager } from '../src/core/lease-manager';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
    if (condition) { passed++; } else { failed++; failures.push(message); console.error(`FAIL: ${message}`); }
}
function assertThrows(fn: () => any, message: string): void {
    try { fn(); failed++; failures.push(`Expected throw: ${message}`); console.error(`FAIL (no throw): ${message}`); } catch { passed++; }
}

async function runTests() {
    // --- Controlled migration tests ---
    const tempDir = mkdtempSync(join(tmpdir(), 'nexus-repair-'));
    const dbPath = join(tempDir, 'test.sqlite');
    const db = new Database(dbPath);
    const migDir = join(tempDir, 'migrations');
    mkdirSync(migDir, { recursive: true });

    // Create minimal migrations for lifecycle testing
    writeFileSync(join(migDir, '001_init.sql'), 'CREATE TABLE test_table (id TEXT PRIMARY KEY);');
    writeFileSync(join(migDir, '002_alter.sql'), 'ALTER TABLE test_table ADD COLUMN extra TEXT;');

    const runner = new MigrationRunner(db, migDir);
    runner.run();
    let applied = runner.getAppliedMigrations();
    assert(applied.length === 2, 'Test migrations applied');
    assert(applied[0].filename === '001_init.sql', 'Ordered application');

    // Idempotency
    runner.run();
    applied = runner.getAppliedMigrations();
    assert(applied.length === 2, 'Idempotent second run');

    // Checksum mismatch
    db.prepare(`UPDATE nexus_schema_migrations SET checksum = 'bad' WHERE filename = '001_init.sql'`).run();
    assertThrows(() => runner.verifyIntegrity(), 'Checksum mismatch detected');
    const correctChecksum = createHash('sha256').update(readFileSync(join(migDir, '001_init.sql'), 'utf8')).digest('hex');
    db.prepare(`UPDATE nexus_schema_migrations SET checksum = ? WHERE filename = '001_init.sql'`).run(correctChecksum);
    runner.verifyIntegrity();
    assert(true, 'Integrity restored');

    // Migration failure rollback
    writeFileSync(join(migDir, '003_bad.sql'), 'INVALID SQL;');
    assertThrows(() => runner.run(), 'Failed migration throws');
    applied = runner.getAppliedMigrations();
    assert(applied.length === 2, 'Failed migration not recorded');
    rmSync(join(migDir, '003_bad.sql'), { force: true });

    // Duplicate migration identifier test using same filename (not possible in same dir)
    // Instead, simulate by manually inserting a duplicate history record and then trying to apply
    db.prepare(`INSERT INTO nexus_schema_migrations (id, filename, checksum, applied_at) VALUES ('001_dup', '001_dup.sql', 'abc', '2024-01-01')`).run();
    // Now create a new migration file with same id
    writeFileSync(join(migDir, '001_dup.sql'), 'SELECT 1;');
    assertThrows(() => runner.run(), 'Duplicate migration filename causes failure');
    rmSync(join(migDir, '001_dup.sql'), { force: true });
    db.prepare(`DELETE FROM nexus_schema_migrations WHERE id = '001_dup'`).run();

    // Prepare execution_leases table for lease tests
    db.exec(`
        CREATE TABLE IF NOT EXISTS execution_leases (
            lease_id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            worker_id TEXT NOT NULL,
            acquired_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            renewed_at INTEGER,
            released_at INTEGER,
            status TEXT NOT NULL
        )
    `);

    // Apply migration 142 (lease partial unique index)
    const migration142Path = join(process.cwd(), 'src', 'db', 'migrations', '142_phase_production_persistence_lease_integrity.sql');
    const migration142Sql = readFileSync(migration142Path, 'utf8');
    db.exec(migration142Sql);
    assert(true, 'Migration 142 applied');

    const store = new ExecutionStore(db);
    const leaseManager = new LeaseManager(store);
    const jobId = 'job-1';
    const workerA = 'worker-a';
    const workerB = 'worker-b';
    const durationMs = 5000;

    const lease1 = leaseManager.acquireLease(jobId, workerA, durationMs);
    assert(lease1.status === 'ACTIVE', 'First lease active');
    assert(store.getActiveLeaseForJob(jobId)?.leaseId === lease1.leaseId, 'Active lease stored');

    assertThrows(() => leaseManager.acquireLease(jobId, workerB, durationMs), 'Different worker cannot acquire active lease');
    const lease1Again = leaseManager.acquireLease(jobId, workerA, durationMs);
    assert(lease1Again.leaseId === lease1.leaseId, 'Same worker can re-acquire');

    // Direct SQL uniqueness enforcement
    assertThrows(() => db.prepare(`INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, renewed_at, released_at, status) VALUES ('lease_fake', ?, 'fake', 123, 456, NULL, NULL, 'ACTIVE')`).run(jobId), 'Partial unique index blocks duplicate ACTIVE lease');

    leaseManager.releaseLease(lease1.leaseId);
    const lease2 = leaseManager.acquireLease(jobId, workerB, durationMs);
    assert(lease2.workerId === workerB, 'After release, different worker can acquire');

    lease2.expiresAt = Date.now() - 1000;
    store.updateLease(lease2);
    const recovered = leaseManager.recoverExpiredLeases(Date.now());
    assert(recovered.length >= 1, 'Expired lease recovered');
    const lease3 = leaseManager.acquireLease(jobId, workerA, durationMs);
    assert(lease3.workerId === workerA, 'After recovery, can acquire new lease');

    // Concurrency test
    const dbConcurrent = new Database(dbPath);
    const storeConcurrent = new ExecutionStore(dbConcurrent);
    const leaseManagerConcurrent = new LeaseManager(storeConcurrent);
    const jobIdConc = 'job-concurrent';
    const attempts = 5;
    const results = await Promise.all(
        Array.from({ length: attempts }, (_, i) =>
            Promise.resolve().then(() => {
                try {
                    const lease = leaseManagerConcurrent.acquireLease(jobIdConc, `worker-${i}`, 10000);
                    return { success: true, lease };
                } catch (err: any) {
                    return { success: false, lease: null, error: err.message };
                }
            })
        )
    );
    const winners = results.filter(r => r.success);
    assert(winners.length === 1, `Concurrency: exactly one winner, got ${winners.length}`);
    const activeLeases = dbConcurrent.prepare(`SELECT * FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'`).all(jobIdConc);
    assert(activeLeases.length === 1, `Concurrency: exactly one ACTIVE lease, got ${activeLeases.length}`);
    dbConcurrent.close();

    // Cleanup
    db.close();
    rmSync(tempDir, { recursive: true, force: true });

    console.log('----------------------------------------');
    console.log('Production persistence repair test suite completed.');
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

runTests().catch(err => {
    console.error('Harness error:', err);
    process.exit(1);
});
