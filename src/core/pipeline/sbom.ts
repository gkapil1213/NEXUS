/**
 * SBOM — real CycloneDX 1.5 generation from genuine pipeline data.
 *
 * Components come from the grounded detection profile (declared dependencies)
 * and the build artifacts (with their real SHA-256 digests). Pure computation,
 * always available — never BLOCKED, never invented.
 */

import { digestOf, newId } from "../store";
import type { ArtifactRecord, DetectionProfile, SbomResult } from "../types";

export async function generateSbom(
  org: string,
  runId: string,
  requestId: string,
  correlationId: string,
  profile: DetectionProfile,
  componentName: string,
  buildArtifacts: ArtifactRecord[],
): Promise<{ sbomJson: string; result: SbomResult; location: string }> {
  const components: Record<string, unknown>[] = [];
  const ecosystem = profile.runtime === "python" ? "pypi" : profile.runtime === "go" ? "golang" : "npm";

  for (const dep of profile.dependencies) {
    components.push({
      type: "library",
      "bom-ref": `pkg:${ecosystem}/${dep.name}@${dep.version}`,
      name: dep.name,
      version: dep.version,
      purl: `pkg:${ecosystem}/${dep.name}@${dep.version}`,
      scope: dep.dev ? "optional" : "required",
    });
  }
  for (const art of buildArtifacts) {
    components.push({
      type: "file",
      "bom-ref": art.digest,
      name: art.name,
      hashes: [{ alg: "SHA-256", content: art.digest.replace(/^sha256:/, "") }],
    });
  }

  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${newId("sbom")}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: "nexus", name: "nexus-sbom", version: "1.0.0" }],
      component: { type: "application", "bom-ref": componentName, name: componentName, version: "0.0.0" },
    },
    components,
  };
  const sbomJson = JSON.stringify(bom, null, 2);
  const digest = await digestOf(sbomJson);
  const location = "dist/sbom.cdx.json";
  return {
    sbomJson,
    result: { format: "CycloneDX", spec: "1.5", components: components.length, digest, location },
    location,
  };
}
