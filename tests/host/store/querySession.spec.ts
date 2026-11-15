import assert from 'node:assert/strict'
import { afterAll, describe, test } from 'vitest'
import { StoreWriter, type RowOp } from '../../../src/host/store/writer'
import {
  ALL, DAY_MS, FILES_DAY, NOW, T0, disposeQueryFixtures, openQueryFixture, seededFixture,
} from '../helpers/queryFixture'

afterAll(() => {
  disposeQueryFixtures()
})

describe('query routes — context', () => {
  test('returns the current composition, counts, timing, systems and epochs', async () => {
    const { post, handle } = seededFixture()
    const out = await post('context', { sessionId: 'root' }) as { value: Record<string, unknown> }
    const value = out.value
    const row = handle.db.prepare("SELECT detail_rev, cur_total FROM sessions WHERE id = 'root'").get() as Record<string, number>
    assert.equal(value.rev, row.detail_rev)
    assert.equal(value.cur_total, row.cur_total)
    assert.deepEqual((value.cur_parts as Array<{ key: string }>).map(part => part.key), ['system', 'tools', 'user', 'assistant', 'tool'])
    const counts = value.counts as Record<string, unknown>
    assert.equal(counts.turns, 1)
    assert.equal(counts.steps, 1)
    assert.equal(counts.injects, 0)
    assert.equal(counts.compactions, 0)
    assert.equal(counts.prunes, 0)
    assert.equal(counts.skills, 0)
    assert.equal(value.last_user, 'trailing 1')
    assert.equal(value.model, 'deepseek-v4')
    assert.equal(value.provider, 'deepseek')
    assert.equal(value.context_window, 128000)
    assert.equal(value.max_output_tokens, 8192)
    const timing = value.timing as Record<string, unknown>
    assert.equal(timing.calls, 2)
    assert.equal(timing.toolCalls, 1)
    assert.ok((timing.wallMs as number) > 0)
    assert.ok((timing.toolsMs as number) > 0)
    assert.ok((timing.toolBusyMs as number) > 0)
    const systems = value.systems as Array<Record<string, unknown>>
    assert.equal(systems.length, 1)
    assert.ok((systems[0].tokens as number) > 0)
    const epochs = value.epochs as Array<Record<string, unknown>>
    assert.equal(epochs.length, 1)
    assert.equal(epochs[0].seq, 2)
    assert.equal((epochs[0].tools as Array<Record<string, unknown>>).length, 1)
    assert.equal((epochs[0].tools as Array<Record<string, unknown>>)[0].name, 'bash')
    const costRead = value.cost_read as Record<string, unknown>
    assert.equal(costRead.ready, true)
    assert.ok((costRead.usd as number) > 0)
  })

  test('skill session counts injects, skills and timing gates', async () => {
    const { post } = seededFixture()
    const out = await post('context', { sessionId: 'skill' }) as { value: Record<string, unknown> }
    const counts = out.value.counts as Record<string, unknown>
    assert.equal(counts.injects, 1)
    assert.equal(counts.compactions, 1)
    assert.equal(counts.skills, 1)
    assert.equal(counts.turns, 1)
    assert.equal(counts.steps, 0)
    assert.equal(counts.prunes, 0)
    assert.deepEqual((out.value.cur_parts as Array<{ key: string }>).map(part => part.key), ['user', 'skill', 'assistant'])
    assert.equal(out.value.fold_status, 'ok')
    assert.equal(out.value.last_user, 'follow-up')
    assert.equal(out.value.model, 'deepseek-v4-flash')
    assert.equal(out.value.max_output_tokens, undefined)
    assert.equal(out.value.reasoning_effort, undefined)
  })

  test('stream session timing carries decode fields and speed', async () => {
    const { post } = seededFixture()
    const out = await post('context', { sessionId: 'stream' }) as { value: Record<string, unknown> }
    const timing = out.value.timing as Record<string, unknown>
    assert.equal(timing.calls, 1)
    assert.equal(timing.toolCalls, 0)
    assert.equal(timing.ttftMs, 3000)
    assert.equal(timing.genMs, 3000)
    assert.equal(timing.speedTokens, 2)
    assert.equal(timing.speedMs, 3000)
    assert.equal(timing.reasoningMs, 1000)
    assert.equal(timing.reasoningBlocks, 1)
    assert.equal(timing.textMs, 1500)
    assert.equal(timing.textBlocks, 1)
    assert.equal(timing.toolsMs, 0)
    assert.equal(timing.idleMs, undefined)
    assert.equal(timing.toolArgMs, 500)
    assert.equal(timing.toolArgBlocks, 1)
    assert.deepEqual(timing.tools, {})
    assert.ok((timing.wallMs as number) > 0)
  })

  test('detailRev without a string sessionId runs the route', async () => {
    const { post } = seededFixture()
    const out = await post('context', { detailRev: 4 }) as { error: { code: string; message: string } }
    assert.deepEqual(out.error, { code: 'dsh-context/bad-request', message: 'missing sessionId' })
  })

  test('unknown sessions return null and missing sessionId fails', async () => {
    const { post } = seededFixture()
    assert.equal((await post('context', { sessionId: 'missing' }) as { value: unknown }).value, null)
    assert.equal((await post('context', {}) as { error: { message: string } }).error.message, 'missing sessionId')
  })

  test('unsupported fold status carries the fold error', async () => {
    const fixture = openQueryFixture()
    new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
      .write({ sessionId: 'old', session: { created_at: 1, fold_status: 'unsupported', fold_error: 'legacy format' } })
    const out = await fixture.post('context', { sessionId: 'old' }) as { value: Record<string, unknown> }
    assert.equal(out.value.fold_status, 'unsupported')
    assert.equal(out.value.fold_error, 'legacy format')
    assert.equal(out.value.timing, null)
  })
})

