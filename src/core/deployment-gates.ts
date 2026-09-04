import { ArtifactRecord, ReleaseRecord } from "./execution-models";

export interface GateResult {
  gate: string;
  passed: boolean;
  reason?: string;
}

export class DeploymentGates {
  evaluate(release: ReleaseRecord, artifact?: ArtifactRecord, evidence: string[] = []): GateResult[] {
    const gates: GateResult[] = [];
    gates.push({ gate: "BUILD_PASS", passed: evidence.includes("build_passed") });
    gates.push({ gate: "TEST_PASS", passed: evidence.includes("tests_passed") });
    gates.push({ gate: "SECURITY_PASS", passed: evidence.includes("security_passed") });
    gates.push({ gate: "ARTIFACT_PRESENT", passed: !!artifact });
    if (artifact) {
      gates.push({ gate: "ARTIFACT_INTEGRITY_PASS", passed: !!artifact.checksum && artifact.checksum.length > 0 });
    } else {
      gates.push({ gate: "ARTIFACT_INTEGRITY_PASS", passed: false });
    }
    return gates;
  }

  allMandatoryPassed(gates: GateResult[], mandatory: string[]): boolean {
    return mandatory.every((g) => {
      const result = gates.find((gr) => gr.gate === g);
      return result?.passed ?? false;
    });
  }
}
