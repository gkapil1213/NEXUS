export type RecoveryRegressionState = "NO_REGRESSION" | "MINOR_REGRESSION" | "MAJOR_REGRESSION" | "RECOVERY_FAILURE" | "RECOVERY_LOOP";

export class WorkerRecoveryRegression {
  detect(previousSuccessRate: number, currentSuccessRate: number, recoveryLoopDetected: boolean): RecoveryRegressionState {
    if (recoveryLoopDetected) return "RECOVERY_LOOP";
    const drop = previousSuccessRate - currentSuccessRate;
    if (!Number.isFinite(drop)) return "NO_REGRESSION";
    if (drop > 0.4) return "MAJOR_REGRESSION";
    if (drop > 0.2) return "MINOR_REGRESSION";
    return "NO_REGRESSION";
  }
}
