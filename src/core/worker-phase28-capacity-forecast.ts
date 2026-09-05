export interface CapacityForecast {
  forecastId: string;
  resourceId: string;
  currentLoad: number;
  growthTrend: number;
  expectedDemand: number;
  confidence: number;
  horizonDays: number;
  expectedSaturationDays: number;
  recommendedMin: number;
  recommendedMax: number;
  createdAt: string;
}

export function forecastCapacity(input: { currentLoad: number; growthTrend: number; horizonDays: number; confidence: number }): CapacityForecast {
  const expectedDemand = input.currentLoad * (1 + input.growthTrend * input.horizonDays);
  const expectedSaturationDays = input.growthTrend > 0 ? Math.floor(1 / input.growthTrend) : Number.MAX_SAFE_INTEGER;
  return {
    forecastId: `forecast-${Date.now()}`,
    resourceId: 'unknown',
    currentLoad: input.currentLoad,
    growthTrend: input.growthTrend,
    expectedDemand,
    confidence: input.confidence,
    horizonDays: input.horizonDays,
    expectedSaturationDays,
    recommendedMin: Math.ceil(expectedDemand * 0.8),
    recommendedMax: Math.ceil(expectedDemand * 1.2),
    createdAt: new Date().toISOString(),
  };
}
