import { WorkerResourceCostIntelligence } from "./worker-resource-cost-intelligence";
import { WorkerResourceCostForecast } from "./worker-resource-cost-forecast";
import { WorkerCostReliabilityModel } from "./worker-cost-reliability-model";
import { WorkerResourceRightSizing } from "./worker-resource-right-sizing";
import { WorkerCostOptimizationRisk } from "./worker-cost-optimization-risk";
import { WorkerResourceGovernance } from "./worker-resource-governance";
import { WorkerCostOptimizationSafetyGate } from "./worker-cost-optimization-safety-gate";
import { WorkerResourceOptimizationStrategy } from "./worker-resource-optimization-strategy";

export class WorkerResourceGovernanceOrchestrator {
  evaluate(input: any) {
    const costIntel = new WorkerResourceCostIntelligence();
    const costInfo = costIntel.normalize({ resourceId: input.resourceId, cost: input.cost, source: input.costSource, confidence: input.costConfidence, windowStart: Date.now(), windowEnd: Date.now() });
    const forecast = new WorkerResourceCostForecast().evaluate(input.costHistory, input.costConfidence);
    const tradeoff = new WorkerCostReliabilityModel().evaluate(input.costDelta, input.reliabilityDelta, input.reliabilityKnown, input.costKnown);
    const rightSizing = new WorkerResourceRightSizing().evaluate(input.utilization, input.volatility, input.telemetryFresh);
    const risk = new WorkerCostOptimizationRisk().evaluate(input.reliability, input.headroom, input.volatility, input.rollbackAvailable, input.confidence);
    const governance = new WorkerResourceGovernance({ maxCost: input.maxCost, minReliability: input.minReliability, minHeadroom: input.minHeadroom, rollbackRequired: true, minConfidence: 0.5 });
    const governanceDecision = governance.evaluate(input.cost, input.reliability, input.headroom, input.rollbackAvailable, input.confidence);
    const safety = new WorkerCostOptimizationSafetyGate();
    const safetyDecision = safety.evaluate({ reliability: input.reliability, headroom: input.headroom, rollbackAvailable: input.rollbackAvailable, confidence: input.confidence, activeIncidents: input.activeIncidents, sloState: input.sloState, governanceAllowed: governanceDecision === "ALLOW" });
    const strategy = new WorkerResourceOptimizationStrategy().select(tradeoff, risk, input.reliability, input.headroom);
    return { costInfo, forecast, tradeoff, rightSizing, risk, governanceDecision, safetyDecision, strategy };
  }
}