describe('query routes — timeline', () => {
  test('returns the tail window with pinned overflow and dropped totals', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 't', session: { created_at: 1 } })
    const ops: RowOp[] = []
    for (let seq = 1; seq <= 6; seq++) {
      ops.push({ table: 'surface_nodes', patch: {
        session_id: 't', seq, time: seq, cat: seq === 2 ? 'inject' : seq === 4 ? 'skill' : 'user',
        tokens: 10, calls: seq === 2 ? '["a","b"]' : null, preview: `node ${seq}`,
      } })
    }
    ops.push({ table: 'surface_nodes', patch: { session_id: 't', seq: 7, time: 7, cat: 'user', tokens: 10, gone_seq: 8 } })
    writer.write({ sessionId: 't', ops })
    const out = await fixture.post('timeline', { sessionId: 't', limit: 3 }) as { value: Record<string, unknown> }
    const value = out.value
    assert.deepEqual((value.nodes as Array<Record<string, unknown>>).map(node => node.seq), [2, 4, 5, 6])
    assert.equal(value.dropped_total, 2)
    assert.equal(value.surface_floor, 3)
    const first = (value.nodes as Array<Record<string, unknown>>)[0]
    assert.deepEqual(first.calls, ['a', 'b'])
    assert.deepEqual((value.archive as Array<Record<string, unknown>>).map(node => node.seq), [7])
  })

  test('archive cursor pages through gone nodes', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 'a', session: { created_at: 1 } })
    const ops: RowOp[] = []
    for (let seq = 1; seq <= 5; seq++) {
      ops.push({ table: 'surface_nodes', patch: { session_id: 'a', seq, time: seq, cat: 'user', tokens: 10, gone_seq: seq * 10 } })
    }
    writer.write({ sessionId: 'a', ops })
    const page1 = await fixture.post('timeline', { sessionId: 'a', limit: 1, archive: { limit: 2 } }) as { value: Record<string, unknown> }
    assert.deepEqual((page1.value.archive as Array<Record<string, unknown>>).map(node => node.gone), [40, 50])
    assert.equal(page1.value.archive_floor, 40)
    const page2 = await fixture.post('timeline', { sessionId: 'a', archive: { before_gone: 40, limit: 2 } }) as { value: Record<string, unknown> }
    assert.deepEqual((page2.value.archive as Array<Record<string, unknown>>).map(node => node.gone), [20, 30])
    assert.equal(page2.value.archive_floor, 20)
  })

  test('seq time travel views the as-of node set', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 's', session: { created_at: 1 } })
    writer.write({ sessionId: 's', ops: [
      { table: 'surface_nodes', patch: { session_id: 's', seq: 1, time: 1, cat: 'user', tokens: 10 } },
      { table: 'surface_nodes', patch: { session_id: 's', seq: 2, time: 2, cat: 'user', tokens: 10, gone_seq: 3 } },
      { table: 'surface_nodes', patch: { session_id: 's', seq: 3, time: 3, cat: 'user', tokens: 10 } },
      { table: 'surface_nodes', patch: { session_id: 's', seq: 4, time: 4, cat: 'user', tokens: 10 } },
    ] })
    const out = await fixture.post('timeline', { sessionId: 's', seq: 3, limit: 10 }) as { value: Record<string, unknown> }
    assert.deepEqual((out.value.nodes as Array<Record<string, unknown>>).map(node => node.seq), [1, 3])
    assert.deepEqual((out.value.archive as Array<Record<string, unknown>>).map(node => node.seq), [2])
    const later = await fixture.post('timeline', { sessionId: 's', seq: 2, limit: 10 }) as { value: Record<string, unknown> }
    assert.deepEqual((later.value.nodes as Array<Record<string, unknown>>).map(node => node.seq), [1, 2])
    assert.deepEqual(later.value.archive as unknown[], [])
  })

  test('surface node fields map through', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 'm', session: { created_at: 1 } })
    writer.write({ sessionId: 'm', ops: [
      { table: 'surface_nodes', patch: {
        session_id: 'm', seq: 1, time: 5, cat: 'assistant', tokens: 30, reasoning_tokens: 3, answer_tokens: 4,
        call_tokens: 5, imgs: 2, form: 'answer', name: 'nm', agent: 'ag', tool: 'tl', skill: 'sk', is_error: 1,
        calls: '["x"]', preview: 'text', gone_seq: 9,
      } },
    ] })
    const out = await fixture.post('timeline', { sessionId: 'm', limit: 10 }) as { value: { archive: Array<Record<string, unknown>> } }
    assert.deepEqual(out.value.archive[0], {
      seq: 1, time: 5, cat: 'assistant', tokens: 30, reasoning: 3, answerTokens: 4, callTokens: 5,
      imgs: 2, form: 'answer', name: 'nm', agent: 'ag', tool: 'tl', skill: 'sk', err: true,
      calls: ['x'], text: 'text', gone: 9,
    })
  })

  test('archive object and limit validation', async () => {
    const { post } = seededFixture()
    assert.equal((await post('timeline', { sessionId: 'root', archive: 5 }) as { error: { message: string } }).error.message, 'archive must be an object')
    assert.equal((await post('timeline', { sessionId: 'root', limit: 501 }) as { error: { message: string } }).error.message, 'limit must be between 1 and 500')
  })
})

describe('query routes — requests', () => {
  test('lists session requests newest-first with cursor and offsetFromEnd', async () => {
    const { post } = seededFixture()
    const out = await post('requests', { sessionId: 'root', limit: 2 }) as { value: { requests: Array<Record<string, unknown>>; total: number; cursor: number } }
    assert.equal(out.value.total, 2)
    assert.deepEqual(out.value.requests.map(row => row.seq), [7, 11])
    assert.equal(out.value.cursor, 7)
    const page1 = await post('requests', { sessionId: 'root', limit: 1 }) as { value: { requests: Array<Record<string, unknown>>; cursor: number } }
    assert.deepEqual(page1.value.requests.map(row => row.seq), [11])
    assert.equal(page1.value.cursor, 11)
    const rest = await post('requests', { sessionId: 'root', limit: 2, cursor: 11 }) as { value: { requests: Array<Record<string, unknown>> } }
    assert.deepEqual(rest.value.requests.map(row => row.seq), [7])
    const fromEnd = await post('requests', { sessionId: 'root', limit: 1, offsetFromEnd: 1 }) as { value: { requests: Array<Record<string, unknown>> } }
    assert.deepEqual(fromEnd.value.requests.map(row => row.seq), [7])
    const record = out.value.requests[1] as Record<string, unknown>
    assert.equal(record.starts_turn, false)
    assert.equal(record.input_tokens, 4)
    assert.equal(record.output_tokens, 2)
    assert.equal(record.provider, 'deepseek')
    assert.ok((record.total_tokens as number) > 0)
  })

  test('turn, day and model filters apply; scope mode aggregates across families', async () => {
    const { post } = seededFixture()
    const turn = await post('requests', { sessionId: 'root', turn: 1, limit: 1 }) as { value: { total: number } }
    assert.equal(turn.value.total, 2)
    const model = await post('requests', { sessionId: 'root', model: 'deepseek-v4', limit: 1 }) as { value: { requests: unknown[] } }
    assert.equal(model.value.requests.length, 1)
    const day = await post('requests', { sessionId: 'root', day: '1999-01-01' }) as { value: { requests: unknown[] } }
    assert.deepEqual(day.value.requests, [])
    const scope = await post('requests', { scope: { ...ALL }, limit: 3 }) as { value: { requests: Array<Record<string, unknown>>; total: number } }
    assert.equal(scope.value.total, 7)
    assert.equal(scope.value.requests.length, 3)
  })


  test('scope-mode requests honor turn, day and model together', async () => {
    const { post } = seededFixture()
    const out = await post('requests', { scope: { ...ALL }, turn: 1, day: '1999-01-01', model: 'deepseek-v4', limit: 3 }) as { value: { requests: unknown[]; total: number } }
    assert.deepEqual(out.value.requests, [])
    assert.equal(out.value.total, 0)
  })

  test('requests arg validation', async () => {
    const { post } = seededFixture()
    assert.equal((await post('requests', {}) as { error: { message: string } }).error.message, 'requests requires sessionId or scope')
    assert.equal((await post('requests', { sessionId: 'root', scope: {} }) as { error: { message: string } }).error.message, 'requests takes sessionId or scope, not both')
    assert.equal((await post('requests', { sessionId: 'root', cursor: 5, offsetFromEnd: 1 }) as { error: { message: string } }).error.message, 'cursor and offsetFromEnd are mutually exclusive')
  })
})

