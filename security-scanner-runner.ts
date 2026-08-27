 {
    scanner: "supply-chain",
    category: "SUPPLY_CHAIN",
    command: "INTERNAL_SUPPLY_CHAIN",
    args: [],
    adapter: supplyChainAdapter,
    timeoutMs: 120000,
    strategy: "INTERNAL",
  },   // <-- this comma is crucial
  {
    scanner: "signature",
    category: "SIGNATURE",
    command: "INTERNAL_SIGNATURE",
    args: [],
    adapter: signatureAdapter,
    timeoutMs: 120000,
    strategy: "INTERNAL",
  },
        if (def.strategy === "INTERNAL") {
          if (def.command === "INTERNAL_DAST") {
            // ...
          } else if (def.command === "INTERNAL_SUPPLY_CHAIN") {
            // ...
          } else if (def.command === "INTERNAL_SIGNATURE") {
            const res = await runInternalSignatureCheck(artifactDigest);
            stdout = res.stdout;
            stderr = res.stderr;
            exitCode = res.exitCode;
          }
        } else {
          // local executable path
        }