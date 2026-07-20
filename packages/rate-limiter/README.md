# @agent/rate-limiter

Rate limiting for the agent loop: cap how fast and how many calls go out to a model provider so a runaway agent or a burst of traffic does not blow a per-minute quota or a spend limit. Three primitives, all with an injectable clock so the behavior is deterministic in tests.

## Primitives

- **`TokenBucket`** smooths bursty traffic. It holds up to `capacity` tokens and refills continuously at `refillPerSecond`. An acquire spends `cost` tokens if enough have accrued, otherwise it reports how long until they will. Capacity is the burst ceiling, the refill rate is the steady-state throughput.
- **`SlidingWindowLog`** enforces "at most N in any `windowMs`". It keeps a timestamp per admitted unit and prunes expired ones on read, so it is exact at the window edge. A fixed-window counter lets up to 2x the limit through when a burst straddles a boundary. This does not.
- **`Semaphore`** caps in-flight concurrency. `run(fn)` acquires a permit, runs the task, and releases on success or throw. Permits hand off directly to the next FIFO waiter, so a released permit is never briefly visible as free.

Token bucket and sliding window share a `RateLimiter` interface (`tryAcquire(cost?)` returning `{ ok, remaining, retryAfterMs }`), so a caller can swap one for the other. The semaphore is a different axis: rate over time versus simultaneous work.

## Usage

```ts
import { TokenBucket, SlidingWindowLog, Semaphore } from "@agent/rate-limiter";

const bucket = new TokenBucket({ capacity: 20, refillPerSecond: 5 });
const r = bucket.tryAcquire();
if (!r.ok) await sleep(r.retryAfterMs);

const window = new SlidingWindowLog({ limit: 100, windowMs: 60_000 });
window.tryAcquire(); // at most 100 in any rolling minute

const sem = new Semaphore(4); // at most 4 model calls in flight
const answer = await sem.run(() => llm.complete(prompt));
```

The clock is injectable for deterministic tests:

```ts
let now = 0;
const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1, clock: () => now });
now += 1000; // one token has refilled
```

## Design notes

- A clock that jumps backward is ignored rather than draining the bucket or freezing its refill anchor in the future.
- `retryAfterMs` is exact: for the bucket it is the time to accrue the deficit, for the window it is when enough of the oldest hits age out to fit the request.
- A multi-unit cost is atomic: if it does not fit, nothing is consumed.
- The semaphore throws on over-release, which catches a missing `acquire`/`release` pairing early instead of silently inflating the permit count.

## Tests

```
pnpm --filter @agent/rate-limiter test
```