describe('query routes — steps', () => {
  test('lists step rows and counts only ended steps', async () => {
    const { post } = seededFixture()
    const out = await post('steps', { sessionId: 'root' }) as { value: { steps: Array<Record<string, unknown>>; total: number } }
    assert.equal(out.value.total, 1)
    assert.equal(out.value.steps.length, 1)
    const step = out.value.steps[0]
    assert.equal(step.seq, 5)
    assert.equal(step.turn, 1)
    assert.equal(step.step, 0)
    assert.equal(step.end_time !== undefined, true)
    assert.ok((step.wall_ms as number) > 0)
    assert.ok((step.active_ms as number) > 0)
    assert.equal(step.ttft_ms, undefined)
    assert.equal(step.request_seq, 7)
    assert.equal(step.beats_full, false)
  })

  test('cursor pages and open steps do not count', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 'st', session: { created_at: 1 } })
    writer.write({ sessionId: 'st', ops: [
      { table: 'steps', patch: { session_id: 'st', seq: 1, start_time: 10, end_time: 20, wall_ms: 10, active_ms: 10, wait_ms: 0, idle_ms: 0, tool_busy_ms: 0, turn: 1, step: 0, request_seq: 2 } },
      { table: 'steps', patch: { session_id: 'st', seq: 2, start_time: 30, turn: 2, step: 0 } },
    ] })
    const out = await fixture.post('steps', { sessionId: 'st' }) as { value: { steps: Array<Record<string, unknown>>; total: number } }
    assert.equal(out.value.total, 1)
    assert.deepEqual(out.value.steps.map(step => step.seq), [1, 2])
    const paged = await fixture.post('steps', { sessionId: 'st', limit: 1, cursor: 2 }) as { value: { steps: Array<Record<string, unknown>> } }
    assert.deepEqual(paged.value.steps.map(step => step.seq), [1])
  })

  test('steps arg validation', async () => {
    const { post } = seededFixture()
    assert.equal((await post('steps', {}) as { error: { message: string } }).error.message, 'missing sessionId')
  })
})

describe('query routes — tool-calls', () => {
  test('lists calls with command fields', async () => {
    const { post } = seededFixture()
    const out = await post('tool-calls', { sessionId: 'files' }) as { value: { calls: Array<Record<string, unknown>>; total: number } }
    assert.equal(out.value.total, 4)
    assert.deepEqual(out.value.calls.map(call => call.seq), [12, 10, 8, 6])
    const bash = out.value.calls[1]
    assert.equal(bash.tool, 'bash')
    assert.equal(bash.cmd, 'boom')
    assert.equal(bash.status, 'failed')
    assert.equal(bash.err, true)
    assert.equal(bash.program === undefined, true)
    assert.equal(bash.start, T0 + 10 * DAY_MS + 8)
    assert.equal(bash.end, T0 + 10 * DAY_MS + 9)
    assert.equal(bash.turn, 1)
  })

  test('status, program, query, sort and before_seq filters', async () => {
    const { post } = seededFixture()
    const failed = await post('tool-calls', { sessionId: 'files', status: 'failed' }) as { value: { calls: Array<Record<string, unknown>>; total: number } }
    assert.equal(failed.value.total, 1)
    assert.deepEqual(failed.value.calls.map(call => call.seq), [10])
    const slow = await post('tool-calls', { sessionId: 'files', status: 'slow' }) as { value: { calls: unknown[]; total: number } }
    assert.deepEqual(slow.value.calls, [])
    const background = await post('tool-calls', { sessionId: 'files', status: 'background' }) as { value: { calls: unknown[] } }
    assert.deepEqual(background.value.calls, [])
    const program = await post('tool-calls', { sessionId: 'root', program: 'ls' }) as { value: { calls: Array<Record<string, unknown>> } }
    assert.deepEqual(program.value.calls.map(call => call.seq), [8])
    const query = await post('tool-calls', { sessionId: 'files', query: 'BOOM' }) as { value: { calls: Array<Record<string, unknown>> } }
    assert.deepEqual(query.value.calls.map(call => call.seq), [10])
    const slowest = await post('tool-calls', { sessionId: 'files', sort: 'slowest' }) as { value: { calls: Array<Record<string, unknown>> } }
    assert.deepEqual(slowest.value.calls.map(call => call.seq), [12, 10, 8, 6])
    const paged = await post('tool-calls', { sessionId: 'files', before_seq: 10 }) as { value: { calls: Array<Record<string, unknown>>; total: number } }
    assert.deepEqual(paged.value.calls.map(call => call.seq), [8, 6])
    assert.equal(paged.value.total, 4)
  })

  test('scope mode spans matched families', async () => {
    const { post } = seededFixture()
    const out = await post('tool-calls', { scope: { ...ALL } }) as { value: { total: number } }
    assert.equal(out.value.total, 6)
    const root = await post('tool-calls', { scope: { ...ALL }, program: 'ls' }) as { value: { total: number } }
    assert.equal(root.value.total, 2)
  })

  test('tool-calls arg validation', async () => {
    const { post } = seededFixture()
    assert.equal((await post('tool-calls', {}) as { error: { message: string } }).error.message, 'tool-calls requires sessionId or scope')
    assert.equal((await post('tool-calls', { sessionId: 'root', scope: {} }) as { error: { message: string } }).error.message, 'tool-calls takes sessionId or scope, not both')
    assert.equal((await post('tool-calls', { sessionId: 'root', status: 'weird' }) as { error: { message: string } }).error.message, 'unknown status')
    assert.equal((await post('tool-calls', { sessionId: 'root', sort: 'weird' }) as { error: { message: string } }).error.message, 'unknown sort')
    assert.equal((await post('tool-calls', { sessionId: 'root', query: 'x'.repeat(501) }) as { error: { message: string } }).error.message, 'query must contain at most 500 characters')
  })
})

