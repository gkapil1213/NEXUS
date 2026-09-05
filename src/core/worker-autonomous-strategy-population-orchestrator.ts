import { createStrategyPopulation, StrategyPopulation, updatePopulationVersion } from './worker-strategy-population';
import { createPopulationCandidate } from './worker-strategy-population-candidate';
import { evaluateDominance } from './worker-strategy-dominance';
import { computeParetoFrontier } from './worker-strategy-population-pareto';
import { evaluateDiversity } from './worker-strategy-diversity';
import { classifyRedundancy } from './worker-strategy-redundancy';
import { evaluateChampionChallenger } from './worker-strategy-champion-challenger';
import { evaluatePopulationHealth } from './worker-strategy-population-health';
import { calculateEvolutionPressure } from './worker-strategy-evolution-pressure';
import { decideExplorationGovernance } from './worker-strategy-exploration-governance';
import { selectGeneration } from './worker-strategy-generation-selection';
import { governPopulationAction } from './worker-strategy-population-governance';
import { evaluatePopulationSafety } from './worker-strategy-population-safety';
import { evaluatePopulationRollout } from './worker-strategy-population-rollout';
import { evaluatePopulationRollback } from './worker-strategy-population-rollback';
import { detectStagnation } from './worker-strategy-population-stagnation';
import { initiateRecovery } from './worker-strategy-population-recovery';
import { createPopulationAuditEvent } from './worker-strategy-population-audit';

export interface PopulationOrchestrationInput {
  tenantId: string;
  correlationId: string;
  population: StrategyPopulation;
  candidates: Parameters<typeof createPopulationCandidate>[0][];
  dominanceDimensions: string[];
  paretoMembers: Parameters<typeof computeParetoFrontier>[0];
  diversityInput: Parameters<typeof evaluateDiversity>[0];
  healthInput: Parameters<typeof evaluatePopulationHealth>[0];
  pressureInput: Parameters<typeof calculateEvolutionPressure>[0];
  explorationInput: Parameters<typeof decideExplorationGovernance>[0];
  generationSelectionInput: Parameters<typeof selectGeneration>[0];
  stagnationInput: Parameters<typeof detectStagnation>[0];
  rolloutInput: Parameters<typeof evaluatePopulationRollout>[0];
  rollbackInput: Parameters<typeof evaluatePopulationRollback>[0];
  governanceInput: Parameters<typeof governPopulationAction>[0];
  safetyInput: Parameters<typeof evaluatePopulationSafety>[0];
  championChallengerInput: Parameters<typeof evaluateChampionChallenger>[0];
}

export function orchestratePopulation(input: PopulationOrchestrationInput) {
  const auditEvents = [];
  const population = updatePopulationVersion(input.population, input.population.populationVersion + 1);

  // 1. Evaluate diversity
  const diversity = evaluateDiversity(input.diversityInput);

  // 2. Population health
  const health = evaluatePopulationHealth(input.healthInput);

  // 3. Evolution pressure
  const pressure = calculateEvolutionPressure(input.pressureInput);

  // 4. Exploration decision
  const explorationDecision = decideExplorationGovernance(input.explorationInput);

  // 5. Dominance/Pareto
  const paretoFrontier = computeParetoFrontier(input.paretoMembers, input.dominanceDimensions);

  // 6. Stagnation
  const stagnation = detectStagnation(input.stagnationInput);

  // 7. Recovery if needed
  const recovery = initiateRecovery({
    populationHealth: health,
    unsafeRolloutActive: false,
    stableStrategyAvailable: true,
    governanceRequired: false,
  });

  // 8. Rollout
  const rollout = evaluatePopulationRollout(input.rolloutInput);

  // 9. Rollback
  const rollback = evaluatePopulationRollback(input.rollbackInput);

  // 10. Champion/challenger
  const championDecision = evaluateChampionChallenger(input.championChallengerInput);

  // 11. Governance
  const governance = governPopulationAction(input.governanceInput);

  // 12. Safety
  const safety = evaluatePopulationSafety(input.safetyInput);

  // 13. Emit audit events
  auditEvents.push(createPopulationAuditEvent({
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    populationId: population.populationId,
    populationVersion: population.populationVersion,
    eventType: 'POPULATION_EVALUATED',
    reason: `Health: ${health}`,
    decision: health,
  }));
  auditEvents.push(createPopulationAuditEvent({
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    populationId: population.populationId,
    populationVersion: population.populationVersion,
    eventType: 'POPULATION_DECISION',
    reason: `Governance: ${governance.allowed}, Safety: ${safety}`,
    decision: governance.allowed && safety === 'ALLOW' ? 'APPROVED' : 'BLOCKED',
  }));
  auditEvents.push(createPopulationAuditEvent({
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    populationId: population.populationId,
    populationVersion: population.populationVersion,
    eventType: 'POPULATION_ROLLOUT',
    reason: `Stage: ${rollout.nextStage}`,
    decision: rollout.action,
  }));

  return {
    population,
    diversity,
    health,
    pressure,
    explorationDecision,
    paretoFrontier,
    stagnation,
    recovery,
    rollout,
    rollback,
    championDecision,
    governance,
    safety,
    auditEvents,
  };
}
