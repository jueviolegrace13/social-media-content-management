/**
 * The publishing engine's notion of "now". Queue times are compared against this value (passed into SQL), not the
 * database's now(), so tests can move time forward to exercise retries and schedules without waiting.
 */
let fake: { t: number } | undefined

export const now = (): Date => (fake ? new Date(fake.t) : new Date())

/** Test hook: freeze time at `start` (undefined restores the real clock). */
export function setFakeClock(start: Date | undefined): void {
  fake = start ? { t: start.getTime() } : undefined
}

/** Test hook: move the fake clock forward. */
export function advanceClock(ms: number): void {
  if (fake) fake.t += ms
}

/** Waits; with a fake clock it moves the clock forward instead. */
export function sleep(ms: number): Promise<void> {
  if (fake) {
    fake.t += Math.max(0, ms)
    return Promise.resolve()
  }
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}