describe('query routes — file-ops', () => {
  test('list mode returns file op records', async () => {
    const { post } = seededFixture()
    const out = await post('file-ops', { sessionId: 'files', mode: 'list' }) as { value: { ops: Array<Record<string, unknown>>; total: number } }
    assert.equal(out.value.total, 2)
    assert.deepEqual(out.value.ops.map(op => op.path), ['/repo/a.ts', '/repo/b.ts'])
    const read = out.value.ops[0]
    assert.equal(read.kind, 'read')
    assert.equal(read.tool, 'read')
    assert.equal(read.err, false)
    assert.equal(read.added, 0)
    assert.equal(read.removed, 0)
    const write = out.value.ops[1]
    assert.equal(write.kind, 'write')
    assert.equal(write.added, 2)
    assert.equal(write.removed, 0)
    const paged = await post('file-ops', { sessionId: 'files', mode: 'list', cursor: 8 }) as { value: { ops: Array<Record<string, unknown>> } }
    assert.deepEqual(paged.value.ops.map(op => op.seq), [7])
  })

  test('paths mode aggregates by path', async () => {
    const { post } = seededFixture()
    const out = await post('file-ops', { sessionId: 'files', mode: 'paths' }) as { value: { paths: Array<Record<string, unknown>> } }
    assert.deepEqual(out.value.paths, [
      { path: '/repo/a.ts', count: 1, added: 0, removed: 0, last: T0 + 10 * DAY_MS + 5, err: false },
      { path: '/repo/b.ts', count: 1, added: 2, removed: 0, last: T0 + 10 * DAY_MS + 7, err: false },
    ])
  })

  test('kind filter applies in both modes', async () => {
    const { post } = seededFixture()
    const list = await post('file-ops', { sessionId: 'files', mode: 'list', kind: 'read' }) as { value: { ops: Array<Record<string, unknown>> } }
    assert.deepEqual(list.value.ops.map(op => op.path), ['/repo/a.ts'])
    const paths = await post('file-ops', { sessionId: 'files', mode: 'paths', kind: 'write' }) as { value: { paths: Array<Record<string, unknown>> } }
    assert.deepEqual(paths.value.paths.map(row => row.path), ['/repo/b.ts'])
  })

  test('file-ops arg validation', async () => {
    const { post } = seededFixture()
    assert.equal((await post('file-ops', {}) as { error: { message: string } }).error.message, 'missing sessionId')
    assert.equal((await post('file-ops', { sessionId: 'root' }) as { error: { message: string } }).error.message, 'unknown mode')
    assert.equal((await post('file-ops', { sessionId: 'root', mode: 'list', kind: 'weird' }) as { error: { message: string } }).error.message, 'unknown kind')
  })
})

describe('query routes — events', () => {
  test('lists events with kinds filter and turn spans', async () => {
    const { post } = seededFixture()
    const out = await post('events', { sessionId: 'skill' }) as { value: { events: Array<Record<string, unknown>>; total: number } }
    assert.equal(out.value.total, 3)
    assert.deepEqual(out.value.events.map(event => event.kind), ['inject', 'compaction', 'mode'])
    const compaction = out.value.events.find(event => event.kind === 'compaction') as Record<string, unknown>
    assert.equal(compaction.tokens, 12)
    assert.equal(compaction.count, 1)
    assert.equal(compaction.turn, undefined)
    assert.equal(compaction.fromTurn, 1)
    assert.equal(compaction.fromStep, 0)
    const inject = out.value.events.find(event => event.kind === 'inject') as Record<string, unknown>
    assert.equal(inject.sub, 'skill')
    assert.equal(inject.name, 'code-review')
    const kinds = await post('events', { sessionId: 'skill', kinds: ['compaction'] }) as { value: { events: Array<Record<string, unknown>> } }
    assert.deepEqual(kinds.value.events.map(event => event.kind), ['compaction'])
    const none = await post('events', { sessionId: 'root' }) as { value: { events: unknown[]; total: number } }
    assert.deepEqual(none.value.events, [])
  })

  test('cursor and kinds validation', async () => {
    const { post } = seededFixture()
    const paged = await post('events', { sessionId: 'skill', kinds: ['inject', 'compaction', 'mode'], cursor: 7 }) as { value: { events: Array<Record<string, unknown>> } }
    assert.deepEqual(paged.value.events.map(event => event.seq), [4, 6])
    assert.equal((await post('events', { sessionId: 'root', kinds: 'inject' }) as { error: { message: string } }).error.message, 'kinds must be an array of strings')
    assert.equal((await post('events', { sessionId: 'root', kinds: ['weird'] }) as { error: { message: string } }).error.message, 'unknown kind')
  })
})

describe('query routes — spans', () => {
  test('lists spans with cursor and total', async () => {
    const { post } = seededFixture()
    const out = await post('spans', { sessionId: 'stream' }) as { value: { spans: Array<Record<string, unknown>>; total: number } }
    assert.deepEqual(out.value.spans.map(span => span.kind), ['ttft', 'reasoning', 'text', 'toolarg', 'other'])
    assert.equal(out.value.total, 5)
    const tools = await post('spans', { sessionId: 'root' }) as { value: { spans: Array<Record<string, unknown>>; total: number } }
    assert.deepEqual(tools.value.spans.map(span => span.kind), ['other', 'tools', 'other'])
    const paged = await post('spans', { sessionId: 'stream', before: 2 }) as { value: { spans: Array<Record<string, unknown>> } }
    assert.deepEqual(paged.value.spans.map(span => span.kind), ['ttft', 'reasoning'])
  })
})

describe('query routes — skill-loads', () => {
  test('lists loads in session and scope modes', async () => {
    const { post } = seededFixture()
    const out = await post('skill-loads', { sessionId: 'skill' }) as { value: { loads: Array<Record<string, unknown>>; total: number } }
    assert.equal(out.value.total, 1)
    assert.deepEqual(out.value.loads, [{
      session_id: 'skill', seq: 4, time: T0 + 5 * DAY_MS + 2, day: FILES_DAY === undefined ? undefined : out.value.loads[0].day, name: 'code-review', source: 'invocation',
    }])
    const scope = await post('skill-loads', { scope: { ...ALL } }) as { value: { loads: Array<Record<string, unknown>>; total: number } }
    assert.equal(scope.value.total, 1)
    const named = await post('skill-loads', { scope: { ...ALL }, name: 'nope' }) as { value: { loads: unknown[] } }
    assert.deepEqual(named.value.loads, [])
    const day = await post('skill-loads', { scope: { ...ALL }, day: '1999-01-01' }) as { value: { loads: unknown[] } }
    assert.deepEqual(day.value.loads, [])
  })

  test('skill-loads arg validation', async () => {
    const { post } = seededFixture()
    assert.equal((await post('skill-loads', {}) as { error: { message: string } }).error.message, 'skill-loads requires sessionId or scope')
    assert.equal((await post('skill-loads', { sessionId: 'root', scope: {} }) as { error: { message: string } }).error.message, 'skill-loads takes sessionId or scope, not both')
  })
})

