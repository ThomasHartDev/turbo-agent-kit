import { describe, expect, it } from "vitest";
import { SlidingWindowLog } from "./sliding-window";

function manualClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("SlidingWindowLog", () => {
  it("admits up to the limit then denies", () => {
    const clock = manualClock();
    const win = new SlidingWindowLog({ limit: 3, windowMs: 1000, clock: clock.now });
    expect(win.tryAcquire().ok).toBe(true);
    expect(win.tryAcquire().ok).toBe(true);
    expect(win.tryAcquire().ok).toBe(true);
    expect(win.tryAcquire().ok).toBe(false);
    expect(win.count).toBe(3);
  });

  it("frees a slot exactly when the oldest hit leaves the window", () => {
    const clock = manualClock();
    const win = new SlidingWindowLog({ limit: 2, windowMs: 1000, clock: clock.now });
    win.tryAcquire(); // t=0
    clock.advance(400);
    win.tryAcquire(); // t=400
    const denied = win.tryAcquire();
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBe(600); // first hit frees at t=1000

    clock.advance(599);
    expect(win.tryAcquire().ok).toBe(false);
    clock.advance(1);
    expect(win.tryAcquire().ok).toBe(true);
  });

  it("does not permit 2x limit across a fixed-window boundary", () => {
    const clock = manualClock();
    const win = new SlidingWindowLog({ limit: 5, windowMs: 1000, clock: clock.now });
    clock.advance(900);
    for (let i = 0; i < 5; i++) expect(win.tryAcquire().ok).toBe(true);
    clock.advance(200); // now t=1100, a naive per-second counter would reset here
    expect(win.tryAcquire().ok).toBe(false);
  });

  it("admits a multi-unit cost atomically and reports retry for the whole cost", () => {
    const clock = manualClock();
    const win = new SlidingWindowLog({ limit: 5, windowMs: 1000, clock: clock.now });
    expect(win.tryAcquire(3).ok).toBe(true);
    const r = win.tryAcquire(3); // only 2 slots left
    expect(r.ok).toBe(false);
    expect(win.count).toBe(3); // rejected cost left no residue
    expect(r.retryAfterMs).toBe(1000);
  });

  it("rejects invalid construction and costs", () => {
    expect(() => new SlidingWindowLog({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new SlidingWindowLog({ limit: 2, windowMs: 0 })).toThrow(RangeError);
    const win = new SlidingWindowLog({ limit: 2, windowMs: 1000 });
    expect(() => win.tryAcquire(3)).toThrow(RangeError);
    expect(() => win.tryAcquire(0)).toThrow(RangeError);
  });
});
