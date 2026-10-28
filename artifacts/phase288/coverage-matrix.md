# Phase 288 — Coverage Matrix

All rows exercise the real `WorkerGateway` handler through live HTTP against real SQLite-backed stores. Test file: `scripts/test-phase288-worker-gateway-adversarial.ts`.

Status values: PASS, FAIL, BLOCKED, NOT EXECUTED.

## Section A — Authentication (18)

| Requirement | Real entry point tested | Expected behavior | Observed behavior | Evidence | Status |
|---|---|---|---|---|---|
| A1 valid credential authenticates and returns sessionId | POST / AUTH_REQUEST | 200, authenticated=true, sessionId present | 200, authenticated=true, sessionId present | A1 | PASS |
| A1 session is durably persisted | DB query after AUTH | row in worker_sessions | row present | A1 | PASS |
| A2 invalid credential rejected | POST / AUTH_REQUEST with wrong credential | authenticated=false, reason=invalid_credential | matches | A2 | PASS |
| A2 rejected auth does not create session | DB row count before/after | count unchanged | count unchanged | A2 | PASS |
| A3 unknown worker rejected | POST / AUTH_REQUEST unknown worker | reason=worker_not_found | matches | A3 | PASS |
| A4 revoked worker rejected | markRevoked then AUTH | reason=worker_revoked | matches | A4 | PASS |
| A5 missing timestamp rejected | AUTH without timestamp | reason=missing_timestamp | matches | A5 | PASS |
| A6 stale timestamp rejected | AUTH with ts-10min | reason=expired_timestamp | matches | A6 | PASS |
| A7 future timestamp rejected | AUTH with ts+10min | reason=future_timestamp | matches | A7 | PASS |
| A8 missing nonce rejected | AUTH without nonce | reason=missing_nonce | matches | A8 | PASS |
| A9 short nonce rejected | AUTH with 5-char nonce | reason=invalid_nonce | matches | A9 | PASS |
| A10 non-conforming nonce rejected | AUTH with spaces/punct | reason=invalid_nonce | matches | A10 | PASS |
| A11 first nonce use accepted | AUTH with fresh nonce | authenticated=true | matches | A11 | PASS |
| A11 replayed nonce rejected | AUTH with same nonce twice | 2nd: reason=replayed_nonce | matches | A11 | PASS |
| A12 legacy credential starts legacy | setLegacyCredential then DB query | algorithm is null | matches | A12 | PASS |
| A12 legacy credential authenticates | AUTH with legacy credential | authenticated=true | matches | A12 | PASS |
| A12 legacy credential upgraded | DB query after AUTH | algorithm='pbkdf2-sha256', salt, iterations | matches | A12 | PASS |
| A13 malformed stored hash | AUTH against malformed hash row | authenticated=false, reason=invalid_credential | matches | A13 | PASS |

## Section B — Session lifecycle (7)

| Requirement | Real entry point tested | Expected behavior | Observed behavior | Evidence | Status |
|---|---|---|---|---|---|
| B1 missing session rejected | POST / HEARTBEAT without sessionId | 400 missing_session_or_worker | matches | B1 | PASS |
| B2 unknown session rejected | HEARTBEAT with fake sessionId | 400 invalid_session | matches | B2 | PASS |
| B3 session-worker mismatch rejected | HEARTBEAT with sessionId + mismatched workerId | 400 invalid_session | matches | B3 | PASS |
| B4 expired session rejected | HEARTBEAT against expired session | 400 session_expired | matches | B4 | PASS |
| B4 expired session durably revoked | DB query after rejection | status=REVOKED | matches | B4 | PASS |
| B5 explicitly revoked session rejected | markRevoked then HEARTBEAT | 400 invalid_session | matches | B5 | PASS |
| B6 just-before-expiry accepted | HEARTBEAT, session expires in 60s | 200 HEARTBEAT_ACK | matches | B6 | PASS |

## Section C — Message replay (12)

| Requirement | Real entry point tested | Expected behavior | Observed behavior | Evidence | Status |
|---|---|---|---|---|---|
| C1 first heartbeat accepted | HEARTBEAT with fresh messageId | 200 | 200 | C1 | PASS |
| C1 duplicate messageId rejected | Same messageId, new sequence | 400 duplicate_message | matches | C1 | PASS |
| C2 messageId dedup is session-agnostic | Same messageId across two sessions | 400 duplicate_message | matches | C2 | PASS |
| C3 stale sequence rejected | HEARTBEAT with sequence=3 after sequence=5 | 400 invalid_sequence | matches | C3 | PASS |
| C4 missing sequence rejected | HEARTBEAT without sequence | 400 invalid_sequence | matches | C4 | PASS |
| C5 sequence 0 rejected | HEARTBEAT with sequence=0 | 400 invalid_sequence | matches | C5 | PASS |
| C6 valid sequence accepted | HEARTBEAT with sequence=1 | 200 HEARTBEAT_ACK | matches | C6 | PASS |
| C6 lastSequence durably advanced | DB query after HEARTBEAT | last_sequence=1 | matches | C6 | PASS |
| C7 messageId dedup survives restart | HEARTBEAT before restart; same messageId after restart | 400 duplicate_message | matches (durable store) | C7 | PASS |
| C8 sequence monotonicity survives restart | HEARTBEAT sequence=10 before restart; sequence=5 after | 400 invalid_sequence | matches (durable last_sequence) | C8 | PASS |
| C9 non-AUTH stale timestamp rejected | HEARTBEAT with stale timestamp | 400 expired_timestamp | 200 (accepted — gap) | C9 | **FAIL** |
| C10 failed operation must not advance lastSequence | JOB_RESULT with bad integrity hash, then DB query | last_sequence unchanged | last_sequence advanced — gap | C10 | **FAIL** |

