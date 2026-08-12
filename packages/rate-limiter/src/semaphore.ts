import { assertPositiveInt } from "./types";

export class Semaphore {
  private readonly permits: number;
  private free: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    assertPositiveInt("permits", permits);
    this.permits = permits;
    this.free = permits;
  }

  get available(): number {
    return this.free;
  }

  get pending(): number {
    return this.waiters.length;
  }

  tryAcquire(): boolean {
    if (this.free <= 0) return false;
    this.free--;
    return true;
  }

  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    if (this.free >= this.permits) {
      throw new Error("release() called more times than acquire()");
    }
    this.free++;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
