import { WorkerTrustStore } from "./worker-trust";
import { WorkerHealthStore } from "./worker-health";
import { WorkerCredentialService } from "./worker-credentials";
import { RemoteWorkerStore } from "./remote-worker-store";

export type SafetyGateResult = "ALLOW" | "DENY" | "DEFER" | "REQUIRE_REVIEW";

export class WorkerSafetyGate {
  constructor(
    private trust: WorkerTrustStore,
    private health: WorkerHealthStore,
    private credentials: WorkerCredentialService,
    private remoteWorkers: RemoteWorkerStore
  ) {}

  evaluate(workerId: string): SafetyGateResult {
    const remoteWorker = this.remoteWorkers.getWorker(workerId);
    if (!remoteWorker) return "DENY";

    const trustRecord = this.trust.getTrust(workerId);
    if (!trustRecord || trustRecord.trustState !== "TRUSTED") return "DENY";

    const healthSnap = this.health.getHealth(workerId);
    if (!healthSnap || healthSnap.healthState !== "HEALTHY") return "DENY";

    const latestCred = this.credentials.getLatestCredential(workerId);
    if (!latestCred || latestCred.status !== "ACTIVE") return "DENY";

    return "ALLOW";
  }
}