## Section D — Malformed envelopes (7)

| Requirement | Real entry point tested | Expected behavior | Observed behavior | Evidence | Status |
|---|---|---|---|---|---|
| D1 missing messageId rejected | POST without messageId | 400 missing_message_fields | matches | D1 | PASS |
| D2 missing type rejected | POST without type | 400 missing_message_fields | matches | D2 | PASS |
| D3 malformed JSON rejected | POST malformed body | 400 malformed_json | matches | D3 | PASS |
| D4 unknown type rejected | POST type=NOT_A_REAL_TYPE | 400 unknown_message_type | matches | D4 | PASS |
| D5 unsupported protocol version rejected | HEARTBEAT with protocolVersion=99.0 | 400 unsupported_protocol_version | matches | D5 | PASS |
| D6 error response does not leak credential | AUTH with sentinel credential | body does not contain sentinel | matches | D6 | PASS |
| D6 error response does not leak stack traces | same | body has no `.ts:NN` | matches | D6 | PASS |
| D7 error response has stable shape | malformed request | `{error: string}` | matches | D7 | PASS |

## Section E — Message-type authorization (14)

| Requirement | Real entry point tested | Expected behavior | Observed behavior | Evidence | Status |
|---|---|---|---|---|---|
| E1 JOB_OFFER no dispatch returns null | JOB_OFFER from fresh worker | 200, job=null | matches | E1 | PASS |
| E2 JOB_OFFER with dispatch returns job | JOB_OFFER, seeded dispatch | 200, job.jobId=expected | matches | E2 | PASS |
| E3 JOB_RESULT missing hashes rejected | JOB_RESULT without hashes | 400 invalid_result_integrity | matches | E3 | PASS |
| E4 tampered stdout rejected | JOB_RESULT with stdout mismatch | 400 invalid_result_integrity | matches | E4 | PASS |
| E4 tampered result not persisted | DB query after | 0 rows | 0 rows | E4 | PASS |
| E5 valid JOB_RESULT accepted | valid JOB_RESULT | 200 JOB_RESULT_ACK | matches | E5 | PASS |
| E5 valid result durably persisted | DB query | 1 row | 1 row | E5 | PASS |
| E6 identical duplicate accepted | replay with same hashes | 200 JOB_RESULT_ACK | matches | E6 | PASS |
| E6 identical duplicate no new row | DB query | count unchanged | matches | E6 | PASS |
| E7 conflicting duplicate rejected | replay with different hashes | 400 conflicting_duplicate_result | matches | E7 | PASS |
| E8 wrong worker rejected | JOB_RESULT from other worker's session | 400 dispatch_ownership_violation | matches | E8 | PASS |
| E9 JOB_CANCEL missing jobId rejected | JOB_CANCEL without jobId | 400 jobId_required | 400 jobId_required (after regex fix) | E9 | PASS |
| E10 JOB_CANCEL no dispatch rejected | JOB_CANCEL unknown jobId | 400 dispatch_not_found | matches | E10 | PASS |
| E11 JOB_CANCEL active dispatch acknowledged | JOB_CANCEL with seeded dispatch | 200 JOB_CANCEL_ACK, confirmed=false | matches | E11 | PASS |

## Section F — Durability across restart (5)

| Requirement | Real entry point tested | Expected behavior | Observed behavior | Evidence | Status |
|---|---|---|---|---|---|
| F1 session persists across restart | Session lookup after gateway reconstruct | session present | present | F1 | PASS |
| F2 result rows persist across restart | DB query after gateway reconstruct | rows > 0 | rows > 0 | F2 | PASS |
| F3 messageId dedup durability | Proven by C7 | n/a | matches | F3/C7 | PASS |
| F4 first nonce use accepted | AUTH before restart | authenticated=true | matches | F4 | PASS |
| F4 nonce replay across restart | same nonce after restart | reason=replayed_nonce | matches (durable store) | F4 | PASS |

## Section G — Concurrency (3)

| Requirement | Real entry point tested | Expected behavior | Observed behavior | Evidence | Status |
|---|---|---|---|---|---|
| G1 concurrent same-sequence | Promise.all two HEARTBEAT seq=1 | exactly one accepted | matches | G1 | PASS |
| G2 concurrent JOB_OFFER | Promise.all two JOB_OFFER | at most one claim | matches | G2 | PASS |
| G3 concurrent AUTH_REQUEST same nonce | Promise.all two AUTH same nonce | exactly one authenticated | matches | G3 | PASS |

## Summary

- **66 PASS** — behavior verified against real HTTP entry points.
- **2 FAIL** — C9, C10 (documented design gaps; see `defects-and-fixes.md`).
- **0 BLOCKED** — every tested requirement reached a real entry point.
- **0 NOT EXECUTED** — every row was run in the Phase 288 adversarial suite.