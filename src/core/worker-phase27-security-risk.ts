export interface SecurityRiskInput {
  severity: string;
  confidence: number;
  assetCriticality: string;
  exposure: number;
  blastRadius: number;
  knownExploited: boolean;
  exploitability: number;
  dataSensitivity: number;
}

export function assessSecurityRisk(input: SecurityRiskInput): { risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; confidence: number; explanation: string[] } {
  let score = 0;
  const explanation: string[] = [];
  if (input.severity === 'CRITICAL') { score += 3; explanation.push('critical severity'); }
  else if (input.severity === 'HIGH') { score += 2; explanation.push('high severity'); }
  score += input.exploitability * 2;
  score += input.exposure * 2;
  if (input.knownExploited) { score += 2; explanation.push('known exploitation'); }
  score += (1 - input.confidence) * 2;
  score += input.blastRadius;
  const risk = score >= 8 ? 'CRITICAL' : score >= 5 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW';
  return { risk, confidence: input.confidence, explanation: [...explanation, `score: ${score}`] };
}
