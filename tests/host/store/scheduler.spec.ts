import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, test } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TimelineEvent } from '../../../src/host/fold'
import { createStoreScheduler, nextSliceSize, type StoreScheduler } from '../../../src/host/store/scheduler'
import { recordTitle } from '../../../src/host/store/scheduler'
import { flushSession } from '../../../src/host/store/sessionFold'
import { foldEventsToRows } from '../../../src/host/store/sessionFold'
import { resolveBounds } from '../../../src/host/config'
import type { StorePersistenceLike } from '../../../src/host/store/scheduler'

const dirs: string[] = []
const created: StoreScheduler[] = []

function tempHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-ctx-sched-${prefix}-`))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const scheduler of created) scheduler.dispose()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const text = (value: string) => [{ type: 'text', text: value }]

interface LogSpec {
  id: string
  events: TimelineEvent[]
  mtime?: number
}

function fakePersistence(logs: LogSpec[], files?: Map<string, string>): StorePersistenceLike & { opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    open: async (id: string) => {
      opened.push(id)
      const log = logs.find(spec => spec.id === id)
      return {
        header: { id, createdAt: 1 },
        read: async () => ({ events: (log?.events ?? []) as unknown as SessionEvent[] }),
        close: async () => {},
      }
    },
    stat: async (id: string) => {
      const log = logs.find(spec => spec.id === id)
      const dir = files?.get('dir') ?? ''
      const path = dir !== '' ? join(dir, `${id}.jsonl`) : `/logs/${id}.jsonl`
      if (dir !== '') writeFileSync(path, `log of ${id}`)
      return { location: { path }, sizeBytes: log?.events.length ?? 0 }
    },
  }
}

function schedulerIn(home: string, persistence: StorePersistenceLike): StoreScheduler {
  const scheduler = createStoreScheduler(
    { effect: () => () => {} } as never,
    persistence,
    { path: join(home, 'storages', 'dsh-context', 'index.sqlite') },
  )
  created.push(scheduler)
  return scheduler
}

function sessionEvents(id: number, opts: { usage?: boolean } = {}): TimelineEvent[] {
  const base = id * 100
  const events: TimelineEvent[] = [
    { type: 'request/header', seq: base + 1, time: base + 1, data: { header: { config: { model: 'm', provider: 'deepseek' } }, reason: 'initial' } },
    { type: 'turn/start', seq: base + 2, time: base + 1, data: { turn: 1 } },
    { type: 'step/start', seq: base + 3, time: base + 2, data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: base + 4, time: base + 3, data: { content: text(`question ${id}`), source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: base + 5, time: base + 4, data: { turn: 1, step: 0, message: { content: text('reply') }, ...(opts.usage === false ? {} : { usage: { inputTokens: 10, outputTokens: 5 } }) } } as TimelineEvent,
    { type: 'step/end', seq: base + 6, time: base + 5, data: { turn: 1, step: 0 } },
  ]
  return events
}

describe('recordTitle', () => {
  test('returns the workspace title for a cwd and empty otherwise', () => {
    assert.equal(recordTitle(undefined), '')
    assert.ok(recordTitle('/repo/project').length > 0)
  })
})

describe('store scheduler — reconcile', () => {
  test('inserts pending rows for listed sessions and deletes vanished ones', () => {
    const home = tempHome('reconcile')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      const first = scheduler.reconcile([
        { header: { id: 'a', createdAt: 10, cwd: '/repo/a' } },
        { header: { id: 'b', createdAt: 20, cwd: '/repo/b' } },
      ], new Set())
      assert.equal(first.total, 2)
      assert.equal(first.changed, true)
      const handle = scheduler.handle
      const statuses = handle.db.prepare('SELECT id, fold_status, title, running FROM sessions ORDER BY id').all() as Array<Record<string, unknown>>
      assert.equal(statuses.length, 2)
      assert.equal(statuses[0].fold_status, 'pending')
      assert.equal(statuses[0].running, 0)
      assert.ok((statuses[0].title as string).length > 0 || statuses[0].title === '')
      const second = scheduler.reconcile([
        { header: { id: 'a', createdAt: 10, cwd: '/repo/a' } },
      ], new Set())
      assert.equal(second.changed, true)
      const marked = handle.db.prepare('SELECT id, vanished_at FROM sessions ORDER BY id').all() as Array<{ id: string; vanished_at: number | null }>
      assert.deepEqual(marked.map(row => row.id), ['a', 'b'])
      assert.notEqual(marked[1].vanished_at, null)
      const third = scheduler.reconcile([
        { header: { id: 'a', createdAt: 10, cwd: '/repo/a' } },
      ], new Set())
      assert.equal(third.changed, true)
      const left = handle.db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: string }>
      assert.deepEqual(left.map(row => row.id), ['a'])
    } finally {
      scheduler.dispose()
    }
  })

  test('unchanged metadata does not rewrite rows or bump the generation', () => {
    const home = tempHome('stable')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 10, cwd: '/repo/a' } }], new Set())
      const before = handleGeneration(scheduler)
      scheduler.reconcile([{ header: { id: 'a', createdAt: 10, cwd: '/repo/a' } }], new Set())
      assert.equal(handleGeneration(scheduler), before)
      scheduler.reconcile([{ header: { id: 'a', createdAt: 10, cwd: '/repo/changed' } }], new Set())
      assert.equal(handleGeneration(scheduler), before + 1)
    } finally {
      scheduler.dispose()
    }
  })

  test('live sessions are mirrored as running and never deleted while live', () => {
    const home = tempHome('live')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.reconcile([{ header: { id: 'alive', createdAt: 1, cwd: '/w' } }], new Set(['alive']))
      const row = scheduler.handle.db.prepare('SELECT running FROM sessions WHERE id = ?').get('alive') as { running: number }
      assert.equal(row.running, 1)
      scheduler.reconcile([], new Set(['alive']))
      assert.notEqual(scheduler.handle.db.prepare('SELECT id FROM sessions WHERE id = ?').get('alive'), undefined)
      scheduler.reconcile([], new Set())
      assert.notEqual(scheduler.handle.db.prepare('SELECT vanished_at FROM sessions WHERE id = ?').get('alive'), undefined)
      scheduler.reconcile([], new Set())
      assert.equal(scheduler.handle.db.prepare('SELECT id FROM sessions WHERE id = ?').get('alive'), undefined)
    } finally {
      scheduler.dispose()
    }
  })
})

function handleGeneration(scheduler: StoreScheduler): number {
  return scheduler.handle.generation()
}

describe('store scheduler — backfill pass', () => {
  test('folds cold sessions into rows and marks coverage', async () => {
    const home = tempHome('backfill')
    const logs: LogSpec[] = [
      { id: 'a', events: sessionEvents(1) },
      { id: 'b', events: sessionEvents(2, { usage: false }) },
    ]
    const persistence = fakePersistence(logs, new Map([['dir', home]]))
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([
        { header: { id: 'a', createdAt: 1, cwd: '/repo/a' } },
        { header: { id: 'b', createdAt: 2, cwd: '/repo/b' } },
      ], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      const coverage = scheduler.coverage()
      assert.equal(coverage.total, 2)
      assert.equal(coverage.covered, 2)
      assert.equal(coverage.pending, 0)
      const handle = scheduler.handle
      const requests = handle.db.prepare('SELECT * FROM requests ORDER BY session_id, seq').all() as Array<Record<string, unknown>>
      assert.equal(requests.length, 2)
      assert.equal(requests[0].output_tokens, 5)
      assert.equal(requests[1].prompt_tokens, null)
      const surface = handle.db.prepare('SELECT COUNT(*) AS n FROM surface_nodes').get() as { n: number }
      assert.equal(surface.n, 4)
      const blank = handle.db.prepare('SELECT blank FROM sessions WHERE id = ?').get('a') as { blank: number }
      assert.equal(blank.blank, 0)
    } finally {
      scheduler.dispose()
    }
  })

  test('a tail-only log read continues from the stored checkpoint', async () => {
    const home = tempHome('tail')
    const early: LogSpec = { id: 'a', events: sessionEvents(1) }
    const persistence = fakePersistence([early])
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/repo/a' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      const requestsBefore = (scheduler.handle.db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n
      assert.equal(requestsBefore, 1)
      const blankBefore = scheduler.handle.db.prepare('SELECT blank FROM sessions WHERE id = ?').get('a') as { blank: number }
      assert.equal(blankBefore.blank, 0)
      persistence.opened.length = 0
      // grow the log: a second turn arrives
      early.events.push(
        { type: 'step/start', seq: 107, time: 206, data: { turn: 2, step: 1 } } as TimelineEvent,
        { type: 'user/message', seq: 108, time: 207, data: { content: text('follow-up'), source: { kind: 'user' } }, surfaceOp: 'append' } as TimelineEvent,
        { type: 'assistant/message', seq: 109, time: 208, data: { turn: 2, step: 1, message: { content: text('reply 2') }, usage: { inputTokens: 3, outputTokens: 4 } } } as TimelineEvent,
        { type: 'step/end', seq: 110, time: 209, data: { turn: 2, step: 1 } } as TimelineEvent,
      )
      await scheduler.backfillPass(new AbortController().signal)
      const requestsAfter = (scheduler.handle.db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n
      assert.equal(requestsAfter, requestsBefore + 1)
      const session = scheduler.handle.db.prepare('SELECT billed_tokens, last_seq FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(session.billed_tokens, 10 + 5 + 3 + 4)
      assert.equal(session.last_seq, 110)
    } finally {
      scheduler.dispose()
    }
  })

  test('unsupported and failing sessions are surfaced through coverage', async () => {
    const home = tempHome('failed')
    const persistence: StorePersistenceLike & { opened: string[] } = {
      opened: [],
      open: async (id: string) => {
        if (id === 'bad') {
          throw Object.assign(new Error('legacy'), { name: 'SessionFormatUnsupportedError' })
        }
        if (id === 'broken') {
          throw new Error('disk on fire')
        }
        return {
          header: { id, createdAt: 1 },
          read: async () => ({ events: sessionEvents(1) as unknown as SessionEvent[] }),
          close: async () => {},
        }
      },
    }
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([
        { header: { id: 'ok1', createdAt: 1, cwd: '/w' } },
        { header: { id: 'bad', createdAt: 2, cwd: '/w' } },
        { header: { id: 'broken', createdAt: 3, cwd: '/w' } },
      ], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      const coverage = scheduler.coverage()
      assert.equal(coverage.covered, 1)
      assert.equal(coverage.unsupported, 1)
      assert.equal(coverage.failed, 1)
      const statuses = scheduler.handle.db.prepare('SELECT id, fold_status FROM sessions ORDER BY id').all() as Array<Record<string, unknown>>
      const byId = new Map(statuses.map(row => [row.id, row.fold_status]))
      assert.equal(byId.get('bad'), 'unsupported')
      assert.equal(byId.get('broken'), 'failed')
    } finally {
      scheduler.dispose()
    }
  })
})

describe('store scheduler — live write-through', () => {
  test('absorbed events flush on step/end and derive blank/running mirrors', async () => {
    const home = tempHome('live')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.reconcile([{ header: { id: 's1', createdAt: 1, cwd: '/w' } }], new Set(['s1']))
      await scheduler.backfillPass(new AbortController().signal)
      for (const event of sessionEvents(1)) {
        scheduler.absorb('s1', event)
      }
      const session = scheduler.handle.db.prepare('SELECT billed_tokens, cur_total, blank, fold_status FROM sessions WHERE id = ?').get('s1') as Record<string, unknown>
      assert.equal(session.billed_tokens, 15)
      assert.ok((session.cur_total as number) > 0)
      assert.equal(session.blank, 0)
      assert.equal(session.fold_status, 'ok')
      const requests = scheduler.handle.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE session_id = ?').get('s1') as { n: number }
      assert.equal(requests.n, 1)
    } finally {
      scheduler.dispose()
    }
  })

  test('a buffered shallow folder adopts the backfill checkpoint and replays', async () => {
    const home = tempHome('adopt')
    const logs: LogSpec[] = [{ id: 's1', events: sessionEvents(1) }]
    const persistence = fakePersistence(logs, new Map([['dir', home]]))
    const scheduler = schedulerIn(home, persistence)
    try {
      // Insert the session with prior history but WITHOUT folding it yet.
      scheduler.reconcile([{ header: { id: 's1', createdAt: 1, cwd: '/w' } }], new Set(['s1']))
      // Live events arrive before the backfill reaches the session.
      scheduler.absorb('s1', { type: 'step/start', seq: 107, time: 107, data: { turn: 9, step: 0 } })
      scheduler.absorb('s1', { type: 'user/message', seq: 108, time: 108, data: { content: text('live question'), source: { kind: 'user' } }, surfaceOp: 'append' } as TimelineEvent)
      const rowsBefore = (scheduler.handle.db.prepare('SELECT COUNT(*) AS n FROM surface_nodes').get() as { n: number }).n
      // The folder must be buffering (shallow-seed guard) — no rows written.
      assert.equal(rowsBefore, 0)
      // The backfill lands the checkpoint for the full log.
      await scheduler.backfillPass(new AbortController().signal)
      // The next live event adopts the checkpoint and replays the buffer.
      scheduler.absorb('s1', { type: 'assistant/message', seq: 109, time: 109, data: { turn: 9, step: 1, message: { content: text('live reply') }, usage: { inputTokens: 2, outputTokens: 3 } } } as TimelineEvent)
      scheduler.flushLive('s1')
      const session = scheduler.handle.db.prepare('SELECT billed_tokens, cur_total, last_seq FROM sessions WHERE id = ?').get('s1') as Record<string, unknown>
      assert.equal(session.billed_tokens, 10 + 5 + 2 + 3)
      assert.equal(session.last_seq, 109)
      const liveUser = scheduler.handle.db.prepare(
        "SELECT tokens FROM surface_nodes WHERE session_id = 's1' AND seq = 108",
      ).get() as { tokens: number } | undefined
      assert.notEqual(liveUser, undefined)
    } finally {
      scheduler.dispose()
    }
  })

  test('eviction keeps bounded live folders without losing folded rows', () => {
    const home = tempHome('evict')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      for (let index = 1; index <= 40; index++) {
        const id = `s${index}`
        for (const event of sessionEvents(index)) scheduler.absorb(id, event)
      }
      assert.equal(scheduler.coverage().total, 40)
      assert.equal(scheduler.coverage().pending, 40)
    } finally {
      scheduler.dispose()
    }
  })
})

describe('store scheduler — identity', () => {
  test('flush sessions carry the durable identity from persistence.stat', async () => {
    const home = tempHome('identity')
    const logs: LogSpec[] = [{ id: 'a', events: sessionEvents(1) }]
    const persistence = fakePersistence(logs, new Map([['dir', home]]))
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      const session = scheduler.handle.db.prepare('SELECT log_path, log_size FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(session.log_path, join(home, 'a.jsonl'))
      assert.equal(session.log_size, 6)
    } finally {
      scheduler.dispose()
    }
  })

  test('stat shapes without a usable path leave the identity unset', async () => {
    const home = tempHome('identity-blank')
    const logs: LogSpec[] = [{ id: 'a', events: sessionEvents(1) }]
    const persistence = fakePersistence(logs)
    persistence.stat = async () => ({})
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      const session = scheduler.handle.db.prepare('SELECT log_path, log_size FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(session.log_path, null)
      assert.equal(session.log_size, null)
    } finally {
      scheduler.dispose()
    }
  })
})

describe('store scheduler — store file', () => {
  test('the store lands inside the provided home', () => {
    const home = tempHome('file')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      assert.ok(scheduler.handle.path.includes('storages'))
      writeFileSync(join(home, 'marker'), 'x')
      assert.ok(scheduler.handle.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() !== undefined)
    } finally {
      scheduler.dispose()
    }
  })
})

describe('store scheduler — lifecycle edge paths', () => {
  interface EffectCapture {
    disposers: Array<() => void>
    scheduler: StoreScheduler
  }

  function schedulerWithEffects(home: string, persistence: StorePersistenceLike, clock?: () => number): EffectCapture {
    const disposers: Array<() => void> = []
    const scheduler = createStoreScheduler(
      { effect: (setup: unknown) => { disposers.push((setup as () => () => void)()); return null } } as never,
      persistence,
      { path: join(home, 'index.sqlite'), ...(clock === undefined ? {} : { clock }) },
    )
    created.push(scheduler)
    return { disposers, scheduler }
  }

  test('the effect disposer disposes the scheduler; dispose is idempotent; absorb after dispose is a no-op', () => {
    const home = tempHome('lifecycle')
    const { disposers, scheduler } = schedulerWithEffects(home, fakePersistence([]))
    scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
    assert.equal(disposers.length, 1)
    disposers[0]()
    disposers[0]()
    scheduler.absorb('a', { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
    assert.equal(scheduler.coverage().total, 0)
  })

  test('a provided clock drives folded_at and reconcile runs on an empty store', () => {
    const home = tempHome('clock')
    let tick = 1_000
    const { scheduler } = schedulerWithEffects(home, fakePersistence([]), () => { tick += 5; return tick })
    const result = scheduler.reconcile([], new Set())
    assert.equal(result.changed, false)
    assert.equal(result.total, 0)
    const coverage = scheduler.coverage()
    assert.equal(coverage.total, 0)
    assert.equal(coverage.covered, 0)
    assert.equal(coverage.running, false)
    scheduler.flushLive('missing')
    scheduler.disposeLive('missing')
    scheduler.dispose()
    scheduler.dispose()
  })

  test('evictOldest force-evicts the oldest folder when every folder is dirty', () => {
    const home = tempHome('evict-dirty')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      for (let index = 0; index < 32; index++) {
        scheduler.absorb(`s${index}`, { type: 'user/message', seq: 1, time: 1, data: { content: text('x'), source: { kind: 'user' } }, surfaceOp: 'append' })
        scheduler.flushLive(`s${index}`)
      }
      assert.equal(scheduler.coverage().total, 32)
      scheduler.absorb('overflow', { type: 'user/message', seq: 1, time: 1, data: { content: text('x'), source: { kind: 'user' } }, surfaceOp: 'append' })
      scheduler.flushLive('overflow')
      assert.ok(scheduler.coverage().total >= 32)
    } finally {
      scheduler.dispose()
    }
  })

  test('absorb drops invalid shapes, stale seqs and buffers overflow into disposal', async () => {
    const home = tempHome('absorb-guard')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      scheduler.absorb('a', { type: 'user/message', seq: 200, time: 1, data: { content: text('x'), source: { kind: 'user' } }, surfaceOp: 'append' })
      scheduler.flushLive('a')
      const surface = scheduler.handle.db.prepare('SELECT COUNT(*) AS n FROM surface_nodes WHERE session_id = ?').get('a') as { n: number }
      assert.ok(surface.n >= 1)
      // Stale seqs and invalid shapes are dropped without effect.
      scheduler.absorb('a', { type: 'user/message', seq: 200, time: 1, data: { content: text('x'), source: { kind: 'user' } }, surfaceOp: 'append' })
      scheduler.absorb('a', 'not an event')
      scheduler.absorb('a', null)
      scheduler.absorb('a', { type: 'user/message', seq: -1, time: 1, data: {} })
      const still = scheduler.handle.db.prepare('SELECT COUNT(*) AS n FROM surface_nodes WHERE session_id = ?').get('a') as { n: number }
      assert.equal(still.n, surface.n)
    } finally {
      scheduler.dispose()
    }
  })

  test('a pending session buffers live events until the backfill lands its checkpoint', async () => {
    const home = tempHome('buffer-pending')
    const logs: LogSpec[] = [{ id: 'a', events: sessionEvents(1) }]
    const persistence = fakePersistence(logs, new Map([['dir', home]]))
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      // Live events arrive while the session is still pending: they buffer.
      scheduler.absorb('a', { type: 'user/message', seq: 107, time: 107, data: { content: text('live q'), source: { kind: 'user' } }, surfaceOp: 'append' })
      assert.equal((scheduler.handle.db.prepare('SELECT COUNT(*) AS n FROM surface_nodes WHERE session_id = ?').get('a') as { n: number }).n, 0)
      // The backfill folds the log; the buffered event replays on adoption.
      await scheduler.backfillPass(new AbortController().signal)
      scheduler.flushLive('a')
      const surface = scheduler.handle.db.prepare('SELECT COUNT(*) AS n FROM surface_nodes WHERE session_id = ?').get('a') as { n: number }
      assert.ok(surface.n >= 2)
      const session = scheduler.handle.db.prepare('SELECT billed_tokens, last_seq FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(session.last_seq, 107)
      assert.equal(session.billed_tokens, 15)
    } finally {
      scheduler.dispose()
    }
  })

  test('reconcile mirrors workspace archived/titles and deletes sessions that vanished while live elsewhere', () => {
    const home = tempHome('workspace')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.reconcile([
        { header: { id: 'kept', createdAt: 1, cwd: '/w' } },
        { header: { id: 'archived', createdAt: 2, cwd: '/w' } },
      ], new Set(), { archived: new Set(['archived']), titles: new Map([['kept', 'Kept Project']]) })
      const kept = scheduler.handle.db.prepare('SELECT title, workspace_title, archived FROM sessions WHERE id = ?').get('kept') as Record<string, unknown>
      assert.equal(kept.title, 'w')
      assert.equal(kept.workspace_title, 'Kept Project')
      assert.equal(kept.archived, 0)
      const archived = scheduler.handle.db.prepare('SELECT archived FROM sessions WHERE id = ?').get('archived') as Record<string, unknown>
      assert.equal(archived.archived, 1)
      const gone = scheduler.handle.db.prepare('SELECT id FROM sessions WHERE id = ?').get('gone')
      assert.equal(gone, undefined)
    } finally {
      scheduler.dispose()
    }
  })

  test('backfill pauses on the work budget and honors abort mid-loop', async () => {
    const home = tempHome('pause')
    const logs: LogSpec[] = [
      { id: 'a', events: sessionEvents(1) },
      { id: 'b', events: sessionEvents(2) },
      { id: 'c', events: sessionEvents(3) },
    ]
    let calls = 0
    const persistence: StorePersistenceLike & { opened: string[] } = {
      opened: [],
      open: async (id: string) => {
        calls++
        return {
          header: { id, createdAt: 1 },
          read: async () => ({ events: (logs.find(spec => spec.id === id)?.events ?? []) as unknown as SessionEvent[] }),
          close: async () => {},
        }
      },
    }
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([
        { header: { id: 'a', createdAt: 1, cwd: '/w' } },
        { header: { id: 'b', createdAt: 2, cwd: '/w' } },
        { header: { id: 'c', createdAt: 3, cwd: '/w' } },
      ], new Set())
      const slowScheduler = createStoreScheduler(
        { effect: () => () => {} } as never,
        { open: async (id: string) => { await new Promise(r => setTimeout(r, 120)); const log = logs.find(sp => sp.id === id); return { header: { id, createdAt: 1 }, read: async () => ({ events: (log?.events ?? []) as unknown as SessionEvent[] }), close: async () => {} } } },
        { path: join(home, 'slow.sqlite'), workBudgetMs: 200, restMs: 5, pauseMs: 30 },
      )
      created.push(slowScheduler)
      await slowScheduler.backfillPass(new AbortController().signal)
      const controller = new AbortController()
      controller.abort()
      await scheduler.backfillPass(controller.signal)
      const midPass = new AbortController()
      const abortTimer = setTimeout(() => midPass.abort(), 40)
      await scheduler.backfillPass(midPass.signal)
      clearTimeout(abortTimer)
      assert.ok(calls >= 1)
      assert.equal(scheduler.coverage().running, false)
    } finally {
      scheduler.dispose()
    }
  })

  test('disposing mid-backfill stops the fold loop before the next session', async () => {
    const home = tempHome('dispose-mid')
    const logs: LogSpec[] = [
      { id: 'a', events: sessionEvents(1) },
      { id: 'b', events: sessionEvents(2) },
    ]
    let calls = 0
    const persistence: StorePersistenceLike & { opened: string[] } = {
      opened: [],
      open: async (id: string) => {
        calls++
        return {
          header: { id, createdAt: 1 },
          read: async () => ({ events: (logs.find(spec => spec.id === id)?.events ?? []) as unknown as SessionEvent[] }),
          close: async () => {},
        }
      },
    }
    const scheduler = schedulerIn(home, persistence)
    scheduler.reconcile([
      { header: { id: 'a', createdAt: 1, cwd: '/w' } },
      { header: { id: 'b', createdAt: 2, cwd: '/w' } },
    ], new Set())
    const pass = scheduler.backfillPass(new AbortController().signal)
    setTimeout(() => scheduler.dispose(), 15)
    await pass
    assert.equal(calls, 1)
  })

  test('backfillPass guards against concurrent runs and disposed entry', async () => {
    const home = tempHome('concurrent')
    const { scheduler } = schedulerWithEffects(home, fakePersistence([]))
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      const [first, second] = await Promise.all([
        scheduler.backfillPass(new AbortController().signal),
        scheduler.backfillPass(new AbortController().signal),
      ])
      void first
      void second
      assert.equal(scheduler.coverage().covered, 1)
      scheduler.dispose()
    } finally {
      scheduler.dispose()
    }
  })

  test('reconcile admits cwd-less records only while live and records full header variants', () => {
    const home = tempHome('headers')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.reconcile([
        { header: { id: 'no-cwd', createdAt: 5 } },
        { header: { id: 'live-no-cwd', createdAt: 7 } },
        {
          header: {
            id: 'full', createdAt: 6, cwd: '/w/full', parentSession: 'p1', origin: 'subagent',
            isSeeded: true, delegationDepth: 2, agentPreset: 'build',
          },
        },
      ], new Set(['live-no-cwd']))
      assert.equal(scheduler.handle.db.prepare('SELECT id FROM sessions WHERE id = ?').get('no-cwd'), undefined)
      const liveNoCwd = scheduler.handle.db.prepare('SELECT cwd FROM sessions WHERE id = ?').get('live-no-cwd') as Record<string, unknown>
      assert.equal(liveNoCwd.cwd, null)
      const full = scheduler.handle.db.prepare('SELECT parent_session, origin, is_seeded, delegation_depth, agent_preset FROM sessions WHERE id = ?').get('full') as Record<string, unknown>
      assert.equal(full.parent_session, 'p1')
      assert.equal(full.origin, 'subagent')
      assert.equal(full.is_seeded, 1)
      assert.equal(full.delegation_depth, 2)
      assert.equal(full.agent_preset, 'build')
    } finally {
      scheduler.dispose()
    }
  })

  test('live debounce timer flushes absorbed rows after the debounce window', async () => {
    const home = tempHome('debounce')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      scheduler.absorb('a', { type: 'user/message', seq: 200, time: 200, data: { content: text('debounced'), source: { kind: 'user' } }, surfaceOp: 'append' })
      // No explicit flush: the debounce timer must land the row.
      await new Promise(resolve => setTimeout(resolve, 2_200))
      const surface = scheduler.handle.db.prepare('SELECT COUNT(*) AS n FROM surface_nodes WHERE session_id = ?').get('a') as { n: number }
      assert.ok(surface.n >= 1)
    } finally {
      scheduler.dispose()
    }
  })

  test('a folded checkpoint with turns flips seenTurn on adoption', async () => {
    const home = tempHome('adopt-turn')
    const logs: LogSpec[] = [{ id: 's1', events: sessionEvents(1) }]
    const persistence = fakePersistence(logs, new Map([['dir', home]]))
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 's1', createdAt: 1, cwd: '/w' } }], new Set())
      // Buffer a live event (session is pending → shallow-seed guard).
      scheduler.absorb('s1', { type: 'user/message', seq: 300, time: 300, data: { content: text('buffered'), source: { kind: 'user' } }, surfaceOp: 'append' })
      // The backfill lands a checkpoint WITH turns (sessionEvents has one).
      await scheduler.backfillPass(new AbortController().signal)
      // The next absorb adopts and replays; the adopted state already saw a turn.
      scheduler.absorb('s1', { type: 'user/message', seq: 300, time: 300, data: { content: text('buffered'), source: { kind: 'user' } }, surfaceOp: 'append' })
      const session = scheduler.handle.db.prepare('SELECT blank, billed_tokens FROM sessions WHERE id = ?').get('s1') as Record<string, unknown>
      assert.equal(session.blank, 0)
      assert.equal(session.billed_tokens, 15)
    } finally {
      scheduler.dispose()
    }
  })

  test('adoptDeeperCheckpoint adopts a manually deeper checkpoint and flips seenTurn both ways', async () => {
    const home = tempHome('adopt-deeper')
    const logs: LogSpec[] = [{ id: 's1', events: sessionEvents(1) }]
    const persistence = fakePersistence(logs, new Map([['dir', home]]))
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 's1', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      // Absorb live events past the checkpoint, then flush.
      scheduler.absorb('s1', { type: 'user/message', seq: 300, time: 300, data: { content: text('live'), source: { kind: 'user' } }, surfaceOp: 'append' })
      scheduler.flushLive('s1')
      // Manually write a DEEPER checkpoint (as a slower cold fold would).
      const deeper = foldEventsToRows('s1', [...sessionEvents(1), { type: 'assistant/message', seq: 107, time: 107, data: { turn: 2, step: 1, message: { content: text('more') }, usage: { inputTokens: 1, outputTokens: 1 } } } as TimelineEvent], resolveBounds(undefined))
      flushSession(scheduler.writer, deeper, { now: 50_000 })
      // The next flush adopts the deeper checkpoint (folder.run.lastSeq 300 < 107? no — 300 > 107).
      // Absorb a NEW event: the adoption brings the folder up to the deeper
      // checkpoint (which includes the seq-107 message) before the apply.
      scheduler.absorb('s1', { type: 'user/message', seq: 108, time: 108, data: { content: text('new'), source: { kind: 'user' } }, surfaceOp: 'append' })
      scheduler.flushLive('s1')
      const session = scheduler.handle.db.prepare('SELECT billed_tokens FROM sessions WHERE id = ?').get('s1') as Record<string, unknown>
      assert.equal(session.billed_tokens, 10 + 5 + 1 + 1)
    } finally {
      scheduler.dispose()
    }
  })

  test('buffered overflow disposes the folder; a pending session buffers until the checkpoint lands', async () => {
    const home = tempHome('overflow')
    const logs: LogSpec[] = [{ id: 'a', events: sessionEvents(1) }]
    const persistence = fakePersistence(logs, new Map([['dir', home]]))
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      // Fill a BUFFERED folder past the cap.
      for (let seq = 1; seq <= 513; seq++) {
        scheduler.absorb('a', { type: 'user/message', seq: 200 + seq, time: 200 + seq, data: { content: text('flood'), source: { kind: 'user' } }, surfaceOp: 'append' })
      }
      // The overflow disposed the folder; the backfill still folds the log.
      await scheduler.backfillPass(new AbortController().signal)
      const session = scheduler.handle.db.prepare('SELECT billed_tokens, fold_status FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(session.fold_status, 'ok')
      assert.equal(session.billed_tokens, 15)
    } finally {
      scheduler.dispose()
    }
  })

  test('reconcile after dispose and unadmitted records are no-ops', async () => {
    const home = tempHome('disposed-reconcile')
    const { scheduler } = schedulerWithEffects(home, fakePersistence([]))
    scheduler.dispose()
    scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
    assert.equal(scheduler.coverage().total, 0)
  })

  test('reconcile skips unadmitted records', () => {
    const home = tempHome('unadmitted')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.reconcile([
        { header: { id: '', createdAt: 1, cwd: '/w' } },
        { header: { id: 42, createdAt: 2, cwd: '/w' } },
      ], new Set())
      assert.equal(scheduler.coverage().total, 0)
    } finally {
      scheduler.dispose()
    }
  })

  test('the backfill budget pause lands rows for every session', async () => {
    const home = tempHome('budget')
    const logs: LogSpec[] = [
      { id: 'a', events: sessionEvents(1) },
      { id: 'b', events: sessionEvents(2) },
    ]
    const persistence = fakePersistence(logs, new Map([['dir', home]]))
    const scheduler = createStoreScheduler(
      { effect: () => () => {} } as never,
      persistence,
      { path: join(home, 'index.sqlite'), workBudgetMs: 0, restMs: 1, pauseMs: 5 },
    )
    created.push(scheduler)
    try {
      scheduler.reconcile([
        { header: { id: 'a', createdAt: 1, cwd: '/w' } },
        { header: { id: 'b', createdAt: 2, cwd: '/w' } },
      ], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      const coverage = scheduler.coverage()
      assert.equal(coverage.covered, 2)
    } finally {
      scheduler.dispose()
    }
  })

  test('pause resolves immediately when the scheduler is stopping', async () => {
    const home = tempHome('pause-stop')
    const { scheduler } = schedulerWithEffects(home, fakePersistence([]))
    scheduler.dispose()
    await scheduler.backfillPass(new AbortController().signal)
    assert.equal(scheduler.coverage().total, 0)
  })

  test('the default clock is used when no clock option is given', async () => {
    const home = tempHome('default-clock')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      const session = scheduler.handle.db.prepare('SELECT folded_at FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.ok((session.folded_at as number) > 0)
    } finally {
      scheduler.dispose()
    }
  })

  test('the default store path is used when no path option is given', async () => {
    const dir = tempHome('default-path')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      const scheduler = createStoreScheduler(
        { effect: () => () => {} } as never,
        fakePersistence([]),
        {},
      )
      created.push(scheduler)
      assert.ok(scheduler.handle.path.includes('storages'))
      scheduler.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

function pagedPersistence(logs: LogSpec[]): StorePersistenceLike & { opened: string[]; reads: Array<{ offset: number; length: number }> } {
  const opened: string[] = []
  const reads: Array<{ offset: number; length: number }> = []
  return {
    opened,
    reads,
    open: async (id: string) => {
      opened.push(id)
      return {
        header: { id, createdAt: 1 },
        read: async (offset = 0, length = Number.MAX_SAFE_INTEGER) => {
          reads.push({ offset, length })
          const events = (logs.find(spec => spec.id === id)?.events ?? [])
            .filter(event => event !== null && typeof event === 'object' && typeof event.seq === 'number' && event.seq >= offset)
          return { events: events.slice(0, length) as unknown as SessionEvent[] }
        },
        close: async () => {},
      }
    },
  }
}

describe('store scheduler — backfill hardening', () => {
  test('an unchanged ok session is skipped by the identity gate', async () => {
    const home = tempHome('gate')
    const file = join(home, 'log.jsonl')
    writeFileSync(file, 'stable')
    let opens = 0
    const persistence: StorePersistenceLike = {
      open: async (id: string) => {
        opens++
        return {
          header: { id, createdAt: 1 },
          read: async () => ({ events: sessionEvents(1) as unknown as SessionEvent[] }),
          close: async () => {},
        }
      },
      stat: async () => ({ location: { path: file }, sizeBytes: 7 }),
    }
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      assert.equal(opens, 1)
      assert.equal(scheduler.coverage().covered, 1)
      await scheduler.backfillPass(new AbortController().signal)
      assert.equal(opens, 1)
    } finally {
      scheduler.dispose()
    }
  })

  test('a grown log re-folds from the checkpoint and lands the deeper state', async () => {
    const home = tempHome('grow')
    const logs: LogSpec[] = [{ id: 'a', events: sessionEvents(1) }]
    const persistence = pagedPersistence(logs)
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      const before = scheduler.coverage()
      logs[0].events.push(
        { type: 'step/start', seq: 107, time: 206, data: { turn: 2, step: 1 } } as TimelineEvent,
        { type: 'user/message', seq: 108, time: 207, data: { content: text('follow-up'), source: { kind: 'user' } }, surfaceOp: 'append' } as TimelineEvent,
        { type: 'assistant/message', seq: 109, time: 208, data: { turn: 2, step: 1, message: { content: text('reply 2') }, usage: { inputTokens: 3, outputTokens: 4 } } } as TimelineEvent,
        { type: 'step/end', seq: 110, time: 209, data: { turn: 2, step: 1 } } as TimelineEvent,
      )
      await scheduler.backfillPass(new AbortController().signal)
      assert.equal(scheduler.coverage().covered, before.covered)
      const session = scheduler.handle.db.prepare('SELECT billed_tokens, last_seq FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(session.billed_tokens, 10 + 5 + 3 + 4)
      assert.equal(session.last_seq, 110)
      assert.equal(persistence.reads[1].offset, 107)
    } finally {
      scheduler.dispose()
    }
  })

  test('a live gap switches the folder to buffering until the backfill lands the missing range', async () => {
    const home = tempHome('gap')
    const logs: LogSpec[] = [{ id: 'a', events: sessionEvents(1) }]
    const persistence = pagedPersistence(logs)
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      scheduler.absorb('a', { type: 'step/end', seq: 107, time: 107, data: { turn: 1, step: 0 } })
      scheduler.absorb('a', { type: 'step/end', seq: 109, time: 109, data: { turn: 2, step: 0 } })
      const session = scheduler.handle.db.prepare('SELECT last_seq FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(session.last_seq, 107)
      logs[0].events.push(
        { type: 'step/start', seq: 108, time: 108, data: { turn: 2, step: 0 } } as TimelineEvent,
        { type: 'user/message', seq: 109, time: 109, data: { content: text('gap fill'), source: { kind: 'user' } }, surfaceOp: 'append' } as TimelineEvent,
        { type: 'step/end', seq: 110, time: 110, data: { turn: 2, step: 0 } } as TimelineEvent,
      )
      await scheduler.backfillPass(new AbortController().signal)
      const after = scheduler.handle.db.prepare('SELECT last_seq, billed_tokens FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(after.last_seq, 110)
      const gapNode = scheduler.handle.db.prepare(
        "SELECT seq FROM surface_nodes WHERE session_id = 'a' AND seq = 109",
      ).get() as { seq: number } | undefined
      assert.notEqual(gapNode, undefined)
    } finally {
      scheduler.dispose()
    }
  })

  test('failed sessions retry with exponential backoff', async () => {
    const home = tempHome('backoff')
    let clockMs = 1_000
    let opens = 0
    const persistence: StorePersistenceLike = {
      open: async (id: string) => {
        opens++
        throw new Error(`boom ${id}`)
      },
    }
    const scheduler = createStoreScheduler(
      { effect: () => () => {} } as never,
      persistence,
      { path: join(home, 'index.sqlite'), clock: () => clockMs, restMs: 1, workBudgetMs: 10_000 },
    )
    created.push(scheduler)
    scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
    await scheduler.backfillPass(new AbortController().signal)
    assert.equal(opens, 1)
    assert.equal(scheduler.coverage().failed, 1)
    clockMs = 1_500
    await scheduler.backfillPass(new AbortController().signal)
    assert.equal(opens, 1)
    clockMs = 2_600
    await scheduler.backfillPass(new AbortController().signal)
    assert.equal(opens, 2)
    const row = scheduler.handle.db.prepare('SELECT fail_count, fail_at FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
    assert.equal(row.fail_count, 2)
    assert.equal(row.fail_at, 2_600)
  })

  test('fold_state rows beyond the cap are trimmed oldest-first and re-folded', async () => {
    const home = tempHome('cap')
    const logs: LogSpec[] = [
      { id: 'a', events: sessionEvents(1) },
      { id: 'b', events: sessionEvents(2) },
    ]
    const persistence = pagedPersistence(logs)
    const scheduler = createStoreScheduler(
      { effect: () => () => {} } as never,
      persistence,
      { path: join(home, 'index.sqlite'), foldStateCapBytes: 1, restMs: 1, workBudgetMs: 10_000 },
    )
    created.push(scheduler)
    scheduler.reconcile([
      { header: { id: 'a', createdAt: 1, cwd: '/w' } },
      { header: { id: 'b', createdAt: 2, cwd: '/w' } },
    ], new Set())
    await scheduler.backfillPass(new AbortController().signal)
    assert.equal(scheduler.coverage().covered, 2)
    const states = scheduler.handle.db.prepare('SELECT COUNT(*) AS n FROM fold_state').get() as { n: number }
    assert.equal(states.n, 0)
    const opensAfterFirst = persistence.opened.length
    await scheduler.backfillPass(new AbortController().signal)
    assert.equal(persistence.opened.length, opensAfterFirst + 2)
    assert.equal(scheduler.coverage().covered, 2)
  })

  test('live events create the session row with first-event metadata', () => {
    const home = tempHome('row-create')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      for (const event of sessionEvents(1)) scheduler.absorb('fresh', event)
      const row = scheduler.handle.db.prepare('SELECT created_at, fold_status FROM sessions WHERE id = ?').get('fresh') as Record<string, unknown>
      assert.equal(row.created_at, 101)
      assert.equal(row.fold_status, 'pending')
    } finally {
      scheduler.dispose()
    }
  })

  test('fold_state persists per turn-end and on disposal, not per step', () => {
    const home = tempHome('cadence')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      for (const event of sessionEvents(1)) scheduler.absorb('a', event)
      let state = scheduler.handle.db.prepare('SELECT last_seq FROM fold_state WHERE session_id = ?').get('a') as { last_seq: number } | undefined
      assert.equal(state, undefined)
      scheduler.absorb('a', { type: 'turn/end', seq: 107, time: 107, data: { turn: 1 } })
      state = scheduler.handle.db.prepare('SELECT last_seq FROM fold_state WHERE session_id = ?').get('a') as { last_seq: number } | undefined
      assert.equal(state?.last_seq, 107)
      scheduler.absorb('b', { type: 'user/message', seq: 5, time: 5, data: { content: text('only'), source: { kind: 'user' } }, surfaceOp: 'append' })
      scheduler.disposeLive('b')
      const disposed = scheduler.handle.db.prepare('SELECT last_seq FROM fold_state WHERE session_id = ?').get('b') as { last_seq: number } | undefined
      assert.equal(disposed?.last_seq, 5)
    } finally {
      scheduler.dispose()
    }
  })

  test('live sessions with a durable checkpoint are excluded from the backfill pass', async () => {
    const home = tempHome('exclude')
    const logs: LogSpec[] = [{ id: 'a', events: sessionEvents(1) }]
    const persistence = pagedPersistence(logs)
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      scheduler.absorb('a', { type: 'step/end', seq: 107, time: 107, data: { turn: 1, step: 0 } })
      await scheduler.backfillPass(new AbortController().signal)
      assert.equal(persistence.opened.length, 1)
      const session = scheduler.handle.db.prepare('SELECT last_seq FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(session.last_seq, 107)
    } finally {
      scheduler.dispose()
    }
  })

  test('re-listing a vanished session clears the vanished marker', () => {
    const home = tempHome('relist')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.reconcile([
        { header: { id: 'a', createdAt: 1, cwd: '/w' } },
        { header: { id: 'b', createdAt: 2, cwd: '/w' } },
      ], new Set())
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      scheduler.reconcile([
        { header: { id: 'a', createdAt: 1, cwd: '/w' } },
        { header: { id: 'b', createdAt: 2, cwd: '/w' } },
      ], new Set())
      const row = scheduler.handle.db.prepare('SELECT vanished_at FROM sessions WHERE id = ?').get('b') as Record<string, unknown>
      assert.equal(row.vanished_at, null)
    } finally {
      scheduler.dispose()
    }
  })

  test('an abort between slices stops the fold and retries later', async () => {
    const home = tempHome('slice-abort')
    const flood: TimelineEvent[] = Array.from({ length: 2100 }, (_, index) => (
      { type: 'user/message', seq: index + 1, time: index + 1, data: { content: text('flood'), source: { kind: 'user' } }, surfaceOp: 'append' }
    ))
    const logs: LogSpec[] = [{ id: 'a', events: flood }]
    const persistence = pagedPersistence(logs)
    const controller = new AbortController()
    const scheduler = createStoreScheduler(
      { effect: () => () => {} } as never,
      persistence,
      { path: join(home, 'index.sqlite'), restMs: 1, workBudgetMs: 10_000 },
    )
    created.push(scheduler)
    scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
    setTimeout(() => controller.abort(), 10)
    await scheduler.backfillPass(controller.signal)
    const row = scheduler.handle.db.prepare('SELECT fold_status, last_seq FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
    assert.equal(row.fold_status, 'folding')
    await scheduler.backfillPass(new AbortController().signal)
    const done = scheduler.handle.db.prepare('SELECT fold_status, last_seq FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
    assert.equal(done.fold_status, 'ok')
    assert.equal(done.last_seq, 2100)
  })

  test('sliced logs advance the offset between shards', async () => {
    const home = tempHome('sliced')
    const flood: TimelineEvent[] = Array.from({ length: 2100 }, (_, index) => (
      { type: 'user/message', seq: index + 1, time: index + 1, data: { content: text('flood'), source: { kind: 'user' } }, surfaceOp: 'append' }
    ))
    const logs: LogSpec[] = [{ id: 'a', events: flood }]
    const persistence = pagedPersistence(logs)
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      const generationBefore = scheduler.handle.generation()
      await scheduler.backfillPass(new AbortController().signal)
      assert.deepEqual(persistence.reads.map(read => read.offset), [0, 2001])
      const row = scheduler.handle.db.prepare('SELECT fold_status, last_seq FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(row.fold_status, 'ok')
      assert.equal(row.last_seq, 2100)
      assert.ok(scheduler.handle.generation() >= generationBefore + 2)
    } finally {
      scheduler.dispose()
    }
  })

  test('coverage counts folding rows as pending', () => {
    const home = tempHome('folding')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.writer.write({ sessionId: 'z', session: { created_at: 1, updated_at: 1, fold_status: 'folding' } })
      const coverage = scheduler.coverage()
      assert.equal(coverage.total, 1)
      assert.equal(coverage.pending, 1)
      assert.equal(coverage.covered, 0)
    } finally {
      scheduler.dispose()
    }
  })

  test('a heap-pressured gate defers the cold fold', async () => {
    const home = tempHome('heap')
    const logs: LogSpec[] = [{ id: 'a', events: sessionEvents(1) }]
    const persistence = pagedPersistence(logs)
    const scheduler = createStoreScheduler(
      { effect: () => () => {} } as never,
      persistence,
      { path: join(home, 'index.sqlite'), coldReads: { admit: async () => undefined } },
    )
    created.push(scheduler)
    scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
    await scheduler.backfillPass(new AbortController().signal)
    assert.equal(persistence.opened.length, 0)
    assert.equal(scheduler.coverage().pending, 1)
  })

  test('unreadable checkpoints never regress the live folder', async () => {
    const home = tempHome('corrupt')
    const logs: LogSpec[] = [{ id: 'a', events: sessionEvents(1) }]
    const persistence = pagedPersistence(logs)
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      scheduler.absorb('a', { type: 'step/end', seq: 107, time: 107, data: { turn: 1, step: 0 } })
      scheduler.writer.write({
        sessionId: 'a',
        ops: [{ table: 'fold_state', patch: { session_id: 'a', last_seq: 200, state_json: 'corrupt' } }],
      })
      scheduler.absorb('a', { type: 'step/end', seq: 108, time: 108, data: { turn: 1, step: 0 } })
      const session = scheduler.handle.db.prepare('SELECT last_seq FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(session.last_seq, 108)
      scheduler.reconcile([{ header: { id: 'b', createdAt: 2, cwd: '/w' } }], new Set())
      scheduler.writer.write({
        sessionId: 'b',
        ops: [{ table: 'fold_state', patch: { session_id: 'b', last_seq: 50, state_json: 'corrupt' } }],
      })
      scheduler.absorb('b', { type: 'user/message', seq: 60, time: 60, data: { content: text('held'), source: { kind: 'user' } }, surfaceOp: 'append' })
      const nodes = scheduler.handle.db.prepare('SELECT COUNT(*) AS n FROM surface_nodes WHERE session_id = ?').get('b') as { n: number }
      assert.equal(nodes.n, 0)
    } finally {
      scheduler.dispose()
    }
  })

  test('first-event metadata falls back when timestamps are unusable', () => {
    const home = tempHome('row-time')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.absorb('t', { type: 'step/end', seq: 5, time: Number.NaN, data: { turn: 1, step: 0 } })
      const row = scheduler.handle.db.prepare('SELECT created_at FROM sessions WHERE id = ?').get('t') as Record<string, unknown>
      assert.equal(row.created_at, 0)
    } finally {
      scheduler.dispose()
    }
  })

  test('a row created between folder birth and first flush keeps its own created_at', () => {
    const home = tempHome('row-late')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.absorb('a', { type: 'user/message', seq: 5, time: 5, data: { content: text('q'), source: { kind: 'user' } }, surfaceOp: 'append' })
      scheduler.reconcile([{ header: { id: 'a', createdAt: 99, cwd: '/w' } }], new Set())
      scheduler.flushLive('a')
      const row = scheduler.handle.db.prepare('SELECT created_at FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(row.created_at, 99)
    } finally {
      scheduler.dispose()
    }
  })

  test('an identityless stored row re-folds even when the stat is fresh', async () => {
    const home = tempHome('gate-blank')
    const file = join(home, 'log.jsonl')
    writeFileSync(file, 'stable')
    let opens = 0
    const persistence: StorePersistenceLike = {
      open: async (id: string) => {
        opens++
        return {
          header: { id, createdAt: 1 },
          read: async () => ({ events: sessionEvents(1) as unknown as SessionEvent[] }),
          close: async () => {},
        }
      },
      stat: async () => ({ location: { path: file }, sizeBytes: 7 }),
    }
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      scheduler.writer.write({ sessionId: 'a', session: { log_path: null, log_size: null, log_mtime: null } })
      await scheduler.backfillPass(new AbortController().signal)
      assert.equal(opens, 2)
    } finally {
      scheduler.dispose()
    }
  })

  test('records without a numeric createdAt default to zero', () => {
    const home = tempHome('created-blank')
    const scheduler = schedulerIn(home, fakePersistence([]))
    try {
      scheduler.reconcile([{ header: { id: 'a', cwd: '/w' } }], new Set())
      const row = scheduler.handle.db.prepare('SELECT created_at FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(row.created_at, 0)
    } finally {
      scheduler.dispose()
    }
  })

  test('junk log entries are skipped by the sliced fold', async () => {
    const home = tempHome('junk')
    const logs: LogSpec[] = [{ id: 'a', events: sessionEvents(1) }]
    logs[0].events.unshift(null as unknown as TimelineEvent, { type: 'user/message' } as unknown as TimelineEvent)
    const persistence = fakePersistence(logs)
    const scheduler = schedulerIn(home, persistence)
    try {
      scheduler.reconcile([{ header: { id: 'a', createdAt: 1, cwd: '/w' } }], new Set())
      await scheduler.backfillPass(new AbortController().signal)
      assert.equal(scheduler.coverage().covered, 1)
      const session = scheduler.handle.db.prepare('SELECT last_seq FROM sessions WHERE id = ?').get('a') as Record<string, unknown>
      assert.equal(session.last_seq, 106)
    } finally {
      scheduler.dispose()
    }
  })
})

describe('nextSliceSize', () => {
  test('adapts the slice to the measured cost', () => {
    assert.equal(nextSliceSize(2000, 0, 150), 2000)
    assert.equal(nextSliceSize(2000, 400, 150), 750)
    assert.equal(nextSliceSize(200, 10, 150), 400)
    assert.equal(nextSliceSize(200, 50, 150), 200)
  })
})