describe('query routes — family', () => {
  test('resolves the root from a member and orders members breadth-first', async () => {
    const { post } = seededFixture()
    const out = await post('family', { sessionId: 'sub' }) as { value: { members: Array<Record<string, unknown>>; totals: Record<string, unknown> } }
    assert.deepEqual(out.value.members.map(member => member.id), ['root', 'sub'])
    assert.deepEqual(out.value.members.map(member => member.depth), [0, 1])
    assert.deepEqual(out.value.members.map(member => member.order), [0, 1])
    const root = out.value.members[0]
    assert.equal(root.title, 'root')
    assert.equal(root.running, true)
    assert.equal(root.origin, undefined)
    assert.equal(root.billed_tokens, 20 + 6)
    assert.equal(root.calls, 2)
    assert.equal(typeof root.cost_usd, 'number')
    const sub = out.value.members[1]
    assert.equal(sub.origin, 'subagent')
    assert.equal(sub.billed_tokens, 20 + 6)
    assert.equal(out.value.totals.billed_tokens, (20 + 6) * 2)
    assert.equal(out.value.totals.calls, 4)
    assert.ok((out.value.totals.cost_usd as number) > 0)
  })

  test('rootId mode and missing sessions', async () => {
    const { post } = seededFixture()
    const out = await post('family', { rootId: 'root' }) as { value: { members: Array<Record<string, unknown>> } }
    assert.deepEqual(out.value.members.map(member => member.id), ['root', 'sub'])
    const unknownRoot = await post('family', { rootId: 'nope' }) as { value: { members: unknown[]; totals: Record<string, unknown> } }
    assert.deepEqual(unknownRoot.value.members, [])
    assert.equal(unknownRoot.value.totals.billed_tokens, 0)
    assert.deepEqual((await post('family', { sessionId: 'missing' }) as { value: { members: unknown[] } }).value.members, [])
    assert.equal((await post('family', {}) as { error: { message: string } }).error.message, 'family requires rootId or sessionId')
  })

  test('family costs are null without a book', async () => {
    const { post } = seededFixture({ pricing: () => null, now: () => NOW })
    const out = await post('family', { rootId: 'root' }) as { value: { members: Array<Record<string, unknown>>; totals: Record<string, unknown> } }
    assert.equal(out.value.members[0].cost_usd, undefined)
    assert.equal(out.value.totals.cost_usd, undefined)
  })
})

describe('query routes — cost', () => {
  test('session mode reports usage prices with faces and misses', async () => {
    const { post } = seededFixture()
    const out = await post('cost', { sessionId: 'root' }) as { value: Record<string, unknown> }
    assert.equal(out.value.ready, true)
    assert.ok((out.value.usd as number) > 0)
    const faces = out.value.faces as Array<Record<string, unknown>>
    assert.equal(faces.length, 1)
    assert.equal(faces[0].provider, 'deepseek')
    assert.equal(faces[0].model, 'deepseek-v4')
    assert.equal(faces[0].via, 'direct')
    assert.equal(faces[0].confidence, 'high')
    assert.equal(faces[0].canonical, 'deepseek-v4')
    assert.deepEqual(out.value.misses, [])
  })

  test('unpriced models land in misses; a missing book reports not ready', async () => {
    const { post } = seededFixture({ pricing: () => null, now: () => NOW })
    const out = await post('cost', { sessionId: 'root' }) as { value: Record<string, unknown> }
    assert.equal(out.value.ready, false)
    assert.equal(out.value.usd, null)
    assert.deepEqual(out.value.faces, [])
    assert.deepEqual(out.value.misses, [])
    const scope = await seededFixture().post('cost', { scope: { ...ALL } }) as { value: Record<string, unknown> }
    assert.equal(scope.value.ready, true)
    assert.ok((scope.value.usd as number) > 0)
  })

  test('cost arg validation', async () => {
    const { post } = seededFixture()
    assert.equal((await post('cost', {}) as { error: { message: string } }).error.message, 'cost requires sessionId or scope')
    assert.equal((await post('cost', { sessionId: 'root', scope: {} }) as { error: { message: string } }).error.message, 'cost takes sessionId or scope, not both')
  })
})

describe('query routes — status', () => {
  test('reports schema, generation, bytes, coverage and counts', async () => {
    const { post, handle } = seededFixture()
    const out = await post('status') as { value: Record<string, unknown> }
    const value = out.value
    assert.equal(value.schema_version, 2)
    assert.equal(value.generation, handle.generation())
    assert.equal(value.pricing_version, handle.pricingVersion())
    assert.equal(value.ready, true)
    assert.ok((value.db_bytes as number) > 0)
    const coverage = value.coverage as Record<string, unknown>
    assert.equal(coverage.total, 7)
    assert.equal(coverage.covered, 5)
    assert.equal(coverage.remaining, 2)
    assert.equal(coverage.failed, 0)
    assert.equal(coverage.unsupported, 0)
    assert.equal(coverage.complete, false)
    assert.equal(coverage.running, false)
    const counts = value.counts as Record<string, unknown>
    assert.equal(counts.sessions, 7)
    assert.equal(counts.requests, 7)
    assert.equal(counts.tool_calls, 6)
    assert.equal(counts.skill_loads, 1)
    assert.equal(counts.fold_state, 5)
    assert.equal(value.harness_supported, true)
  })

  test('harness_supported and backfill running come from deps', async () => {
    const { post } = seededFixture({
      harnessSupported: false,
      backfillRunning: () => true,
      now: () => NOW,
    })
    const out = await post('status') as { value: Record<string, unknown> }
    assert.equal(out.value.harness_supported, false)
    assert.equal((out.value.coverage as Record<string, unknown>).running, true)
  })

  test('ready is false without a book; failed and unsupported drive coverage', async () => {
    const fixture = openQueryFixture({ pricing: () => null, now: () => NOW })
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 'x', session: { created_at: 1, fold_status: 'failed' } })
    const out = await fixture.post('status') as { value: Record<string, unknown> }
    assert.equal(out.value.ready, false)
    const coverage = out.value.coverage as Record<string, unknown>
    assert.equal(coverage.failed, 1)
    assert.equal(coverage.complete, false)
    assert.equal(coverage.covered, 0)
  })
})

