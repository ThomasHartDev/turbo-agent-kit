import { describe, expect, it } from "vitest";
import { Telemetry, percentileOf } from "./telemetry";

describe("percentileOf", () => {
  it("returns 0 for an empty sample set", () => {
    expect(percentileOf([], 50)).toBe(0);
    expect(percentileOf([], 99)).toBe(0);
  });

  it("returns the only sample for any percentile when n=1", () => {
    expect(percentileOf([42], 50)).toBe(42);
    expect(percentileOf([42], 99)).toBe(42);
    expect(percentileOf([42], 0)).toBe(42);
    expect(percentileOf([42], 100)).toBe(42);
  });

  it("uses nearest-rank on a sorted series", () => {

    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileOf(xs, 50)).toBe(50);
    expect(percentileOf(xs, 95)).toBe(95);
    expect(percentileOf(xs, 99)).toBe(99);
    expect(percentileOf(xs, 100)).toBe(100);
  });

  it("clamps p outside [0, 100]", () => {
    const xs = [10, 20, 30];
    expect(percentileOf(xs, -5)).toBe(10);
    expect(percentileOf(xs, 150)).toBe(30);
  });

  it("rounds fractional durations", () => {
    expect(percentileOf([1.4, 2.6], 50)).toBe(1);
    expect(percentileOf([1.4, 2.6], 100)).toBe(3);
  });
});

describe("Telemetry", () => {
  function seed(): Telemetry {
    const t = new Telemetry();

    for (const ms of [10, 20, 30, 40, 50]) {
      t.record({ type: "llm", channel: "chat", ms, detail: "final" });
    }
    t.record({ type: "tool", channel: "chat", ms: 5, detail: "checkAvailability" });
    t.record({ type: "tool", channel: "sms", ms: 15, detail: "bookAppointment" });
    return t;
  }

  it("summary aggregates p50/p95/p99 and count per type", () => {
    const t = seed();
    expect(t.summary("llm")).toEqual({ count: 5, p50: 30, p95: 50, p99: 50 });
    expect(t.summary("tool")).toEqual({ count: 2, p50: 5, p95: 15, p99: 15 });
    expect(t.summary().count).toBe(7);
  });

  it("summary is empty-safe before any events", () => {
    expect(new Telemetry().summary()).toEqual({ count: 0, p50: 0, p95: 0, p99: 0 });
    expect(new Telemetry().summary("llm")).toEqual({ count: 0, p50: 0, p95: 0, p99: 0 });
  });

  it("subscribe fires on record and unsubscribes cleanly", () => {
    const t = new Telemetry();
    let n = 0;
    const off = t.subscribe(() => {
      n += 1;
    });
    t.record({ type: "llm", channel: "chat", ms: 1, detail: "final" });
    expect(n).toBe(1);
    off();
    t.record({ type: "llm", channel: "chat", ms: 2, detail: "final" });
    expect(n).toBe(1);
    expect(t.all()).toHaveLength(2);
  });
});
