export type FreshnessStatus = 'FRESH' | 'DEGRADED' | 'STALE' | 'UNKNOWN';

export function evaluateFreshness(expected: number, observed: number, threshold: number): FreshnessStatus {
  if (expected === undefined || observed === undefined) return 'UNKNOWN';
  if (observed <= expected + threshold) return 'FRESH';
  if (observed <= expected + 2 * threshold) return 'DEGRADED';
  return 'STALE';
}
