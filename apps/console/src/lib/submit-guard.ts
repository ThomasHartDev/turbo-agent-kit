/** Sync submit lock + monotonic turn id so stale streams cannot mutate state. */
export function createSubmitGuard() {
  let inFlight = false;
  let turnId = 0;

  return {
    tryBegin(): number | null {
      if (inFlight) return null;
      inFlight = true;
      return ++turnId;
    },
    isActive(id: number): boolean {
      return id === turnId;
    },
    cancel(): void {
      turnId += 1;
      inFlight = false;
    },
    end(id: number): void {
      if (id === turnId) inFlight = false;
    },
  };
}

export type SubmitGuard = ReturnType<typeof createSubmitGuard>;
