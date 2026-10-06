// src/core/drift-observation-supervisor.ts
// Phase 252: kernel-integrated durable drift observation loop.
//
// Periodically scans authoritative persisted deployments in the existing
// DeploymentHistoryService, runs the existing DockerDeploymentObserver
// against each, and drives the Phase 250/251 production chain
// (processDeploymentDriftDurable -> AsyncIncidentStore) when the observer
// reports anything other than VERIFIED integrity.
//
// This supervisor does NOT execute rollback, acquire recovery leases,
// increment recovery_attempt, or otherwise touch recovery authority.
// Recovery remains owned by ReleaseRecoveryExecutor and the
// release-recovery supervisor. This supervisor only produces drift
// observations and durable incidents.
//
// Mirrors the shape and lifecycle semantics of ReleaseRecoverySupervisor:
// opt-in start(), idempotent stop(), no-overlap guard, runNow() for
// synchronous one-shot execution, status() for observability.

import type { AsyncIncidentStore } from "./async-incident-store";
import type { DeploymentHistoryService } from "./deployment-history";
import type {
  DeploymentObservation,
  ExpectedDeploymentIdentity,
  DeploymentIntegrityResult,
} from "./post-deployment-integrity";
import { evaluateDeploymentIntegrity } from "./post-deployment-integrity";
import { processDeploymentDriftDurable } from "./production-incident-response";
import { handoffDriftIncidentToRecovery } from "./drift-recovery-handoff";
import type { ReleaseDeploymentIntentService } from "./release-deployment-intent";

export interface DriftObservationEventSink {
  emit(event: { type: string; source: string; payload?: unknown }): Promise<unknown>;
}

export interface DriftObservationObserver {
  observe(deploymentId: string): Promise<DeploymentObservation>;
}

export interface DriftObservationScope {
  projectId: string;
  environment: string;
}

export interface DriftObservationSupervisorDeps {
  incidentStore: AsyncIncidentStore;
  history: DeploymentHistoryService;
  observer: DriftObservationObserver;
  workerId: string;
  intervalMs: number;
  /**
   * Enumerate the (projectId, environment) scopes to inspect on each tick.
   * Owned by the caller (kernel) because scope enumeration is deployment-OS
   * concern, not an incident concern.
   */
  enumerateScopes: () => Promise<DriftObservationScope[]>;
  svc: { events: DriftObservationEventSink };
  /** Safety valve: cap scopes scanned per tick. Defaults to 100. */
  maxScopesPerTick?: number;
  /**
   * Phase 253: durable intent service for recovery handoff.
   * When provided, a DRIFTED classification is handed to the existing
   * ReleaseDeploymentIntentService via requestDriftRecoveryIntent.
   * When absent, ticks count recoveryHandoffsNotExecuted and no intent
   * is fabricated.
   */
  intentService?: ReleaseDeploymentIntentService;
}

export interface DriftObservationTickReport {
  tickAt: number;
  scopesScanned: number;
  deploymentsScanned: number;
  verified: number;
  drifted: number;
  unknown: number;
  blocked: number;
  notExecuted: number;
  incidentsCreated: number;
  incidentsReconciled: number;
  recoveryHandoffsAccepted: number;
  recoveryHandoffsRejected: number;
  recoveryHandoffsNotExecuted: number;
  errors: string[];
}

export interface DriftObservationSupervisorStatus {
  running: boolean;
  startedAt: number | null;
  lastTickAt: number | null;
  lastTickReport: DriftObservationTickReport | null;
  lastError: string | null;
  skippedTicks: number;
  totalTicks: number;
}

export class DriftObservationSupervisor {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;
  private startedAt: number | null = null;
  private lastTickAt: number | null = null;
  private lastTickReport: DriftObservationTickReport | null = null;
  private lastError: string | null = null;
  private skippedTicks = 0;
  private totalTicks = 0;

  constructor(private readonly deps: DriftObservationSupervisorDeps) {}

  /**
   * Start the periodic loop. Idempotent: repeated calls after the first are
   * no-ops. Does NOT run synchronously on start; the first tick fires on the
   * first interval. Callers that want an immediate pass should call runNow()
   * before or after start().
   */
  async start(): Promise<void> {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.timer = setInterval(() => { void this.tick(); }, this.deps.intervalMs);
  }

  /** Stop the periodic loop. Idempotent. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.startedAt = null;
  }

  /** Execute exactly one observation cycle, respecting the no-overlap guard. */
  async runNow(): Promise<DriftObservationTickReport> {
    return this.tick();
  }

  /** Supervisor lifecycle status. */
  status(): DriftObservationSupervisorStatus {
    return {
      running: this.timer !== undefined,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      lastTickReport: this.lastTickReport,
      lastError: this.lastError,
      skippedTicks: this.skippedTicks,
      totalTicks: this.totalTicks,
    };
  }

