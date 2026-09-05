export interface RolloutWave {
  waveId: string;
  fleetId: string;
  sequence: number;
  name: string;
  environment: string;
  healthGate: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'HALTED';
  createdAt: string;
  idempotencyKey: string;
}

export function createRolloutWave(fleetId: string, sequence: number, name: string, environment: string, healthGate: string): RolloutWave {
  return {
    waveId: `wave-${fleetId}-${sequence}`,
    fleetId,
    sequence,
    name,
    environment,
    healthGate,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    idempotencyKey: `${fleetId}:${sequence}`,
  };
}
