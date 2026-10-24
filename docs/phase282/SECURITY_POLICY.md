# Phase 282 — Audit Metadata Security Hardening Policy

Phase 282 closes two confirmed defects from the Phase 281 review:

- **A. Sensitive Map keys bypassed `isSensitiveKey`.** String Map keys were
  redacted against secret patterns only. Values under keys like `api_key`,
  `password`, `session_token` survived if the value did not match a regex.
- **B. `Object.entries()` invoked getters during normalization.** A
  throwing getter crashed the audit write; a side-effecting getter executed
  during normalization.

## Sensitive Map entry policy (Q1: A — drop)

String Map keys are subject to the same `isSensitiveKey()` policy as
ordinary object keys. Sensitive entries are **dropped from output
entirely**, matching the object-branch behavior:

    new Map([["api_key", "abc"], ["safe", "visible"]])
    -> { "$map": [["safe", "visible"]] }

Rationale: the audit ledger does not need to know that a caller attempted
to record a secret. Consistency with object keys avoids two different
policies on two different data shapes.

## Getter and accessor policy (Q2: A — marker)

Object traversal uses `Object.getOwnPropertyDescriptor` and **never
invokes** getters or setters. Non-sensitive accessor properties are
represented with the marker `"[getter]"`:

    { get boom() { throw new Error("x") } }
    -> { boom: "[getter]" }

Sensitive accessor keys (`password`, `token`, ...) are dropped entirely,
consistent with the general sensitive-key policy.

Non-enumerable own properties are omitted, matching the visibility of
`Object.entries()`. `toJSON()` is never invoked — functions reachable as
own properties become `"[function]"`.

## Divergence from `secret-redaction.ts` (Q3: C — documented)

The shared redactor at `src/core/secret-redaction.ts` (line 117) also uses
`Object.entries()` and therefore also invokes getters. Phase 282 does not
modify `secret-redaction.ts`; the divergence is documented here and
proposed for consolidation in Phase 283.

| Path | Getter policy | Sensitive-key drop |
|---|---|---|
| `audit.ts` (`redactMetadata`) | `"[getter]"` marker, never invoked | Yes (object and Map) |
| `secret-redaction.ts` (`redactSecrets`) | Invokes getters | Yes (object only) |

## Supported input categories

| Input | Output |
|---|---|
| string | `redactText(value)` |
| number finite | unchanged |
| number NaN, +/-Infinity | `"NaN"`, `"Infinity"`, `"-Infinity"` |
| boolean | unchanged |
| null | unchanged |
| bigint | decimal string (`"42"`) |
| symbol | `"[symbol]"` |
| function | `"[function]"` |
| Date valid | `toISOString()` |
| Date invalid | `"[Invalid Date]"` |
| Array | mapped recursively |
| Map | `{ "$map": [[redactedKey, redactedValue], ...] }`, insertion order, sensitive entries dropped |
| Set | `{ "$set": [redactedElement, ...] }`, insertion order |
| Plain object | `{ [redactedKey]: redactedValue, ... }`, sensitive keys dropped, accessors marked |
| Class instance | `{ "$class": "<Name>", ...ownFields }` |
| Accessor (non-sensitive) | `"[getter]"` |
| Unhandled primitive | returned as-is |

## Cycle and depth behavior

`depth > 10` returns `"[truncated]"`. Cycles terminate at the depth limit.
No WeakSet cycle detection is used. Repeated acyclic references produce
**distinct output nodes** — no memoization. Both are deliberate choices
preserved from Phase 281.

## Collection ordering and collisions

Insertion order is preserved. Map entries are encoded as an array of
pairs, so entries whose normalized keys serialize identically are both
retained (no collision-based data loss).

## JSON serialization contract

Every supported output serializes with `JSON.stringify` without throwing.
The redaction boundary guarantees downstream consumers — `res.json()`,
Postgres parameter binding, diagnostic log formatters — cannot crash on
audit metadata.

## Caller immutability

`redactMetadata` never mutates caller-owned objects, arrays, Maps, or Sets.
A fresh object graph is constructed on every call.

## Known limitations

- Promise, WeakMap, WeakSet: treated as class instances; `$class` marker
  only, contents not inspected.
- Proxy: behavior follows the target's own enumerable properties.
- Error subclasses: `message`/`stack` are non-enumerable in V8 and are
  therefore omitted unless assigned as own enumerable properties.
- Depth limit of 10 may produce `"[truncated]"` for legitimate deeply-
  nested data.
- Accessor properties are never read; a caller relying on getter values
  in metadata must convert them to plain data before recording.
- `secret-redaction.ts` retains getter-invocation behavior; consolidation
  deferred to Phase 283.