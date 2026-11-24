import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import * as schema from './schema.js'

/** Driver-agnostic handle so tests can swap Neon for an in-process Postgres (PGlite). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

let db: Db | undefined

export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')
    db = drizzle(neon(url), { schema }) as unknown as Db
  }
  return db
}

/** Test hook: inject a database (e.g. PGlite). */
export function setDb(next: Db | undefined): void {
  db = next
}

/** Rows of a raw `db.execute()` result (both drivers return `{ rows }`). */
export function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows
}