describe('query routes — coverage extras', () => {
  test('context surfaces reasoning_effort and fold_error mirrors', async () => {
    const fixture = openQueryFixture()
    new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
      .write({ sessionId: 'old', session: { created_at: 1, fold_status: 'failed', fold_error: 'boom', reasoning_effort: 'max' } })
    const out = await fixture.post('context', { sessionId: 'old' }) as { value: Record<string, unknown> }
    assert.equal(out.value.reasoning_effort, 'max')
    assert.equal(out.value.fold_status, 'failed')
    assert.equal(out.value.fold_error, 'boom')
  })

  test('timing gains idleMs when a step idled', async () => {
    const fixture = openQueryFixture()
    new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
      .write({ sessionId: 'idle', session: { created_at: 1 }, ops: [{ table: 'steps', patch: { session_id: 'idle', seq: 1, start_time: 10, end_time: 20, wall_ms: 10, active_ms: 4, wait_ms: 0, idle_ms: 6000, tool_busy_ms: 0 } }] })
    const out = await fixture.post('context', { sessionId: 'idle' }) as { value: { timing: Record<string, unknown> } }
    assert.equal(out.value.timing.idleMs, 6000)
  })

  test('file-ops list maps read windows, estimates and patterns', async () => {
    const fixture = openQueryFixture()
    new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
      .write({ sessionId: 'fops', session: { created_at: 1 }, ops: [
        { table: 'file_ops', patch: { session_id: 'fops', seq: 1, ordinal: 0, kind: 'read', tool: 'read', path: '/a', read_start: 5, read_count: 10 } },
        { table: 'file_ops', patch: { session_id: 'fops', seq: 2, ordinal: 0, kind: 'read', tool: 'read', path: '/b', read_count: 7, read_est: 1 } },
        { table: 'file_ops', patch: { session_id: 'fops', seq: 3, ordinal: 0, kind: 'search', tool: 'grep', path: '/c', is_pattern: 1, is_error: 1 } },
      ] })
    const out = await fixture.post('file-ops', { sessionId: 'fops', mode: 'list' }) as { value: { ops: Array<Record<string, unknown>> } }
    assert.deepEqual(out.value.ops[0].read, { start: 5, count: 10 })
    assert.deepEqual(out.value.ops[1].read, { count: 7, est: true })
    assert.equal(out.value.ops[2].pattern, true)
    assert.equal(out.value.ops[2].err, true)
    const paths = await fixture.post('file-ops', { sessionId: 'fops', mode: 'paths' }) as { value: { paths: Array<Record<string, unknown>> } }
    assert.equal(paths.value.paths[2].err, true)
  })

  test('cost reports misses for unpriced models and an empty read for sessions without usage', async () => {
    const fixture = openQueryFixture()
    new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
      .write({ sessionId: 'priced', session: { created_at: 1 }, ops: [{ table: 'requests', patch: { session_id: 'priced', seq: 1, time: 5, day: '2023-01-01', model: 'gpt-9', provider: 'openai', period: 'peak', input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 } }] })
    const out = await fixture.post('cost', { sessionId: 'priced' }) as { value: { usd: number | null; ready: boolean; faces: unknown[]; misses: Array<Record<string, unknown>> } }
    assert.equal(out.value.ready, true)
    assert.equal(out.value.usd, null)
    assert.deepEqual(out.value.faces, [])
    assert.equal(out.value.misses.length, 1)
    assert.equal(out.value.misses[0].model, 'gpt-9')
    assert.equal(out.value.misses[0].provider, 'openai')
    const empty = await fixture.post('cost', { sessionId: 'fresh' }) as { value: { usd: unknown; ready: boolean; faces: unknown[]; misses: unknown[] } }
    assert.equal(empty.value.ready, true)
    assert.equal(empty.value.usd, null)
    assert.deepEqual(empty.value.faces, [])
    assert.deepEqual(empty.value.misses, [])
    const summary = await fixture.post('summary', { scope: { range: { start: 0, end: 9_000_000_000_000 } }, parts: ['tokens'] }) as { value: Record<string, unknown> }
    assert.deepEqual(summary.value.token_parts, null)
  })

  test('tally honors coverage filters', async () => {
    const fixture = seededFixture()
    new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
      .write({ sessionId: 'skill', session: { archived: 1 } })
    const archived = await fixture.post('tally', { field: 'skills', scope: { coverage: 'archived', ...ALL } }) as { value: { stats: Array<Record<string, unknown>> } }
    assert.deepEqual(archived.value.stats.map(stat => stat.name), ['code-review'])
    const active = await fixture.post('tally', { field: 'skills', scope: { coverage: 'active', ...ALL } }) as { value: { stats: unknown[] } }
    assert.deepEqual(active.value.stats, [])
  })

  test('usage sessions counts zero-bucket sessions while cost sessions skips unpriced', async () => {
    const fixture = openQueryFixture()
    new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
      .write({ sessionId: 'zero', session: { created_at: 1, blank: 0 }, ops: [{ table: 'requests', patch: { session_id: 'zero', seq: 1, time: 5, day: '2023-01-01', model: 'deepseek-v4', provider: 'deepseek', period: 'peak', input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 } }] })
    const out = await fixture.post('summary', { scope: { range: { start: 0, end: 9_000_000_000_000 } }, parts: ['usage', 'tokens'] }) as { value: Record<string, unknown> }
    assert.equal(out.value.usage_sessions, 1)
    assert.equal(out.value.cost_sessions, 1)
    assert.equal(out.value.tokens, 0)
  })
})

describe('query routes — null provider and period buckets', () => {
  test('usage buckets normalize null providers and periods', async () => {
    const fixture = openQueryFixture()
    new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
      .write({ sessionId: 'anon', session: { created_at: 1, blank: 0 }, ops: [
        { table: 'requests', patch: { session_id: 'anon', seq: 1, time: 5, day: '2023-01-01', model: 'deepseek-v4', provider: null, period: null, input_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 2 } },
      ] })
    const summary = await fixture.post('summary', { scope: { range: { start: 0, end: 9_000_000_000_000 } }, parts: ['tokens', 'cost', 'usage'] }) as { value: Record<string, unknown> }
    assert.equal(summary.value.tokens, 6)
    assert.equal(summary.value.cost_usd, null)
    assert.equal(summary.value.cost_sessions, 0)
    assert.equal(summary.value.usage_sessions, 1)
    const cost = await fixture.post('cost', { sessionId: 'anon' }) as { value: { usd: number | null; faces: unknown[]; misses: Array<Record<string, unknown>> } }
    assert.deepEqual(cost.value.faces, [])
    assert.equal(cost.value.misses[0].reason, 'ambiguous')
    assert.equal(cost.value.misses[0].candidates, 2)
    assert.equal(cost.value.usd, null)
    const flash = await seededFixture().post('cost', { sessionId: 'skill' }) as { value: { faces: Array<Record<string, unknown>>; usd: number | null } }
    assert.equal(flash.value.faces[0].canonical, undefined)
    assert.equal(flash.value.faces[0].via, 'direct')
    assert.ok((flash.value.usd as number) > 0)
  })
})

