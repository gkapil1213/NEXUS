import { ProductionChangeRiskClass } from "./worker-production-change-risk";

export interface ReleaseWavePlan {
  waveNumber: number;
  components: string[];
  state: "PLANNED" | "ACTIVE" | "COMPLETED" | "BLOCKED";
}

export class WorkerReleaseWavePlanner {
  plan(riskClass: ProductionChangeRiskClass, components: string[]): ReleaseWavePlan[] {
    const waves: ReleaseWavePlan[] = [];
    if (riskClass === "CRITICAL" || riskClass === "INSUFFICIENT") return waves;
    const total = components.length;
    if (total === 0) return waves;

    const wave0 = components.filter((c, i) => i < Math.ceil(total * 0.1));
    const wave1 = components.filter((c, i) => i >= Math.ceil(total * 0.1) && i < Math.ceil(total * 0.25));
    const wave2 = components.filter((c, i) => i >= Math.ceil(total * 0.25) && i < Math.ceil(total * 0.5));
    const wave3 = components.filter((c, i) => i >= Math.ceil(total * 0.5) && i < Math.ceil(total * 0.75));
    const wave4 = components.filter((c, i) => i >= Math.ceil(total * 0.75));

    if (wave0.length) waves.push({ waveNumber: 0, components: wave0, state: "PLANNED" });
    if (wave1.length) waves.push({ waveNumber: 1, components: wave1, state: "PLANNED" });
    if (wave2.length) waves.push({ waveNumber: 2, components: wave2, state: "PLANNED" });
    if (wave3.length) waves.push({ waveNumber: 3, components: wave3, state: "PLANNED" });
    if (wave4.length) waves.push({ waveNumber: 4, components: wave4, state: "PLANNED" });
    return waves;
  }
}
