# Phase 217 - Real-provider end-to-end

Closes the loop Phase 216 left BLOCKED. Phase 216 verified gateway,
normalization, retry, redaction and failure semantics against a test double.
Phase 217 verifies the same path against a live provider and adds the env-var
contract that decides whether a real provider is present.