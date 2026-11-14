import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStoreDb, removeStoreFile, StoreOpenError } from './schema'

export interface StoreHandle {
  readonly db: DatabaseSync
  readonly degraded: boolean
  readonly rebuilt: boolean
  readonly path: string
  generation(): number
  bumpGeneration(): number
  resetGeneration(value: number): void
  pricingVersion(): number
  setPricingVersion(version: number): void
  close(): void
}

export function defaultStorePath(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const root = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(home, '.dsh')
  return join(root, 'storages', 'dsh-context', 'index.sqlite')
}

function metaValue(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  /* v8 ignore next 1 */
  return row === undefined ? null : row.value
}

function metaNumber(db: DatabaseSync, key: string, fallback: number): number {
  const raw = metaValue(db, key)
  /* v8 ignore next 1 */
  const parsed = raw === null ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function attachMetaAccess(db: DatabaseSync): Pick<StoreHandle, 'generation' | 'bumpGeneration' | 'resetGeneration' | 'pricingVersion' | 'setPricingVersion'> {
  let generation = metaNumber(db, 'data_generation', 0)
  return {
    generation: () => generation,
    bumpGeneration: () => {
      generation += 1
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(generation), 'data_generation')
      return generation
    },
    resetGeneration: (value: number) => {
      generation = value
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(generation), 'data_generation')
    },
    pricingVersion: () => metaNumber(db, 'pricing_version', 0),
    setPricingVersion: (version: number) => {
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(version), 'pricing_version')
    },
  }
}

function memoryStore(): StoreHandle {
  const { db, rebuilt } = openStoreDb(':memory:')
  return {
    db,
    degraded: true,
    rebuilt,
    path: ':memory:',
    close: () => { db.close() },
    ...attachMetaAccess(db),
  }
}

export function openStore(options: { path?: string } = {}): StoreHandle {
  const path = options.path ?? defaultStorePath()
  let handle: StoreHandle
  try {
    const { db, rebuilt } = openStoreDb(path)
    handle = {
      db,
      degraded: false,
      rebuilt,
      path,
      close: () => { db.close() },
      ...attachMetaAccess(db),
    }
  } catch (error) {
    if (error instanceof StoreOpenError && error.kind === 'corrupt') {
      // A corrupted derived database is deleted and rebuilt from the durable logs; one retry, then memory.
      removeStoreFile(path)
      try {
        const { db } = openStoreDb(path)
        handle = {
          db,
          degraded: false,
          rebuilt: true,
          path,
          close: () => { db.close() },
          ...attachMetaAccess(db),
        }
        return handle
      } catch {
        // fall through to the memory fallback
      }
    }
    return memoryStore()
  }
  return handle
}
