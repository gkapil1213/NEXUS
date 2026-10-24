# Phase 281 — Audit Metadata Normalization Policy

`redactMetadata(value, depth)` is the single normalization boundary for
audit metadata. Callers pass structured input; the function returns a
JSON-safe, secret-redacted representation.

## Supported input categories

| Input | Output |
|---|---|
| string | redacted via `redactText` (SECRET_PATTERNS) |
| number (finite) | unchanged |
| number (NaN, +Infinity, -Infinity) | `"NaN"`, `"Infinity"`, `"-Infinity"` |
| boolean | unchanged |
| null | unchanged |
| bigint | decimal string (`"123"`) — Phase 280 |
| symbol | `"[symbol]"` |
| function | `"[function]"` |
| Date (valid) | `.toISOString()` |
| Date (invalid) | `"[Invalid Date]"` |
| Array | mapped recursively |
| Map | `{ "$map": [[redactedKey, redactedValue], ...] }`, insertion order |
| Set | `{ "$set": [redactedElement, ...] }`, insertion order |
| Plain object | `{ [redactedKey]: redactedValue, ... }`, sensitive keys dropped |
| Class instance | `{ "$class": "<Name>", ...ownFields }` |
| Unhandled primitive | returned as-is |

## Redaction guarantees

Every recursive call applies `SECRET_PATTERNS` and `isSensitiveKey` rules.
String Map keys pass through `redactText()`. Nested Map-in-object,
Set-in-array, and object-in-Map combinations all preserve the boundary.

## Collision policy

Map entries are encoded as an **array of pairs**, not as an object. Two
entries whose normalized keys serialize identically (for example, two
`Date` objects with the same time, or a numeric key `1` and string key
`"1"`) both appear in the `$map` array. No entry is lost to collision
because the representation is a list, not a map.

## Repeated-reference policy

Repeated acyclic references to the same object produce **distinct output
nodes** — no WeakSet memoization is applied. Two properties pointing at the
same input object become two separate output objects with the same shape.
This is a deliberate choice: preserving input identity would make the
output graph differ from JSON.stringify's serialization, complicating
consumer expectations. Verified by test 281-21.

## Getter policy (documented limitation)

Metadata objects are traversed with `Object.entries()`, which invokes
getters. Callers whose metadata objects contain getters with side effects
should convert them to plain data before passing to `redactMetadata`.

Rationale for not guarding: the sole production consumer
(`AuditService.record` in `src/core/audit.ts`) and all observed callers
pass plain literal objects. No caller in `src/` constructs audit metadata
with getters (verified via grep). Guarding would change existing behavior
for callers that legitimately rely on getters as pure accessors, without
closing a demonstrated vulnerability. If a caller is introduced that
passes untrusted metadata containing getters, this policy must be revised
and the traversal switched to `getOwnPropertyDescriptor`.

## Depth and cycles

`depth > 10` returns `"[truncated]"`. Cycles terminate at the depth limit
(narrow markers such as `"[truncated]"` are used; no whole-object
replacement is applied). No WeakSet cycle detection is used; the depth
limit is the boundary.

## Caller immutability

The function never mutates caller-owned objects, arrays, Maps, or Sets.
A new object graph is constructed on every call. Verified by test 281-19.

## Compatibility

Single consumer: `AuditService.record()` in `src/core/audit.ts`. Output is
stored as `AuditRecord.metadata: Record<string, unknown>` and later
`JSON.stringify`'d by HTTP responses, Postgres parameter binding, and
diagnostic logs. This contract guarantees those serializations succeed.

## Known limitations

- Promise, WeakMap, WeakSet: `$class` marker added; contents not inspected
  (no own enumerable properties on these types).
- Proxy: behavior follows the target's own enumerable properties.
- Error subclasses: `message`/`stack` are non-enumerable in V8, so absent
  unless own enumerable props are set.
- Depth limit of 10 may produce `"[truncated]"` for legitimate deeply-
  nested data. The boundary is intentional.
- Getters are invoked (see Getter policy above).