describe('query routes — remaining coverage', () => {
  test('tool-call pages, null request fields, plugin tools, null days and empty spans', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 'meta', session: { created_at: 1 }, ops: [
      { table: 'tool_calls', patch: { session_id: 'meta', seq: 1, call_id: 'a', name: 'bash', start_time: 10, end_time: 12, duration_ms: 2, result_seq: 5, status: 'completed' } },
      { table: 'tool_calls', patch: { session_id: 'meta', seq: 2, call_id: 'b', name: 'read', start_time: 10, end_time: 12, duration_ms: 2, result_seq: 5, status: 'completed' } },
      { table: 'events', patch: { session_id: 'meta', seq: 1, time: 3, kind: 'inject', form: 'context', tokens: 4 } },
      { table: 'skill_loads', patch: { session_id: 'meta', seq: 1, time: 4, name: 'x', source: 'invocation' } },
      { table: 'header_epochs', patch: { session_id: 'meta', seq: 1, time: 2, tools_tokens: 3 } },
      { table: 'header_tools', patch: { session_id: 'meta', epoch_seq: 1, ordinal: 0, name: 'core', tokens: 2, plugin: 'core' } },
    ] })
    const paged = await fixture.post('tool-calls', { sessionId: 'meta', before_seq: 5 }) as { value: { calls: Array<Record<string, unknown>> } }
    assert.deepEqual(paged.value.calls.map(call => call.seq), [2, 1])
    const events = await fixture.post('events', { sessionId: 'meta' }) as { value: { events: Array<Record<string, unknown>> } }
    assert.deepEqual(events.value.events[0].turn, undefined)
    const context = await fixture.post('context', { sessionId: 'meta' }) as { value: { epochs: Array<Record<string, unknown>> } }
    assert.equal(((context.value.epochs as Array<Record<string, unknown>>)[0].tools as Array<Record<string, unknown>>)[0].plugin, 'core')
    const turns = await fixture.post('steps', { sessionId: 'meta' }) as { value: { total: number } }
    assert.equal(turns.value.total, 0)
  })

  test('a family member without usage renders a null cost', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 'nr', session: { created_at: 1, blank: 0 } })
    writer.write({ sessionId: 'nrs', session: { created_at: 2, parent_session: 'nr', origin: 'subagent', blank: 0 } })
    writer.write({ sessionId: 'nrs', ops: [{ table: 'requests', patch: { session_id: 'nrs', seq: 1, time: 3, turn: 1, model: null, provider: null, period: null, total_tokens: 0, system_tokens: 0, tools_tokens: 0, user_tokens: 0, inject_tokens: 0, skill_tokens: 0, assistant_tokens: 0, tool_tokens: 0, starts_turn: 1 } }] })
    const out = await fixture.post('family', { rootId: 'nr' }) as { value: { members: Array<Record<string, unknown>>; totals: Record<string, unknown> } }
    assert.equal(out.value.members[0].cost_usd, null)
    assert.equal(out.value.totals.cost_usd, 0)
    const parts = await fixture.post('summary', { scope: { range: { start: 0, end: 9_000_000_000_000 } }, parts: ['tokens'] }) as { value: Record<string, unknown> }
    assert.deepEqual(parts.value.token_parts, null)
  })

  test('cost with an empty scope reports an empty read', async () => {
    const fixture = seededFixture()
    const out = await fixture.post('cost', { scope: { range: { start: 0, end: 1 } } }) as { value: { usd: unknown; faces: unknown[]; misses: unknown[]; ready: boolean } }
    assert.equal(out.value.usd, null)
    assert.deepEqual(out.value.faces, [])
    assert.deepEqual(out.value.misses, [])
    assert.equal(out.value.ready, true)
  })
})

describe('query routes — missing optional fields', () => {
  test('null turn rows, running-status tools, scope cursor pages and empty aggregates', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 'loose', session: { created_at: 1 }, ops: [
      { table: 'events', patch: { session_id: 'loose', seq: 4, time: 4, kind: 'inject', form: 'context', tokens: 4 } },
      { table: 'events', patch: { session_id: 'loose', seq: 6, time: 6, kind: 'inject', form: 'context', tokens: 2 } },
      { table: 'requests', patch: { session_id: 'loose', seq: 5, time: 5, turn: null, step: null, total_tokens: 0, system_tokens: 0, tools_tokens: 0, user_tokens: 0, inject_tokens: 0, skill_tokens: 0, assistant_tokens: 0, tool_tokens: 0 } },
      { table: 'tool_calls', patch: { session_id: 'loose', seq: 2, call_id: 'x', name: 'bash', start_time: 10, result_seq: 5, status: null } },
      { table: 'skill_loads', patch: { session_id: 'loose', seq: 1, time: 2, name: 'x', source: 'invocation' } },
    ] })
    const events = await fixture.post('events', { sessionId: 'loose' }) as { value: { events: Array<Record<string, unknown>> } }
    assert.deepEqual(events.value.events.map(event => event.turn), [undefined, undefined])
    const requests = await fixture.post('requests', { sessionId: 'loose' }) as { value: { requests: Array<Record<string, unknown>> } }
    assert.deepEqual(requests.value.requests[0].turn, undefined)
    assert.deepEqual(requests.value.requests[0].step, undefined)
    const calls = await fixture.post('tool-calls', { sessionId: 'loose' }) as { value: { calls: Array<Record<string, unknown>> } }
    assert.equal(calls.value.calls[0].status, 'running')
    const context = await fixture.post('context', { sessionId: 'loose' }) as { value: { timing: Record<string, unknown> } }
    assert.equal(context.value.timing.calls, 1)
  })

  test('scope-mode tool-calls page through before_seq', async () => {
    const fixture = seededFixture()
    const out = await fixture.post('tool-calls', { scope: { ...ALL }, before_seq: 8 }) as { value: { calls: Array<Record<string, unknown>>; total: number } }
    assert.ok(out.value.calls.every(call => (call.seq as number) < 8))
    assert.equal(out.value.total, 6)
  })

  test('skill-loads omit null days and requests route skips cursor with empty page', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 'days', session: { created_at: 1 }, ops: [
      { table: 'skill_loads', patch: { session_id: 'days', seq: 1, time: 2, name: 'x', source: 'invocation' } },
      { table: 'skill_loads', patch: { session_id: 'days', seq: 2, time: 4, day: '2023-01-01', name: 'y', source: 'invocation' } },
    ] })
    const out = await fixture.post('skill-loads', { sessionId: 'days' }) as { value: { loads: Array<Record<string, unknown>> } }
    assert.deepEqual(out.value.loads.map(load => load.day), [undefined, '2023-01-01'])
  })
})

