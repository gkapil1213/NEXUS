import { WorkerFleetStore } from "./worker-fleet";

export interface CapacityPlan {
  cpu: number;
  memory: number;
  disk: number;
  concurrency: number;
}

export class WorkerCapacityPlanner {
  constructor(private fleet: WorkerFleetStore) {}

  calculateDeficit(required: CapacityPlan, available: CapacityPlan): CapacityPlan {
    return {
      cpu: Math.max(0, required.cpu - available.cpu),
      memory: Math.max(0, required.memory - available.memory),
      disk: Math.max(0, required.disk - available.disk),
      concurrency: Math.max(0, required.concurrency - available.concurrency),
    };
  }

  getAvailableCapacity(): CapacityPlan {
    const workers = this.fleet.listWorkers().filter((w) => !w.draining && !w.maintenance);
    const available = { cpu: 0, memory: 0, disk: 0, concurrency: 0 };
    for (const worker of workers) {
      if (worker.cpuCapacity) available.cpu += worker.cpuCapacity;
      if (worker.memoryCapacity) available.memory += worker.memoryCapacity;
      if (worker.diskCapacity) available.disk += worker.diskCapacity;
      if (worker.concurrencyLimit) available.concurrency += worker.concurrencyLimit;
    }
    return available;
  }
}
