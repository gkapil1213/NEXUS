# Redaction Security Policy

## 1. Text secrets

The shared secret redactor owns the canonical text-secret pattern set.
Audit text redaction derives its matching coverage from that source while
preserving audit-specific marker labels.

The legacy wrapper in `src/core/redaction.ts` also applies compatibility
patterns after shared redaction. Do not remove or reorder those patterns
without reviewing their existing consumers and regression tests.

## 2. Metadata keys and values

Sensitive metadata keys must not expose their associated values. Audit
metadata normalization filters sensitive keys and redacts secret-like text
inside retained values. Safe metadata should be preserved where policy permits.

Map entries with sensitive string keys are dropped. Maps and Sets are
normalized into explicit serializable representations so entries are not
silently lost through ordinary JSON serialization.

## 3. Accessors and object traversal

Normalization must not execute object getters or `toJSON()` methods as a
side effect of inspecting metadata. Own property descriptors are used to
inspect fields. Non-sensitive accessors are represented by a marker where
applicable; sensitive accessor fields are omitted.

Non-enumerable fields are omitted according to the audit metadata contract.
Normalization should not mutate caller-owned input objects.

## 4. Serialization and unusual values

The audit metadata contract defines representations for values such as
BigInt, non-finite numbers, Dates, Maps, Sets, symbols, functions, and
unsupported class instances. Cyclic and deeply nested structures must
terminate under the documented depth policy and produce serializable output
where the contract specifies it.

The depth limit and unsupported-object representations are compatibility
behavior. Change them only with explicit policy review and regression tests.

## 5. Required regression checks

Before changing redaction behavior, run the relevant tests covering:

- canonical pattern and marker consistency;
- full credential removal and marker stability;
- negative controls against over-redaction;
- idempotence;
- legacy wrapper compatibility;
- sensitive metadata keys and nested collection values;
- getter safety, including Error fields and array accessors;
- deterministic normalization and JSON serialization.

## 6. Security boundary

Passing these tests is evidence for the tested behavior only. It is not proof
that every secret format or runtime call site is covered, and it is not a
production security certification. Report untested areas explicitly.