describe('query routes — tie-breaks and loose rows', () => {
  test('tally ties break by name; scope cursor pages; loose rows render', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 'ties', session: { created_at: 1, blank: 0 }, ops: [
      { table: 'tool_calls', patch: { session_id: 'ties', seq: 1, call_id: 'a', name: 'bash', start_time: 10, end_time: 20, duration_ms: 10, result_seq: 3, status: 'completed', day: '2023-01-01' } },
      { table: 'tool_calls', patch: { session_id: 'ties', seq: 2, call_id: 'b', name: 'read', start_time: 10, end_time: 20, duration_ms: 10, result_seq: 3, status: 'completed', day: '2023-01-01' } },
      { table: 'events', patch: { session_id: 'ties', seq: 1, time: 4, kind: 'inject', form: 'context', tokens: 4 } },
    ] })
    const tools = await fixture.post('tally', { field: 'tools', scope: { range: { start: 0, end: 9_000_000_000_000 } } }) as { value: { stats: Array<Record<string, unknown>> } }
    assert.deepEqual(tools.value.stats.map(stat => stat.name), ['bash', 'read'])
    const events = await fixture.post('events', { sessionId: 'ties' }) as { value: { events: Array<Record<string, unknown>> } }
    assert.equal(events.value.events[0].turn, undefined)
    const loose = await fixture.post('requests', { sessionId: 'loose' }) as { value: { requests: Array<Record<string, unknown>> } }
    void loose
  })

  test('scope-mode tool-calls and skill-loads honor cursors and null days', async () => {
    const fixture = seededFixture()
    const paged = await fixture.post('tool-calls', { scope: { ...ALL }, before_seq: 8 }) as { value: { calls: Array<Record<string, unknown>>; total: number } }
    assert.ok(paged.value.calls.every(call => (call.seq as number) < 8))
    assert.equal(paged.value.total, 6)
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 'dayless', session: { created_at: 1 }, ops: [
      { table: 'skill_loads', patch: { session_id: 'dayless', seq: 1, time: 2, name: 'x', source: 'invocation' } },
    ] })
    const loads = await fixture.post('skill-loads', { sessionId: 'dayless' }) as { value: { loads: Array<Record<string, unknown>> } }
    assert.equal(loads.value.loads[0].day, undefined)
  })
})

describe('query routes — cursor and tie edges', () => {
  test('skill-loads cursor pages, requests cursor on empty tail, family fallback and scope cursor', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 'c1', session: { created_at: 1 }, ops: [
      { table: 'skill_loads', patch: { session_id: 'c1', seq: 1, time: 2, day: '2023-01-01', name: 'a', source: 'invocation' } },
      { table: 'skill_loads', patch: { session_id: 'c1', seq: 2, time: 4, day: '2023-01-01', name: 'b', source: 'invocation' } },
    ] })
    const paged = await fixture.post('skill-loads', { sessionId: 'c1', limit: 1, cursor: 2 }) as { value: { loads: Array<Record<string, unknown>> } }
    assert.deepEqual(paged.value.loads.map(load => load.seq), [1])
    const empty = await fixture.post('requests', { sessionId: 'c1', cursor: 0 }) as { value: { requests: unknown[]; total: number } }
    assert.deepEqual(empty.value.requests, [])
    const family = await fixture.post('family', { sessionId: 'c1' }) as { value: { members: Array<Record<string, unknown>> } }
    assert.deepEqual(family.value.members.map(member => member.id), ['c1'])
    const scope = await seededFixture().post('skill-loads', { scope: { ...ALL }, cursor: 5 }) as { value: { loads: Array<Record<string, unknown>> } }
    assert.ok(scope.value.loads.every(load => (load.seq as number) < 5))
  })

  test('requests turn ties break with null steps and scope cursor pages', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 't2', session: { created_at: 1 }, ops: [
      { table: 'requests', patch: { session_id: 't2', seq: 1, time: 10, turn: 1, step: null, total_tokens: 0, system_tokens: 0, tools_tokens: 0, user_tokens: 0, inject_tokens: 0, skill_tokens: 0, assistant_tokens: 0, tool_tokens: 0 } },
      { table: 'requests', patch: { session_id: 't2', seq: 2, time: 10, turn: 1, step: null, total_tokens: 0, system_tokens: 0, tools_tokens: 0, user_tokens: 0, inject_tokens: 0, skill_tokens: 0, assistant_tokens: 0, tool_tokens: 0 } },
    ] })
    const out = await fixture.post('requests', { sessionId: 't2' }) as { value: { requests: Array<Record<string, unknown>> } }
    assert.deepEqual(out.value.requests.map(row => row.turn), [1, 1])
    assert.deepEqual(out.value.requests.map(row => row.step), [undefined, undefined])
  })
})

describe('query routes — family extras', () => {
  test('messages_total counts fleet messages and needs_history is validated', async () => {
    const fixture = openQueryFixture()
    const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    writer.write({ sessionId: 'fleet', session: { created_at: 1 }, ops: [
      { table: 'events', patch: { session_id: 'fleet', seq: 1, time: 1, kind: 'inject', name: 'agent-message', form: 'context', tokens: 4 } },
      { table: 'events', patch: { session_id: 'fleet', seq: 2, time: 2, kind: 'inject', name: 'agent-message', form: 'context', tokens: 4 } },
      { table: 'events', patch: { session_id: 'fleet', seq: 3, time: 3, kind: 'inject', name: 'team-message', form: 'context', tokens: 4 } },
      { table: 'events', patch: { session_id: 'fleet', seq: 4, time: 4, kind: 'inject', name: 'subagent-settled', form: 'context', tokens: 4 } },
      { table: 'events', patch: { session_id: 'fleet', seq: 5, time: 5, kind: 'inject', name: 'skill', sub: 'skill', form: 'instructions', tokens: 4 } },
      { table: 'events', patch: { session_id: 'fleet', seq: 6, time: 6, kind: 'inject', name: 'notice', form: 'notice', tokens: 4 } },
    ] })
    const out = await fixture.post('family', { rootId: 'fleet', needs_history: true }) as { value: { members: Array<Record<string, unknown>>; totals: Record<string, unknown> } }
    assert.equal(out.value.members[0].messages_total, 4)
    assert.equal(out.value.totals.messages_total, 4)
    const bad = await fixture.post('family', { rootId: 'fleet', needs_history: 'yes' }) as { error: { message: string } }
    assert.equal(bad.error.message, 'needs_history must be a boolean')
  })
})

describe('query routes — requests group_by turn', () => {
  test('session mode aggregates per turn; invalid group_by fails', async () => {
    const { post } = seededFixture()
    const out = await post('requests', { sessionId: 'root', group_by: 'turn' }) as { value: { requests: Array<Record<string, unknown>>; total: number } }
    assert.equal(out.value.total, 1)
    assert.deepEqual(out.value.requests, [{ turn: 1, n: 2, tokens: 26, gen_ms: 0, active_ms: 5 }])
    const bad = await post('requests', { sessionId: 'root', group_by: 'step' }) as { error: { message: string } }
    assert.equal(bad.error.message, 'unknown group_by')
  })

  test('scope mode aggregates per turn and honors cursor without grouping', async () => {
    const { post } = seededFixture()
    const out = await post('requests', { scope: { ...ALL }, group_by: 'turn' }) as { value: { requests: Array<Record<string, unknown>>; total: number } }
    assert.equal(out.value.total, 1)
    assert.equal(out.value.requests[0].turn, 1)
    assert.equal(out.value.requests[0].n, 7)
    assert.equal(out.value.requests[0].tokens, 70)
    const paged = await post('requests', { scope: { ...ALL }, cursor: 7, limit: 2 }) as { value: { requests: Array<Record<string, unknown>>; total: number } }
    assert.ok(paged.value.requests.every(row => (row.seq as number) < 7))
    assert.equal(paged.value.total, 3)
  })
})
