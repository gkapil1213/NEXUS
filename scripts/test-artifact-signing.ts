import { artifactSigningService } from "../src/core/artifact-signing.ts";

(async () => {
  // Use the full local registry path with digest
  const digestRef = "localhost:5000/nexus/nexus-app@sha256:bb3ff7e02d5ef630578010c3ff33c7f2020182243f50a4f672fa8c48c5972bbd";

  console.log(`Signing ${digestRef}...`);
  const signResult = await artifactSigningService.sign(digestRef);
  console.log("Sign result:", signResult);
  if (signResult.status !== "SIGNED") {
    console.error("Signing failed:", signResult.reason);
    process.exit(1);
  }

  console.log(`\nVerifying ${digestRef}...`);
  const verifyResult = await artifactSigningService.verify(digestRef);
  console.log("Verify result:", verifyResult);
  if (verifyResult.status !== "VERIFIED") {
    console.error("Verification failed:", verifyResult.reason);
    process.exit(1);
  }

  console.log("\nArtifact signing test passed!");
  process.exit(0);
})();