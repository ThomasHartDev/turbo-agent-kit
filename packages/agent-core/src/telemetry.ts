import type { Channel } from "./types";

export interface TelemetryEvent {
  type: "llm" | "tool";
  channel: Channel;
  ms: number;
  detail: string;
  at: number;
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
}

// nearest-rank percentile; empty → 0 so dashboards need no empty special-case
export function percentileOf(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  if (p <= 0) return Math.round(sortedMs[0]!);
  if (p >= 100) return Math.round(sortedMs[sortedMs.length - 1]!);
  const rank = Math.ceil((p / 100) * sortedMs.length);
  const idx = Math.min(sortedMs.length - 1, Math.max(0, rank - 1));
  return Math.round(sortedMs[idx]!);
}

export class Telemetry {
  private events: TelemetryEvent[] = [];
  private listeners = new Set<() => void>();

  record(e: Omit<TelemetryEvent, "at">): void {
    this.events.push({ ...e, at: Date.now() });
    this.listeners.forEach((l) => l());
  }

  all(): readonly TelemetryEvent[] {
    return this.events;
  }

  percentile(p: number, type?: TelemetryEvent["type"]): number {
    return percentileOf(this.sortedMs(type), p);
  }

  summary(type?: TelemetryEvent["type"]): LatencySummary {
    const xs = this.sortedMs(type);
    return {
      count: xs.length,
      p50: percentileOf(xs, 50),
      p95: percentileOf(xs, 95),
      p99: percentileOf(xs, 99),
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private sortedMs(type?: TelemetryEvent["type"]): number[] {
    return this.events
      .filter((e) => !type || e.type === type)
      .map((e) => e.ms)
      .sort((a, b) => a - b);
  }
}
