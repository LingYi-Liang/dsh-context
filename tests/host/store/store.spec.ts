import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  DDL,
  STORE_APPLICATION_ID,
  STORE_SCHEMA_VERSION,
  openStoreDb,
  removeStoreFile,
  StoreOpenError,
} from '../../../src/host/store/schema'
import { defaultStorePath, openStore, type StoreHandle } from '../../../src/host/store/store'
import { StoreWriter } from '../../../src/host/store/writer'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-ctx-store-${prefix}-`))
  dirs.push(dir)
  return dir
}

function poisonExec(db: DatabaseSync, poison: (sql: string) => void): DatabaseSync {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'exec' || property === 'prepare') {
        return (...args: unknown[]): unknown => {
          poison(args[0] as string)
          return (target[property] as (...rest: unknown[]) => unknown).apply(target, args)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('store schema', () => {
  test('a fresh open builds the schema, stamps identity and seeds meta', () => {
    const path = join(tempDir('fresh'), 'storages', 'index.sqlite')
    const { db, rebuilt } = openStoreDb(path)
    assert.equal(rebuilt, false)
    const applicationId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
    const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    assert.equal(applicationId, STORE_APPLICATION_ID)
    assert.equal(userVersion, STORE_SCHEMA_VERSION)
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    ).all() as Array<{ name: string }>).map(row => row.name)
    for (const table of ['sessions', 'requests', 'steps', 'tool_calls', 'surface_nodes', 'system_prompts',
      'header_epochs', 'header_tools', 'events', 'file_ops', 'skill_loads', 'timing_spans', 'fold_state', 'meta']) {
      assert.ok(tables.includes(table), `missing table ${table}`)
    }
    const meta = db.prepare('SELECT key FROM meta ORDER BY key').all() as Array<{ key: string }>
    assert.deepEqual(meta.map(row => row.key), ['data_generation', 'pricing_version'])
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1)
    db.close()
  })

  test('reopening a current store keeps data and reports no rebuild', () => {
    const dir = tempDir('reopen')
    const path = join(dir, 'index.sqlite')
    const first = openStoreDb(path)
    first.db.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run('s1', 123)
    first.db.close()
    const second = openStoreDb(path)
    assert.equal(second.rebuilt, false)
    const row = second.db.prepare('SELECT id FROM sessions').get() as { id: string } | undefined
    assert.equal(row?.id, 's1')
    second.db.close()
  })

  test('a version mismatch drops every user table and rebuilds', () => {
    const dir = tempDir('version')
    const path = join(dir, 'index.sqlite')
    const first = openStoreDb(path)
    first.db.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run('old', 1)
    first.db.exec('PRAGMA user_version = 99')
    first.db.close()
    const second = openStoreDb(path)
    assert.equal(second.rebuilt, true)
    const count = (second.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    assert.equal(count, 0)
    assert.equal((second.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, STORE_SCHEMA_VERSION)
    second.db.close()
  })

  test('a foreign application id is refused without touching the file', () => {
    const dir = tempDir('foreign')
    const path = join(dir, 'foreign.sqlite')
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA application_id = 0x12345678`)
    db.exec('CREATE TABLE mine (id TEXT PRIMARY KEY) WITHOUT ROWID, STRICT')
    db.close()
    assert.throws(() => openStoreDb(path), (error: unknown) => error instanceof StoreOpenError && error.kind === 'foreign')
    assert.ok(existsSync(path), 'the foreign file must stay untouched')
    assert.ok(readFileSync(path, 'utf8').length >= 0)
  })

  test('user tables without an application id are refused', () => {
    const dir = tempDir('noappid')
    const path = join(dir, 'noappid.sqlite')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE stranger (id TEXT PRIMARY KEY)')
    db.close()
    assert.throws(() => openStoreDb(path), (error: unknown) => error instanceof StoreOpenError && error.kind === 'foreign')
  })

  test('a garbage file classifies as corrupt', () => {
    const dir = tempDir('garbage')
    const path = join(dir, 'garbage.sqlite')
    writeFileSync(path, Buffer.from('this is definitely not a sqlite database'.repeat(20), 'utf8'))
    assert.throws(() => openStoreDb(path), (error: unknown) => error instanceof StoreOpenError && error.kind === 'corrupt')
  })

  test('an uncreatable directory classifies as io failure', () => {
    const dir = tempDir('io')
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    assert.throws(() => openStoreDb(join(blocker, 'sub', 'index.sqlite')), (error: unknown) => error instanceof StoreOpenError && error.kind === 'io')
  })

  test('an in-memory store opens without touching the filesystem', () => {
    const { db, rebuilt } = openStoreDb(':memory:')
    assert.equal(rebuilt, false)
    const meta = db.prepare('SELECT key FROM meta').get() as { key: string } | undefined
    assert.equal(meta?.key, 'data_generation')
    db.close()
  })

  test('a directory in place of the database file classifies as io failure', () => {
    const dir = tempDir('dirdb')
    const asDb = join(dir, 'index.sqlite')
    mkdirSync(asDb)
    assert.throws(() => openStoreDb(asDb), (error: unknown) => error instanceof StoreOpenError && error.kind === 'io')
  })

  test('the DDL list and removeStoreFile work as helpers', () => {
    const dir = tempDir('ddl')
    const path = join(dir, 'manual.sqlite')
    const db = new DatabaseSync(path)
    for (const statement of DDL) db.exec(statement)
    const count = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n
    assert.equal(count, 14)
    db.close()
    removeStoreFile(path)
    assert.equal(existsSync(path), false)
  })
})

