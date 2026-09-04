import { WorkerCapacityIntelligence } from "./worker-capacity-intelligence";
import { WorkerCapacityForecast } from "./worker-capacity-forecast";
import { WorkerCapacityGap } from "./worker-capacity-gap";
import { WorkerScalingStrategy } from "./worker-scaling-strategy";
import { WorkerScalingRisk } from "./worker-scaling-risk";
import { WorkerScalingSafetyGate } from "./worker-scaling-safety-gate";
import { WorkerScalingPlan } from "./worker-scaling-plan";
import { WorkerScalingExecutor } from "./worker-scaling-executor";
import { WorkerScalingOutcome } from "./worker-scaling-outcome";

export class WorkerCapacityOptimizer {
  constructor(
    private intelligence: WorkerCapacityIntelligence,
    private forecast: WorkerCapacityForecast,
    private gap: WorkerCapacityGap,
    private strategy: WorkerScalingStrategy,
    private risk: WorkerScalingRisk,
    private safetyGate: WorkerScalingSafetyGate,
    private planStore: WorkerScalingPlan,
    private executor: WorkerScalingExecutor,
    private outcome: WorkerScalingOutcome
  ) {}

  optimize(input: {
    targetId: string;
    currentCapacity: number;
    utilizedCapacity: number;
    requiredCapacity: number;
    history: number[];
    confidence: number;
    sloState: string;
    incidentState: string;
    rollbackAvailable: boolean;
    recoveryAvailable: boolean;
    affectedWorkers: number;
    dependencyCriticality: number;
  }): any {
    const capacityState = this.intelligence.evaluate(input.currentCapacity, input.utilizedCapacity, true);
    const forecast = this.forecast.evaluate(input.history, input.confidence);
    const gap = this.gap.calculate(input.currentCapacity, input.requiredCapacity, capacityState, forecast.forecastDemand);
    const risk = this.risk.evaluate(input.affectedWorkers, input.dependencyCriticality, input.incidentState === "ACTIVE" ? 1 : 0, input.sloState, input.rollbackAvailable, input.confidence);
    const strategy = this.strategy.decide(capacityState, forecast.trend, gap.gap, gap.risk, input.confidence);
    const safetyDecision = this.safetyGate.evaluate({
      confidence: input.confidence,
      maxScaleDelta: 0.3,
      affectedFleetPercent: 0.1,
      incidentState: input.incidentState,
      sloState: input.sloState,
      recoveryAvailable: input.recoveryAvailable,
      rollbackAvailable: input.rollbackAvailable,
      capacityBoundsOk: true,
      cooldownActive: false,
      repeatedAction: false,
      dependencyHealth: "HEALTHY",
      controlPlaneHealth: "HEALTHY",
    });
    return { capacityState, forecast, gap, risk, strategy, safetyDecision };
  }
}