  private async tick(): Promise<DriftObservationTickReport> {
    if (this.inFlight) {
      this.skippedTicks++;
      return this.lastTickReport ?? this.emptyReport();
    }
    this.inFlight = true;
    try {
      const report = await this.runTick();
      this.lastTickAt = report.tickAt;
      this.lastTickReport = report;
      this.lastError = null;
      this.totalTicks++;
      return report;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      const report = this.emptyReport();
      report.errors.push(this.lastError);
      this.lastTickReport = report;
      this.lastTickAt = report.tickAt;
      return report;
    } finally {
      this.inFlight = false;
    }
  }

  private emptyReport(): DriftObservationTickReport {
    return {
      tickAt: Date.now(),
      scopesScanned: 0,
      deploymentsScanned: 0,
      verified: 0,
      drifted: 0,
      unknown: 0,
      blocked: 0,
      notExecuted: 0,
      incidentsCreated: 0,
      incidentsReconciled: 0,
      recoveryHandoffsAccepted: 0,
      recoveryHandoffsRejected: 0,
      recoveryHandoffsNotExecuted: 0,
      errors: [],
    };
  }

  private async runTick(): Promise<DriftObservationTickReport> {
    const report = this.emptyReport();
    const scopes = await this.deps.enumerateScopes();
    const cap = this.deps.maxScopesPerTick ?? 100;
    const limited = scopes.slice(0, cap);

    for (const scope of limited) {
      report.scopesScanned++;

      const current = await this.deps.history.getCurrentDeployment(scope.projectId, scope.environment);
      if (!current) continue;
      if (current.status !== "KNOWN_GOOD") continue;

      report.deploymentsScanned++;

      let observation: DeploymentObservation;
      try {
        observation = await this.deps.observer.observe(current.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        report.errors.push("observe(" + current.id + "): " + msg.slice(0, 200));
        continue;
      }

      const expected: ExpectedDeploymentIdentity = {
        deployment_id: current.id,
        release_id: current.release_id ?? "",
        artifact_id: current.artifact_id ?? "",
        artifact_digest: current.image_digest ?? "",
        environment: current.environment,
      };

      let integrity: DeploymentIntegrityResult;
      try {
        integrity = evaluateDeploymentIntegrity(expected, observation);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        report.errors.push("evaluate(" + current.id + "): " + msg.slice(0, 200));
        continue;
      }

      switch (integrity.state) {
        case "VERIFIED":
          report.verified++;
          continue;
        case "DRIFTED":
          report.drifted++;
          break;
        case "UNKNOWN":
          report.unknown++;
          break;
        case "BLOCKED":
          report.blocked++;
          break;
        case "NOT_EXECUTED":
          report.notExecuted++;
          break;
        default:
          report.unknown++;
          break;
      }

      try {
        const out = await processDeploymentDriftDurable({
          incidentStore: this.deps.incidentStore,
          integrity,
          expected,
          observation,
        });
        if (out) {
          if (out.durableCreated) report.incidentsCreated++;
          else report.incidentsReconciled++;
        }

        // Phase 253: hand off DRIFTED incidents to the existing recovery owner.
        // UNKNOWN / BLOCKED / NOT_EXECUTED do not hand off.
        if (out && integrity.state === "DRIFTED") {
          const recoveryExpected = {
            project_id: scope.projectId,
            environment: scope.environment,
            release_id: expected.release_id,
            artifact_id: expected.artifact_id,
            artifact_digest: expected.artifact_digest,
          };
          try {
            const handoff = await handoffDriftIncidentToRecovery({
              incidentStore: this.deps.incidentStore,
              history: this.deps.history,
              intentService: this.deps.intentService,
              incident: out.durable,
              deploymentId: current.id,
              expected: recoveryExpected,
              workerId: this.deps.workerId,
            });
            if (handoff.status === "ACCEPTED") report.recoveryHandoffsAccepted++;
            else if (handoff.status === "REJECTED") report.recoveryHandoffsRejected++;
            else report.recoveryHandoffsNotExecuted++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            report.errors.push("handoff(" + current.id + "): " + msg.slice(0, 200));
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        report.errors.push("persist(" + current.id + "): " + msg.slice(0, 200));
      }
    }

    await this.deps.svc.events
      .emit({
        type: "drift.observation.tick",
        source: "DriftObservationSupervisor",
        payload: {
          worker_id: this.deps.workerId,
          scopes_scanned: report.scopesScanned,
          deployments_scanned: report.deploymentsScanned,
          verified: report.verified,
          drifted: report.drifted,
          unknown: report.unknown,
          blocked: report.blocked,
          not_executed: report.notExecuted,
          incidents_created: report.incidentsCreated,
          incidents_reconciled: report.incidentsReconciled,
          recovery_handoffs_accepted: report.recoveryHandoffsAccepted,
          recovery_handoffs_rejected: report.recoveryHandoffsRejected,
          recovery_handoffs_not_executed: report.recoveryHandoffsNotExecuted,
          errors: report.errors.slice(0, 5),
        },
      })
      .catch(() => undefined);

    return report;
  }
}