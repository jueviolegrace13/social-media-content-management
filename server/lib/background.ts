import { waitUntil } from '@vercel/functions'

/**
 * Work that runs after the response is sent ("post now", webhooks). On Vercel, `waitUntil` keeps the function alive
 * until the promise settles; in the Node dev servers the process simply keeps running it. Errors are logged, never
 * thrown: anything not finished is picked up again by the daily run.
 */

const pending = new Set<Promise<unknown>>()

export function runInBackground(label: string, task: () => Promise<unknown>): void {
  const promise = Promise.resolve()
    .then(task)
    .catch((error) => console.error(`Background task ${label} failed`, error))
    .finally(() => pending.delete(promise))
  pending.add(promise)
  waitUntil(promise)
}

/** Test hook: waits for every background task, including ones started while waiting. */
export async function settleBackground(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending])
}
