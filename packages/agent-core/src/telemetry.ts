import type { Channel } from "./types";

export interface TelemetryEvent {
  type: "llm" | "tool";
  channel: Channel;
  ms: number;
  detail: string;
  at: number;
}

export class Telemetry {
  private events: TelemetryEvent[] = [];
  private listeners = new Set<() => void>();

  record(e: Omit<TelemetryEvent, "at">): void {
    // Type is TelemetryEvent minus the "at" field so we can add it ourselves
    this.events.push({ ...e, at: Date.now() });
    this.listeners.forEach((l) => l());
  }

  all(): readonly TelemetryEvent[] {
    return this.events;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  percentile(p: number, type?: TelemetryEvent["type"]): number {
    const xs = this.events
      .filter((e) => !type || e.type === type)
      .map((e) => e.ms)
      .sort((a, b) => a - b);
    if (xs.length === 0) return 0;
    const idx = Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1);
    return Math.round(xs[Math.max(0, idx)]!);
  }
}
