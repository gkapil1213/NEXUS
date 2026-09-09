import { LocalProcessExecutionAdapter } from "../src/core/local-process-execution-adapter";

async function main() {
    let passCount = 0;
    let failCount = 0;
    function assert(condition: boolean, message: string) {
        if (condition) {
            passCount++;
            console.log(`PASS: ${message}`);
        } else {
            failCount++;
            console.error(`FAIL: ${message}`);
        }
    }

    console.log("Starting execution runtime integration harness (component-level)...");

    // Test LocalProcessExecutionAdapter
    const adapter = new LocalProcessExecutionAdapter();
    const result = await adapter.execute({ operation: "node", args: ["-e", "console.log('integration-test')"] });
    assert(result.success === true, "Local adapter execution success");
    assert(result.exitCode === 0, "Local adapter exit code 0");
    assert(result.stdout.includes("integration-test"), "Local adapter output correct");
    assert(typeof result.evidence === "object", "Local adapter provides evidence");

    // Test adapter validation
    const validation = adapter.validate({ operation: "node", args: [] });
    assert(validation.valid === true, "Adapter validation passes for valid request");

    // Test health check
    const health = await adapter.healthCheck();
    assert(health === true, "Adapter health check passes");

    console.log(`\nHarness complete: ${passCount} PASS, ${failCount} FAIL`);
    if (failCount > 0) process.exit(1);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
