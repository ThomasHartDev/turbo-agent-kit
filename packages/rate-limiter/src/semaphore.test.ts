import { describe, expect, it } from "vitest";
import { Semaphore } from "./semaphore";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("Semaphore", () => {
  it("tracks permits with tryAcquire/release", () => {
    const sem = new Semaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.available).toBe(0);
    expect(sem.tryAcquire()).toBe(false);
    sem.release();
    expect(sem.available).toBe(1);
  });

  it("blocks acquire past the limit and wakes waiters FIFO", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    const order: number[] = [];
    const a = sem.acquire().then(() => order.push(1));
    const b = sem.acquire().then(() => order.push(2));
    expect(sem.pending).toBe(2);

    sem.release();
    await a;
    sem.release();
    await b;
    expect(order).toEqual([1, 2]);
  });

  it("never runs more than `permits` tasks concurrently", async () => {
    const limit = 3;
    const sem = new Semaphore(limit);
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 12 }, () => deferred());

    const tasks = gates.map((gate, i) =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await gate.promise;
        active--;
        return i;
      }),
    );

    // Let the scheduler admit the first wave, then release gates one at a time.
    await Promise.resolve();
    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
    }
    const results = await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(limit);
    expect(peak).toBe(limit);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("releases the permit even when the task throws", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(sem.available).toBe(1);
  });

  it("guards against over-release and invalid construction", () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
    const sem = new Semaphore(1);
    expect(() => sem.release()).toThrow(/more times than acquire/);
  });
});
