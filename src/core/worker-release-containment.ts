export class WorkerReleaseContainment {
  evaluate(verificationState: string, affectedScope: "worker" | "domain" | "fleet"): "STOP" | "FREEZE_WORKER" | "FREEZE_DOMAIN" | "FREEZE_FLEET" | "NO_ACTION" {
    if (verificationState === "CRITICAL") {
      if (affectedScope === "fleet") return "FREEZE_FLEET";
      if (affectedScope === "domain") return "FREEZE_DOMAIN";
      return "FREEZE_WORKER";
    }
    if (verificationState === "REGRESSION") {
      return affectedScope === "worker" ? "FREEZE_WORKER" : "FREEZE_DOMAIN";
    }
    return "NO_ACTION";
  }
}
