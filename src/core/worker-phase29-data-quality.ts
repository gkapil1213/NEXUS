export interface DataQualityAssessment {
  resourceId: string;
  completeness: number;
  uniqueness: number;
  validity: number;
  consistency: number;
  freshness: number;
  overall: 'GOOD' | 'FAIR' | 'POOR' | 'UNKNOWN';
}

export function assessDataQuality(input: Omit<DataQualityAssessment, 'overall'>): DataQualityAssessment {
  const vals = [input.completeness, input.uniqueness, input.validity, input.consistency, input.freshness];
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  const overall = avg >= 0.9 ? 'GOOD' : avg >= 0.7 ? 'FAIR' : 'POOR';
  return { ...input, overall };
}
