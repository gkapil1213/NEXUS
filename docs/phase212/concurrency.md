# Phase 212 - Concurrency

## Durable ownership

Recovery is serialized through release_deployment_intents.lease:

- acquireLeaseAsync(intentKey, workerId, ttl) is atomic via DB UPDATE WHERE
  current lease is null or expired
- Only the lease holder may advance the intent via transitionIfOwnedAsync
- Lease TTL is worker-controlled; expiry permits re-acquisition by another worker
- Stale worker (whose lease expired) is rejected on every fenced transition

## Verified scenarios

| ID | What it proves |
|---|---|
| 212I | Two concurrent acquireLeaseAsync calls: exactly one wins |
| 212J | Second acquisition while first is active: rejected with holder identity |
| 212K | Lease re-acquisition after TTL expiry: succeeds |
| 212L | Non-lease-holder transition rejected; lease-holder transition succeeds |
| 212T | ROLLING_BACK intent persists across service restart; classifier says RESUME_ROLLBACK |
| 212U | Duplicate ROLLING_BACK request: no duplicate rollback attempt |

## No in-memory coordination

No mutex, no global flag, no setTimeout coordination. All exclusivity comes
from the durable lease and the fenced transition CAS.
