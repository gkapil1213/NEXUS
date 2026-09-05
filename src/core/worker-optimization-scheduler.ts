export type SchedulingDecision = 'RUN_NOW' | 'QUEUE' | 'DEFER' | 'BLOCK' | 'CANCEL';

export interface ScheduleItem {
  candidateId: string;
  tenantId: string;
  dependencies: string[];
  conflicts: string[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  activeIncident: boolean;
  productionFreeze: boolean;
  resourceAvailable: boolean;
  concurrentExperiments: number;
  maxConcurrentExperiments: number;
}

export function scheduleCandidate(item: ScheduleItem, runningCandidates: string[]): SchedulingDecision {
  if (item.productionFreeze || item.activeIncident) return 'BLOCK';
  if (item.risk === 'CRITICAL' || item.risk === 'UNKNOWN') return 'DEFER';
  if (item.conflicts.some(c => runningCandidates.includes(c))) return 'BLOCK';
  if (item.dependencies.some(d => !runningCandidates.includes(d))) return 'QUEUE';
  if (!item.resourceAvailable) return 'DEFER';
  if (item.concurrentExperiments >= item.maxConcurrentExperiments) return 'QUEUE';
  return 'RUN_NOW';
}
