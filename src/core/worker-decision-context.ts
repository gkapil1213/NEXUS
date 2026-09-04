export interface ProductionState {
  reliability: number;
  sloState: string;
  releaseState: string;
  capacityState: string;
  costState: string;
  recoveryState: string;
  activeIncidents: number;
  telemetryFresh: boolean;
  dependencyHealth: string;
}

export interface DecisionContext {
  contextId: string;
  service: string;
  environment: string;
  state: ProductionState;
  epoch: string;
  correlationId?: string;
  timestamp: number;
}

export class WorkerDecisionContext {
  create(input: { contextId: string; service: string; environment: string; state: ProductionState; epoch: string; correlationId?: string; timestamp: number }): DecisionContext {
    return input;
  }

  isStale(context: DecisionContext, currentEpoch: string): boolean {
    return context.epoch !== currentEpoch;
  }
}
