import { Router, Request, Response } from 'express';
import * as persistence from '../phase9/persistence';

const router = Router();

router.get('/runs', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = parseInt(req.query.offset as string) || 0;
  const status = req.query.status as string;
  const environment = req.query.environment as string;
  const runs = persistence.getRuns(limit, offset, { status, environment });
  res.json({ runs, limit, offset });
});

router.get('/runs/:id', async (req: Request, res: Response) => {
  const runId = req.params.id as string;
  const run = persistence.getRunById(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

router.get('/runs/:id/baseline', async (req: Request, res: Response) => {
  const runId = req.params.id as string;
  const data = persistence.getBaseline(runId);
  res.json(data);
});

router.get('/runs/:id/performance', async (req: Request, res: Response) => {
  const runId = req.params.id as string;
  const data = persistence.db.prepare('SELECT * FROM performance_runs WHERE reliability_run_id = ?').all(runId);
  res.json(data);
});

router.get('/runs/:id/load', async (req: Request, res: Response) => {
  const runId = req.params.id as string;
  const data = persistence.db.prepare('SELECT * FROM load_test_runs WHERE reliability_run_id = ? ORDER BY concurrency').all(runId);
  res.json(data);
});

router.get('/runs/:id/stress', async (req: Request, res: Response) => {
  const runId = req.params.id as string;
  const data = persistence.db.prepare('SELECT * FROM stress_test_runs WHERE reliability_run_id = ? ORDER BY concurrency').all(runId);
  res.json(data);
});

router.get('/runs/:id/failures', async (req: Request, res: Response) => {
  const runId = req.params.id as string;
  const data = persistence.db.prepare('SELECT * FROM failure_injections WHERE reliability_run_id = ?').all(runId);
  res.json(data);
});

router.get('/runs/:id/recovery', async (req: Request, res: Response) => {
  const runId = req.params.id as string;
  const data = persistence.db.prepare('SELECT * FROM recovery_runs WHERE reliability_run_id = ?').all(runId);
  res.json(data);
});

router.get('/runs/:id/slo', async (req: Request, res: Response) => {
  const runId = req.params.id as string;
  const data = persistence.db.prepare('SELECT * FROM slo_evaluations WHERE reliability_run_id = ?').all(runId);
  res.json(data);
});

router.get('/runs/:id/error-budget', async (req: Request, res: Response) => {
  const runId = req.params.id as string;
  const data = persistence.db.prepare('SELECT * FROM error_budget_snapshots WHERE reliability_run_id = ?').all(runId);
  res.json(data);
});

router.get('/runs/:id/regression', async (req: Request, res: Response) => {
  const runId = req.params.id as string;
  const data = persistence.db.prepare('SELECT * FROM performance_regressions WHERE reliability_run_id = ?').all(runId);
  res.json(data);
});

router.get('/runs/:id/events', async (req: Request, res: Response) => {
  const runId = req.params.id as string;
  const refs = persistence.db.prepare('SELECT event_id FROM reliability_event_refs WHERE reliability_run_id = ?').all(runId) as any[];
  if (refs.length === 0) return res.json([]);
  const eventIds = refs.map(r => r.event_id);
  const placeholders = eventIds.map(() => '?').join(',');
  const events = persistence.db.prepare(`SELECT * FROM events WHERE id IN (${placeholders})`).all(...eventIds);
  res.json(events);
});

router.get('/runs/:id/audit', async (req: Request, res: Response) => {
  const runId = req.params.id as string;
  const refs = persistence.db.prepare('SELECT audit_id FROM reliability_audit_refs WHERE reliability_run_id = ?').all(runId) as any[];
  if (refs.length === 0) return res.json([]);
  const auditIds = refs.map(r => r.audit_id);
  const placeholders = auditIds.map(() => '?').join(',');
  const audits = persistence.db.prepare(`SELECT * FROM audits WHERE id IN (${placeholders})`).all(...auditIds);
  res.json(audits);
});

export default router;