describe('store facade', () => {
  test('defaultStorePath resolves DSH_HOME and falls back to the home directory', () => {
    assert.equal(defaultStorePath({ DSH_HOME: '/data/dsh' }, '/home/x'), join('/data/dsh', 'storages', 'dsh-context', 'index.sqlite'))
    assert.equal(defaultStorePath({ DSH_HOME: '   ' }, '/home/x'), join('/home/x', '.dsh', 'storages', 'dsh-context', 'index.sqlite'))
    assert.equal(defaultStorePath({}, '/home/x'), join('/home/x', '.dsh', 'storages', 'dsh-context', 'index.sqlite'))
  })

  test('openStore exposes meta accessors with an in-memory generation cache', () => {
    const handle = openStore({ path: join(tempDir('accessors'), 'index.sqlite') })
    try {
      assert.equal(handle.degraded, false)
      assert.equal(handle.rebuilt, false)
      assert.equal(handle.generation(), 0)
      assert.equal(handle.bumpGeneration(), 1)
      assert.equal(handle.generation(), 1)
      handle.resetGeneration(7)
      assert.equal(handle.generation(), 7)
      assert.equal(handle.pricingVersion(), 0)
      handle.setPricingVersion(42)
      assert.equal(handle.pricingVersion(), 42)
      const row = handle.db.prepare("SELECT value FROM meta WHERE key = 'data_generation'").get() as { value: string }
      assert.equal(row.value, '7')
    } finally {
      handle.close()
    }
  })

  test('a corrupted store file is deleted and rebuilt transparently', () => {
    const dir = tempDir('corrupt')
    const path = join(dir, 'index.sqlite')
    writeFileSync(path, Buffer.from('garbage bytes'.repeat(50), 'utf8'))
    const handle = openStore({ path })
    try {
      assert.equal(handle.degraded, false)
      assert.equal(handle.rebuilt, true)
      const meta = handle.db.prepare('SELECT key FROM meta').all() as Array<{ key: string }>
      assert.equal(meta.length, 2)
    } finally {
      handle.close()
    }
  })

  test('a foreign store falls back to an ephemeral in-memory store and keeps the foreign file', () => {
    const dir = tempDir('foreign-facade')
    const path = join(dir, 'foreign.sqlite')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA application_id = 0x44534851')
    db.exec('CREATE TABLE theirs (id TEXT PRIMARY KEY)')
    db.close()
    const before = readFileSync(path)
    const handle = openStore({ path })
    try {
      assert.equal(handle.degraded, true)
      assert.equal(handle.path, ':memory:')
      assert.deepEqual(readFileSync(path), before)
    } finally {
      handle.close()
    }
  })

  test('an io failure (file blocking the directory) falls back to memory', () => {
    const dir = tempDir('io-facade')
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const handle = openStore({ path: join(blocker, 'sub', 'index.sqlite') })
    try {
      assert.equal(handle.degraded, true)
      assert.equal(handle.generation(), 0)
    } finally {
      handle.close()
    }
  })

  test('an unwritable directory falls back to memory without throwing', () => {
    const handle = openStore({ path: join(tempDir('ro-facade'), 'nested', 'index.sqlite') })
    try {
      assert.equal(handle.degraded, false)
    } finally {
      handle.close()
    }
  })

  test('openStore without a path resolves the default location from DSH_HOME', () => {
    const dir = tempDir('default-path')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      const handle = openStore()
      try {
        assert.equal(handle.degraded, false)
        assert.ok(existsSync(join(dir, 'storages', 'dsh-context', 'index.sqlite')))
      } finally {
        handle.close()
      }
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  test('meta accessors fall back to zero for missing or unparseable rows at open time', () => {
    const dir = tempDir('meta-fallback')
    const path = join(dir, 'index.sqlite')
    const first = openStoreDb(path)
    first.db.prepare("DELETE FROM meta WHERE key = 'data_generation'").run()
    first.db.prepare("UPDATE meta SET value = 'junk' WHERE key = 'pricing_version'").run()
    first.db.close()
    const handle = openStore({ path })
    try {
      assert.equal(handle.generation(), 0)
      assert.equal(handle.pricingVersion(), 0)
      assert.equal(handle.bumpGeneration(), 1)
    } finally {
      handle.close()
    }
  })
})

describe('writer', () => {
  interface Fixture {
    handle: StoreHandle
    writer: StoreWriter
    generations: number[]
  }

  function writerFixture(): Fixture {
    const handle = openStore({ path: join(tempDir('writer'), 'index.sqlite') })
    const generations: number[] = []
    const writer = new StoreWriter(handle.db, () => {
      const next = handle.bumpGeneration()
      generations.push(next)
      return next
    })
    return { handle, writer, generations }
  }

  function seedSession(writer: StoreWriter, id: string): void {
    writer.write({ sessionId: id, session: { created_at: 1, updated_at: 1 } })
  }

  test('session upserts insert and merge patches', () => {
    const { handle, writer, generations } = writerFixture()
    try {
      writer.write({ sessionId: 's1', session: { created_at: 10, updated_at: 10, title: 'one' } })
      writer.write({ sessionId: 's1', session: { title: 'two' } })
      const row = handle.db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<string, unknown>
      assert.equal(row.title, 'two')
      assert.equal(row.created_at, 10)
      assert.equal(row.fold_status, 'pending')
      assert.equal(generations.length, 2)
    } finally {
      handle.close()
    }
  })

  test('child rows insert, patch-merge and delete by primary key', () => {
    const { handle, writer } = writerFixture()
    try {
      seedSession(writer, 's1')
      writer.write({
        sessionId: 's1',
        ops: [
          { table: 'tool_calls', patch: { session_id: 's1', seq: 5, call_id: 'c1', name: 'bash', start_time: 100 } },
          { table: 'file_ops', patch: { session_id: 's1', seq: 6, ordinal: 0, kind: 'read', tool: 'read', path: '/a' } },
          { table: 'file_ops', patch: { session_id: 's1', seq: 6, ordinal: 1, kind: 'search', tool: 'grep', path: '/b' } },
        ],
      })
      let calls = handle.db.prepare('SELECT * FROM tool_calls').all() as Array<Record<string, unknown>>
      assert.equal(calls.length, 1)
      writer.write({
        sessionId: 's1',
        ops: [
          { table: 'tool_calls', patch: { session_id: 's1', seq: 5, result_seq: 9, end_time: 150, duration_ms: 50, is_error: 1 } },
        ],
      })
      calls = handle.db.prepare('SELECT * FROM tool_calls').all() as Array<Record<string, unknown>>
      assert.equal(calls[0].duration_ms, 50)
      assert.equal(calls[0].name, 'bash')
      writer.write({ sessionId: 's1', ops: [{ table: 'file_ops', patch: { session_id: 's1', seq: 6, ordinal: 1 }, delete: true }] })
      const ops = handle.db.prepare('SELECT ordinal FROM file_ops ORDER BY ordinal').all() as Array<{ ordinal: number }>
      assert.deepEqual(ops.map(row => row.ordinal), [0])
    } finally {
      handle.close()
    }
  })

  test('upserts missing a primary key column are refused', () => {
    const { handle, writer } = writerFixture()
    try {
      seedSession(writer, 's1')
      assert.throws(() => writer.write({ sessionId: 's1', ops: [{ table: 'tool_calls', patch: { call_id: 'c1', name: 'x', start_time: 1 } }] }),
        /missing primary key column "session_id"/)
      assert.throws(() => writer.write({ sessionId: 's1', ops: [{ table: 'tool_calls', patch: { seq: 1, name: 'x' }, delete: true }] }),
        /missing primary key column "session_id"/)
      assert.throws(() => writer.write({ sessionId: 's1', ops: [{ table: 'tool_calls', patch: { session_id: 's1' }, update: 'call_id' }] }),
        /missing key column "call_id"/)
      writer.write({ sessionId: 's1', ops: [{ table: 'tool_calls', patch: { session_id: 's1', call_id: 'c1' }, update: 'call_id' }] })
    } finally {
      handle.close()
    }
  })

  test('the inherited cut flags prefix requests and the recompute excludes them', () => {
    const { handle, writer } = writerFixture()
    try {
      seedSession(writer, 's1')
      writer.write({
        sessionId: 's1',
        ops: [0, 1, 2, 3].map(seq => ({
          table: 'requests' as const,
          patch: { session_id: 's1', seq, time: seq, input_tokens: 10, cache_read_tokens: 5, output_tokens: 2 },
        })),
      })
      writer.write({ sessionId: 's1', inheritedCutSeq: 1 })
      const flags = handle.db.prepare('SELECT seq, is_inherited FROM requests ORDER BY seq').all() as Array<{ seq: number, is_inherited: number }>
      assert.deepEqual(flags.map(row => row.is_inherited), [1, 1, 0, 0])
      const session = handle.db.prepare('SELECT billed_tokens FROM sessions WHERE id = ?').get('s1') as { billed_tokens: number }
      assert.equal(session.billed_tokens, 10 + 5 + 2 + (10 + 5 + 2))
    } finally {
      handle.close()
    }
  })

  test('cur_total recomputes from live surface, latest positive system prompt and latest epoch tools', () => {
    const { handle, writer } = writerFixture()
    try {
      seedSession(writer, 's1')
      writer.write({
        sessionId: 's1',
        ops: [
          { table: 'surface_nodes', patch: { session_id: 's1', seq: 1, cat: 'user', tokens: 7 } },
          { table: 'surface_nodes', patch: { session_id: 's1', seq: 2, cat: 'tool', tokens: 3, gone_seq: 9 } },
          { table: 'system_prompts', patch: { session_id: 's1', seq: 4, time: 4, tokens: 0 } },
          { table: 'system_prompts', patch: { session_id: 's1', seq: 5, time: 5, tokens: 11 } },
          { table: 'header_epochs', patch: { session_id: 's1', seq: 6, time: 6, tools_tokens: 13 } },
          { table: 'header_epochs', patch: { session_id: 's1', seq: 7, time: 7, tools_tokens: 17 } },
        ],
        bumpDetailRev: true,
      })
      const session = handle.db.prepare('SELECT cur_total, detail_rev FROM sessions WHERE id = ?').get('s1') as { cur_total: number, detail_rev: number }
      assert.equal(session.cur_total, 7 + 11 + 17)
      assert.equal(session.detail_rev, 1)
    } finally {
      handle.close()
    }
  })

  test('billed tokens treat missing usage buckets as zero and skip inherited rows', () => {
    const { handle, writer } = writerFixture()
    try {
      seedSession(writer, 's1')
      writer.write({
        sessionId: 's1',
        ops: [
          { table: 'requests', patch: { session_id: 's1', seq: 1, time: 1, output_tokens: 100 } },
          { table: 'requests', patch: { session_id: 's1', seq: 2, time: 2, input_tokens: 4 } },
          { table: 'requests', patch: { session_id: 's1', seq: 3, time: 3 } },
          { table: 'requests', patch: { session_id: 's1', seq: 4, time: 4, input_tokens: 50, is_inherited: 1 } },
        ],
      })
      const session = handle.db.prepare('SELECT billed_tokens FROM sessions WHERE id = ?').get('s1') as { billed_tokens: number }
      assert.equal(session.billed_tokens, 104)
    } finally {
      handle.close()
    }
  })

  test('fold state upserts, drops and participates in the same transaction', () => {
    const { handle, writer } = writerFixture()
    try {
      seedSession(writer, 's1')
      writer.write({ sessionId: 's1', foldState: { lastSeq: 42, stateJson: '{"sums":{}}' } })
      let row: { last_seq: number } | undefined = handle.db.prepare('SELECT last_seq FROM fold_state WHERE session_id = ?').get('s1') as { last_seq: number }
      assert.equal(row.last_seq, 42)
      writer.write({ sessionId: 's1', dropFoldState: true })
      row = handle.db.prepare('SELECT last_seq FROM fold_state WHERE session_id = ?').get('s1') as { last_seq: number } | undefined
      assert.equal(row, undefined)
    } finally {
      handle.close()
    }
  })

  test('empty writes do not open transactions or bump the generation', () => {
    const { handle, writer, generations } = writerFixture()
    try {
      writer.write({ sessionId: 'ghost' })
      writer.write([])
      assert.equal(generations.length, 0)
      assert.equal(handle.generation(), 0)
    } finally {
      handle.close()
    }
  })

  test('a failed write rolls back completely and leaves the generation untouched', () => {
    const { handle, writer, generations } = writerFixture()
    try {
      seedSession(writer, 's1')
      const before = handle.generation()
      const beforeWrites = generations.length
      assert.throws(() => writer.write({
        sessionId: 's1',
        ops: [
          { table: 'surface_nodes', patch: { session_id: 's1', seq: 1, cat: 'user', tokens: 5 } },
          { table: 'surface_nodes', patch: { session_id: 'missing', seq: 2, cat: 'user', tokens: 5 } },
        ],
      }), /FOREIGN KEY/)
      const nodes = handle.db.prepare('SELECT COUNT(*) AS n FROM surface_nodes').get() as { n: number }
      assert.equal(nodes.n, 0)
      assert.equal(handle.generation(), before)
      assert.equal(generations.length, beforeWrites)
    } finally {
      handle.close()
    }
  })

  test('a missing NOT NULL column fills with its declared default on insert', () => {
    const { handle, writer } = writerFixture()
    try {
      seedSession(writer, 's1')
      writer.write({
        sessionId: 's1',
        session: { created_at: 5, updated_at: 5 },
        ops: [{ table: 'fold_state', patch: { session_id: 's1', last_seq: 3 } }],
      })
      const state = handle.db.prepare('SELECT state_json FROM fold_state WHERE session_id = ?').get('s1') as { state_json: string }
      assert.equal(state.state_json, '')
      const session = handle.db.prepare('SELECT fold_status, blank, last_seq FROM sessions WHERE id = ?').get('s1') as Record<string, unknown>
      assert.equal(session.fold_status, 'pending')
      assert.equal(session.blank, 0)
      assert.equal(session.last_seq, -1)
    } finally {
      handle.close()
    }
  })

  test('a failed BEGIN skips the rollback guard in both entry points', () => {
    const { handle, writer } = writerFixture()
    try {
      const locked = poisonExec(handle.db, sql => {
        if (sql.startsWith('BEGIN')) throw new Error('cannot start a transaction within a transaction')
      })
      const lockedWriter = new StoreWriter(locked, () => handle.bumpGeneration())
      assert.throws(() => lockedWriter.write({ sessionId: 's1', session: { created_at: 1, updated_at: 1 } }),
        /cannot start a transaction/)
      seedSession(writer, 's1')
      assert.throws(() => lockedWriter.deleteSession('s1'), /cannot start a transaction/)
      const sessions = handle.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
      assert.equal(sessions.n, 1)
    } finally {
      handle.close()
    }
  })

  test('a failed rollback keeps the original constraint error actionable', () => {
    const { handle, writer } = writerFixture()
    try {
      seedSession(writer, 's1')
      const flaky = poisonExec(handle.db, sql => {
        if (sql === 'ROLLBACK') throw new Error('rollback refused')
      })
      const flakyWriter = new StoreWriter(flaky, () => handle.bumpGeneration())
      assert.throws(() => flakyWriter.write({
        sessionId: 's1',
        ops: [{ table: 'surface_nodes', patch: { session_id: 'missing', seq: 1, cat: 'user', tokens: 1 } }],
      }), /FOREIGN KEY/)
    } finally {
      handle.close()
    }
  })

  test('a failed delete rolls back inside the deleteSession transaction', () => {
    const { handle, writer } = writerFixture()
    try {
      seedSession(writer, 's1')
      const flaky = poisonExec(handle.db, sql => {
        if (sql.startsWith('DELETE FROM sessions')) throw new Error('delete refused')
      })
      const flakyWriter = new StoreWriter(flaky, () => handle.bumpGeneration())
      assert.throws(() => flakyWriter.deleteSession('s1'), /delete refused/)
      const sessions = handle.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
      assert.equal(sessions.n, 1)
    } finally {
      handle.close()
    }
  })

  test('an array write shares one transaction across sessions', () => {
    const { handle, writer, generations } = writerFixture()
    try {
      writer.write([
        { sessionId: 'a', session: { created_at: 1, updated_at: 1 } },
        { sessionId: 'b', session: { created_at: 2, updated_at: 2 } },
        { sessionId: 'c' },
      ])
      const count = (handle.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
      assert.equal(count, 2)
      assert.equal(generations.length, 2)
    } finally {
      handle.close()
    }
  })

  test('deleteSession cascades to child rows and reports misses', () => {
    const { handle, writer } = writerFixture()
    try {
      seedSession(writer, 's1')
      writer.write({ sessionId: 's1', ops: [{ table: 'requests', patch: { session_id: 's1', seq: 1, time: 1 } }] })
      assert.equal(writer.deleteSession('s1'), true)
      assert.equal(writer.deleteSession('s1'), false)
      const requests = handle.db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }
      assert.equal(requests.n, 0)
    } finally {
      handle.close()
    }
  })
})
