export interface FleetPolicy {
  minWorkers: number;
  maxWorkers: number;
  maxScaleStep: number;
  cooldownMs: number;
  queueDepthScaleOut: number;
  utilizationScaleOut: number;
  utilizationScaleIn: number;
  maxRecoveryAttempts: number;
  rebalanceThreshold: number;
  optimizationEnabled: boolean;
}

export class WorkerPolicy {
  constructor(private policy: FleetPolicy) {}

  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (this.policy.minWorkers > this.policy.maxWorkers) {
      errors.push("minWorkers exceeds maxWorkers");
    }
    if (this.policy.maxScaleStep <= 0) {
      errors.push("maxScaleStep must be positive");
    }
    if (this.policy.cooldownMs < 0) {
      errors.push("cooldownMs cannot be negative");
    }
    if (this.policy.utilizationScaleIn > 1 || this.policy.utilizationScaleIn < 0) {
      errors.push("utilizationScaleIn must be between 0 and 1");
    }
    if (this.policy.utilizationScaleOut > 1 || this.policy.utilizationScaleOut < 0) {
      errors.push("utilizationScaleOut must be between 0 and 1");
    }
    return { valid: errors.length === 0, errors };
  }

  getPolicy(): FleetPolicy {
    return this.policy;
  }
}
