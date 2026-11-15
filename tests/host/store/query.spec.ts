import assert from 'node:assert/strict'
import { afterAll, describe, test } from 'vitest'
import { StoreWriter } from '../../../src/host/store/writer'
import { disposeQueryFixtures, idsOf, seededFixture, openQueryFixture, depsWith, ALL, DAY_MS, NOW, ROOT_DAY, SKILL_DAY, FILES_DAY, STREAM_DAY, T0, priceIndexOf, type ModelBook } from '../helpers/queryFixture'

afterAll(() => {
  disposeQueryFixtures()
})
describe('query routes — envelope', () => {
  test('replies with the uniform envelope shape', async () => {
    const { post } = seededFixture()
    const out = await post('status')
    assert.equal(out.ok, true)
    assert.equal(typeof out.generation, 'number')
    assert.equal(typeof out.pricing_version, 'number')
    assert.ok(out.value !== undefined)
  })

  test('a matching generation answers unchanged without running the route', async () => {
    const { post, handle } = seededFixture()
    const first = await post('sessions', { scope: ALL }) as { value: unknown }
    assert.ok(first.value !== undefined)
    const generation = handle.generation()
    assert.deepEqual(await post('status', { generation }), { ok: true, generation, unchanged: true })
    assert.deepEqual(await post('sessions', { generation }), { ok: true, generation, unchanged: true })
    assert.equal(handle.generation(), generation)
  })

  test('pricing_version participates in the gate in both directions', async () => {
    const { post, handle } = seededFixture()
    const generation = handle.generation()
    const pricing = handle.pricingVersion()
    assert.deepEqual(
      await post('status', { generation, pricing_version: pricing }),
      { ok: true, generation, unchanged: true },
    )
    const stale = await post('status', { generation, pricing_version: pricing + 1 }) as { value?: unknown }
    assert.ok(stale.value !== undefined)
  })

  test('a stale generation misses the gate', async () => {
    const { post, handle } = seededFixture()
    const out = await post('status', { generation: handle.generation() + 5 }) as { value?: unknown }
    assert.ok(out.value !== undefined)
  })

  test('session routes honor detailRev as a cache validator', async () => {
    const { post, handle } = seededFixture()
    const row = handle.db.prepare("SELECT detail_rev FROM sessions WHERE id = 'root'").get() as { detail_rev: number }
    assert.deepEqual(
      await post('context', { sessionId: 'root', detailRev: row.detail_rev }),
      { ok: true, generation: handle.generation(), unchanged: true },
    )
    const mismatch = await post('context', { sessionId: 'root', detailRev: row.detail_rev + 1 }) as { value?: unknown }
    assert.ok(mismatch.value !== undefined)
    const unknown = await post('context', { sessionId: 'missing', detailRev: row.detail_rev }) as { value?: unknown }
    assert.ok(unknown.value !== undefined)
  })

  test('non-JSON and non-object bodies fail with the error envelope', async () => {
    const fixture = seededFixture()
    assert.deepEqual(
      await fixture.rawPost('status', 'not json'),
      { ok: false, error: { code: 'dsh-context/bad-request', message: 'body is not JSON' } },
    )
    assert.deepEqual(
      await fixture.post('status', []),
      { ok: false, error: { code: 'dsh-context/bad-request', message: 'body must be an object' } },
    )
  })

  test('query errors return the error envelope', async () => {
    const { post } = seededFixture()
    assert.deepEqual(
      await post('summary', { scope: ALL, parts: ['nope'] }),
      { ok: false, error: { code: 'dsh-context/bad-request', message: 'unknown part' } },
    )
  })

  test('parameter caps reject over-limit values', async () => {
    const { post } = seededFixture()
    const over = await post('sessions', { pageSize: 501 }) as { error: { message: string } }
    assert.match(over.error.message, /between 1 and 500|at most 500|at most 256/)
    const long = await post('sessions', { scope: { query: 'x'.repeat(501) } }) as { error: { message: string } }
    assert.match(long.error.message, /between 1 and 500|at most 500|at most 256/)
    const many = await post('sessions', { ids: Array.from({ length: 257 }, (_, index) => `s${index}`) }) as { error: { message: string } }
    assert.match(many.error.message, /at most 256/)
    const zero = await post('steps', { sessionId: 'root', limit: 0 }) as { error: { message: string } }
    assert.match(zero.error.message, /between 1 and 500/)
    const junk = await post('steps', { sessionId: 'root', limit: 'x' }) as { error: { message: string } }
    assert.match(junk.error.message, /must be a number/)
  })

  test('route tables expose exactly the 16 query paths', () => {
    const { routes } = openQueryFixture()
    assert.deepEqual(
      routes.map(route => route.path).sort(),
      ['sessions', 'summary', 'days', 'tally', 'context', 'timeline', 'requests', 'steps', 'tool-calls',
        'file-ops', 'events', 'spans', 'skill-loads', 'family', 'cost', 'status']
        .map(path => `/api/dsh-context/query/${path}`)
        .sort(),
    )
  })
})

describe('query routes — sessions', () => {
  test('lists non-blank root sessions with family-merged tokens and own composition', async () => {
    const { post } = seededFixture()
    const out = await post('sessions', { scope: ALL }) as { value: { rows: Array<Record<string, unknown>>; total: number; scope_total: number; groups: Array<Record<string, unknown>> } }
    const value = out.value
    assert.deepEqual(idsOf(value), ['stream', 'files', 'skill', 'root'])
    assert.equal(value.total, 4)
    assert.equal(value.scope_total, 4)
    assert.deepEqual(value.groups, [
      { key: 'Root Project', count: 1 },
      { key: 'Skill Project', count: 1 },
      { key: '__ungrouped__', count: 2 },
    ])
    const root = value.rows.find(row => row.id === 'root') as Record<string, unknown>
    const skill = value.rows.find(row => row.id === 'skill') as Record<string, unknown>
    assert.equal(root.billed_tokens, (10 + 3 + 2 + 5 + 4 + 2) * 2)
    assert.equal(skill.billed_tokens, 10)
    assert.ok((root.cur_total as number) > 0)
    assert.deepEqual((root.cur_parts as Array<Record<string, unknown>>).map((part: Record<string, unknown>) => part.key), ['system', 'tools', 'user', 'assistant', 'tool'])
    assert.deepEqual((skill.cur_parts as Array<Record<string, unknown>>).map((part: Record<string, unknown>) => part.key), ['user', 'skill', 'assistant'])
    assert.equal(root.fold_status, 'ok')
    assert.equal(root.running, true)
    assert.equal(root.archived, false)
    assert.equal(root.cwd, '/repo/root')
    assert.equal(root.workspace_title, 'Root Project')
    assert.equal(root.model, 'deepseek-v4')
    assert.equal(root.context_window, 128000)
    assert.equal(root.max_output_tokens, 8192)
    assert.equal(root.last_user, 'trailing 1')
    assert.equal(root.turns, 1)
    assert.equal(root.steps, 1)
    assert.equal(root.created_day, ROOT_DAY)
    assert.equal(typeof root.cost_usd, 'number')
    assert.equal(typeof root.updated_at, 'number')
    assert.equal(root.origin, undefined)
  })

  test('excludes blank, unfolded and subagent rows; ids mode anchors explicitly', async () => {
    const { post } = seededFixture()
    const anchored = await post('sessions', { ids: ['root', 'blank', 'unfolded', 'sub', 'missing'] }) as { value: { rows: Array<Record<string, unknown>> } }
    assert.deepEqual(idsOf(anchored.value), ['blank', 'root', 'sub', 'unfolded'])
    const blank = anchored.value.rows.find(row => row.id === 'blank') as Record<string, unknown>
    assert.equal(blank.fold_status, 'pending')
    assert.equal(blank.cur_total, 0)
    const unfolded = anchored.value.rows.find(row => row.id === 'unfolded') as Record<string, unknown>
    assert.equal(unfolded.fold_status, 'pending')
    const vanished = await post('sessions', { ids: ['gone'] }) as { value: { rows: unknown[] } }
    assert.deepEqual(vanished.value.rows, [])
  })

  test('a vanished session row is hidden from both modes', async () => {
    const fixture = seededFixture()
    new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
      .write({ sessionId: 'stream', session: { vanished_at: NOW } })
    const listed = await fixture.post('sessions', {}) as { value: { rows: Array<{ id: string }> } }
    assert.ok(!listed.value.rows.map(row => row.id).includes('stream'))
    const anchored = await fixture.post('sessions', { ids: ['stream'] }) as { value: { rows: unknown[] } }
    assert.deepEqual(anchored.value.rows, [])
  })

  test('sort orders match recent, tokens and context; page clamps', async () => {
    const { post } = seededFixture()
    const all = await post('sessions', { scope: ALL }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(all.value), ['stream', 'files', 'skill', 'root'])
    const tokens = await post('sessions', { scope: ALL, sort: 'tokens' }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(tokens.value), ['root', 'skill', 'stream', 'files'])
    const context = await post('sessions', { scope: ALL, sort: 'context' }) as { value: { rows: Array<{ id: string }> } }
    assert.equal(context.value.rows[0].id, 'root')
    assert.deepEqual(idsOf(context.value).slice(1).sort(), ['files', 'skill', 'stream'].sort())
    const paged = await post('sessions', { scope: ALL, sort: 'recent', page: 9 }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(paged.value), ['stream', 'files', 'skill', 'root'])
    const sized = await post('sessions', { scope: ALL, sort: 'recent', pageSize: 2, page: 1 }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(sized.value), ['skill', 'root'])
  })

  test('coverage, group, running, model, query and day filters scope the rows', async () => {
    const { post, handle } = seededFixture()
    new StoreWriter(handle.db, () => handle.bumpGeneration())
      .write([{ sessionId: 'skill', session: { archived: 1 } }, { sessionId: 'files', session: { running: 1, workspace_title: null } }])
    const active = await post('sessions', { scope: { coverage: 'active', ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(active.value), ['stream', 'files', 'root'])
    const archived = await post('sessions', { scope: { coverage: 'archived', ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(archived.value), ['skill'])
    const running = await post('sessions', { scope: { running: true, ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(running.value), ['files', 'root'])
    const notRunning = await post('sessions', { scope: { running: false, ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(notRunning.value), ['stream', 'skill'])
    const model = await post('sessions', { scope: { model: 'deepseek-v4-flash', ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(model.value), ['skill'])
    const query = await post('sessions', { scope: { query: 'ROOT', ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(query.value), ['root'])
    const cwd = await post('sessions', { scope: { query: 'stream', ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(cwd.value), ['stream'])
    const group = await post('sessions', { scope: { group: 'Root Project', ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(group.value), ['root'])
    const ungrouped = await post('sessions', { scope: { group: '__ungrouped__', ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(ungrouped.value), ['stream', 'files'])
    const day = await post('sessions', { scope: { day: ROOT_DAY, ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(day.value), ['root'])
    const emptyDay = await post('sessions', { scope: { day: '1999-01-01' } }) as { value: { rows: unknown[] } }
    assert.deepEqual(emptyDay.value.rows, [])
    const window = await post('sessions', { scope: { range: { start: T0, end: T0 + 20_000 } } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(window.value), ['root'])
    const familyWindow = await post('sessions', { scope: { range: { start: T0 + 15 * DAY_MS, end: T0 + 15 * DAY_MS + 20_000 } } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(familyWindow.value), ['stream'])
  })

  test('pick filters find sessions by tally within the window', async () => {
    const { post } = seededFixture()
    const skills = await post('sessions', { scope: { pick: { field: 'skills', name: 'code-review' }, ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(skills.value), ['skill'])
    const tools = await post('sessions', { scope: { pick: { field: 'tools', name: 'bash' }, ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(tools.value), ['files', 'root'])
    const programs = await post('sessions', { scope: { pick: { field: 'programs', name: 'ls' }, ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(programs.value), ['root'])
    const pickDay = await post('sessions', { scope: { day: FILES_DAY, pick: { field: 'tools', name: 'bash' }, ...ALL } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(idsOf(pickDay.value), ['files'])
    const miss = await post('sessions', { scope: { pick: { field: 'skills', name: 'nope' }, ...ALL } }) as { value: { rows: unknown[] } }
    assert.deepEqual(miss.value.rows, [])
    const badPick = await post('sessions', { scope: { pick: { field: 'weird', name: 'x' } } }) as { error: { message: string } }
    assert.equal(badPick.error.message, 'unknown pick.field')
    const noName = await post('sessions', { scope: { pick: { field: 'skills' } } }) as { error: { message: string } }
    assert.equal(noName.error.message, 'missing pick.name')
  })

  test('groups follow the provided workspace titles before alphabetical order', async () => {
    const { post } = seededFixture(depsWith({ workspaceTitles: () => ['Skill Project', 'Other'] }))
    const out = await post('sessions', { scope: ALL }) as { value: { groups: Array<Record<string, unknown>> } }
    assert.deepEqual(out.value.groups, [
      { key: 'Skill Project', count: 1 },
      { key: 'Root Project', count: 1 },
      { key: '__ungrouped__', count: 2 },
    ])
  })

  test('unknown sort and coverage values fail', async () => {
    const { post } = seededFixture()
    assert.equal((await post('sessions', { sort: 'weird' }) as { error: { message: string } }).error.message, 'unknown sort')
    assert.equal((await post('sessions', { scope: { coverage: 'weird' } }) as { error: { message: string } }).error.message, 'unknown coverage')
    assert.equal((await post('sessions', { scope: { running: 'yes' } }) as { error: { message: string } }).error.message, 'running must be a boolean')
    assert.equal((await post('sessions', { scope: { pick: 5 } }) as { error: { message: string } }).error.message, 'pick must be an object')
    assert.equal((await post('sessions', { ids: 'root' }) as { error: { message: string } }).error.message, 'ids must be an array of strings')
  })

  test('subagent family members contribute billed tokens but not composition', async () => {
    const { post } = seededFixture()
    const out = await post('sessions', { ids: ['root', 'skill'] }) as { value: { rows: Array<Record<string, unknown>> } }
    const root = out.value.rows.find(row => row.id === 'root') as Record<string, unknown>
    const skill = out.value.rows.find(row => row.id === 'skill') as Record<string, unknown>
    assert.equal(root.billed_tokens, (10 + 3 + 2 + 5 + 4 + 2) * 2)
    assert.equal(skill.billed_tokens, 10)
    assert.deepEqual((root.cur_parts as Array<Record<string, unknown>>).map((part: Record<string, unknown>) => part.key), ['system', 'tools', 'user', 'assistant', 'tool'])
    assert.equal(root.parent_session, undefined)
    const sub = await post('sessions', { ids: ['sub'] }) as { value: { rows: Array<Record<string, unknown>> } }
    assert.equal(sub.value.rows.length, 1)
    assert.equal((sub.value.rows[0] as Record<string, unknown>).origin, 'subagent')
    assert.equal((sub.value.rows[0] as Record<string, unknown>).parent_session, 'root')
  })

  test('cost_usd is null when no price book is available', async () => {
    const { post } = seededFixture(depsWith({ pricing: () => null }))
    const out = await post('sessions', { ids: ['root'] }) as { value: { rows: Array<Record<string, unknown>> } }
    assert.equal((out.value.rows[0] as Record<string, unknown>).cost_usd, null)
  })
})

describe('query routes — summary', () => {
  test('computes counts, tokens, turns, cache hit and cost over the window', async () => {
    const { post } = seededFixture()
    const out = await post('summary', { scope: ALL }) as { value: Record<string, unknown> }
    const value = out.value
    const counts = value.counts as Record<string, unknown>
    assert.equal(counts.sessions, 4)
    assert.equal(counts.sessions_total, 4)
    assert.equal(counts.sessions_archived, 0)
    assert.equal(counts.archived_scoped, 0)
    assert.equal(value.turns, 5)
    assert.equal(value.tokens, (10 + 3 + 2 + 5 + 4 + 2) * 2 + 10 + 3 + 5)
    assert.equal(value.cache_hit, '12.00')
    assert.ok(Array.isArray(value.token_parts))
    assert.ok((value.cost_usd as number) > 0)
    assert.equal(value.cost_sessions, 4)
    assert.equal(value.usage_sessions, 4)
    const coverage = value.coverage as Record<string, unknown>
    assert.equal(coverage.complete, true)
    assert.equal(coverage.total, 0)
    const timing = value.timing as Record<string, unknown>
    assert.equal(timing.calls, 7)
    assert.equal(timing.toolCalls, 6)
    assert.ok((timing.wallMs as number) > 0)
    const windowTiming = value.window_timing as Record<string, unknown>
    assert.equal(windowTiming.calls, 7)
    assert.equal(windowTiming.tool_calls, 6)
  })

  test('timing is null for stores without steps or requests', async () => {
    const fixture = openQueryFixture()
    const out = await fixture.post('summary', {}) as { value: Record<string, unknown> }
    assert.equal((out.value.timing as unknown), null)
  })

  test('parts gating returns only the requested slices', async () => {
    const { post } = seededFixture()
    const kpi = await post('summary', { scope: ALL, parts: ['kpi'] }) as { value: Record<string, unknown> }
    assert.ok(kpi.value.counts !== undefined)
    assert.equal(kpi.value.tokens, undefined)
    assert.equal(kpi.value.timing, undefined)
    const tokens = await post('summary', { scope: ALL, parts: ['tokens'] }) as { value: Record<string, unknown> }
    assert.ok(tokens.value.tokens !== undefined)
    assert.equal((tokens.value.counts as Record<string, unknown>).sessions, undefined)
    const timing = await post('summary', { scope: ALL, parts: ['timing'] }) as { value: Record<string, unknown> }
    assert.ok(timing.value.timing !== undefined)
    assert.ok(timing.value.window_timing !== undefined)
    assert.equal(timing.value.tokens, undefined)
    const usage = await post('summary', { scope: ALL, parts: ['usage'] }) as { value: Record<string, unknown> }
    assert.equal(usage.value.usage_sessions, 4)
    assert.equal(usage.value.cost_sessions, 4)
    assert.equal(usage.value.cost_usd, undefined)
    const cost = await post('summary', { scope: ALL, parts: ['cost'] }) as { value: Record<string, unknown> }
    assert.ok((cost.value.cost_usd as number) > 0)
    assert.equal(cost.value.usage_sessions, undefined)
  })

  test('window scoping restricts tokens, turns and window timing', async () => {
    const { post } = seededFixture()
    const window = await post('summary', {
      scope: { range: { start: T0, end: T0 + 20_000 } },
      parts: ['kpi', 'tokens', 'timing'],
    }) as { value: Record<string, unknown> }
    const counts = window.value.counts as Record<string, unknown>
    assert.equal(counts.sessions, 1)
    assert.equal(window.value.turns, 2)
    assert.equal(window.value.tokens, (20 + 6) * 2)
    const windowTiming = window.value.window_timing as Record<string, unknown>
    assert.equal(windowTiming.calls, 4)
    assert.equal(windowTiming.tool_calls, 2)
    const timing = window.value.timing as Record<string, unknown>
    assert.equal(timing.calls, 4)
  })

  test('coverage passes through from deps and falls back to zeroed', async () => {
    const coverage = {
      complete: false,
      remaining: 3,
      failed: 1,
      running: true,
      total: 10,
      covered: 6,
      unsupported: 0,
    }
    const withCoverage = await seededFixture(depsWith({ coverage: () => coverage })).post('summary', {}) as { value: Record<string, unknown> }
    assert.deepEqual(withCoverage.value.coverage, coverage)
    const plain = await seededFixture().post('summary', {}) as { value: Record<string, unknown> }
    assert.deepEqual(plain.value.coverage, {
      complete: true,
      remaining: 0,
      failed: 0,
      running: false,
      total: 0,
      covered: 0,
      unsupported: 0,
    })
  })

  test('archived sessions count into the KPIs', async () => {
    const { post, handle } = seededFixture()
    new StoreWriter(handle.db, () => handle.bumpGeneration()).write({ sessionId: 'skill', session: { archived: 1 } })
    const out = await post('summary', { scope: ALL, parts: ['kpi'] }) as { value: Record<string, unknown> }
    const counts = out.value.counts as Record<string, unknown>
    assert.equal(counts.sessions_archived, 1)
    assert.equal(counts.archived_scoped, 1)
  })

  test('cost_sessions counts only fully-priced sessions', async () => {
    const partial: ModelBook = {
      prices: { deepseek: { 'deepseek-v4': { hit: 1, miss: 2, write: 3, out: 4 } } },
      index: priceIndexOf({ deepseek: { 'deepseek-v4': { hit: 1, miss: 2, write: 3, out: 4 } } }),
    }
    const { post } = seededFixture(depsWith({ pricing: () => partial }))
    const out = await post('summary', { scope: ALL, parts: ['usage'] }) as { value: Record<string, unknown> }
    assert.equal(out.value.usage_sessions, 4)
    assert.equal(out.value.cost_sessions, 3)
  })
})

describe('query routes — days', () => {
  test('aggregates per-day tokens, calls, sessions, turns, tools and cost', async () => {
    const { post } = seededFixture()
    const out = await post('days', { scope: { range: { start: T0, end: T0 + 21 * DAY_MS } } }) as { value: { days: Array<Record<string, unknown>> } }
    const days = out.value.days
    assert.deepEqual(days.map(day => day.key), [ROOT_DAY, SKILL_DAY, FILES_DAY, STREAM_DAY])
    const root = days[0]
    assert.equal(root.calls, 4)
    assert.equal(root.sessions, 1)
    assert.equal(root.turns, 2)
    assert.equal(root.tokens, (10 + 3 + 2 + 5 + 4 + 2) * 2)
    assert.equal(root.tool_calls, 2)
    assert.ok((root.tools_ms as number) > 0)
    assert.ok((root.wall_ms as number) > 0)
    assert.ok((root.cost_usd as number) > 0)
    assert.equal(days[2].calls, 1)
    assert.equal(days[2].tool_calls, 4)
  })

  test('coverage filters the day aggregation', async () => {
    const { post, handle } = seededFixture()
    new StoreWriter(handle.db, () => handle.bumpGeneration()).write({ sessionId: 'skill', session: { archived: 1 } })
    const out = await post('days', { scope: { coverage: 'archived', range: { start: T0, end: T0 + 21 * DAY_MS } } }) as { value: { days: Array<Record<string, unknown>> } }
    assert.deepEqual(out.value.days.map(day => day.key), [SKILL_DAY])
  })

  test('the default window is the 56-day range ending now', async () => {
    const { post } = seededFixture()
    const out = await post('days', {}) as { value: { days: unknown[] } }
    assert.deepEqual(out.value.days, [])
  })

  test('cost_usd is null without a price book', async () => {
    const { post } = seededFixture(depsWith({ pricing: () => null }))
    const out = await post('days', { scope: { range: { start: T0, end: T0 + 21 * DAY_MS } } }) as { value: { days: Array<Record<string, unknown>> } }
    assert.equal(out.value.days[0].cost_usd, null)
  })
})

describe('query routes — tally', () => {
  test('skills, tools, programs, models and providers tally with counts and recency', async () => {
    const { post } = seededFixture()
    const skills = await post('tally', { field: 'skills', scope: { range: { start: T0, end: T0 + 21 * DAY_MS } } }) as { value: { stats: Array<Record<string, unknown>> } }
    assert.deepEqual(skills.value.stats, [{ name: 'code-review', n: 1, sessions: 1, last: T0 + 5 * DAY_MS + 2 }])
    const tools = await post('tally', { field: 'tools', scope: { range: { start: T0, end: T0 + 21 * DAY_MS } } }) as { value: { stats: Array<Record<string, unknown>> } }
    assert.deepEqual(tools.value.stats.map(stat => stat.name), ['bash', 'ask_user_question', 'write', 'read'])
    const bash = tools.value.stats[0]
    assert.equal(bash.n, 3)
    assert.equal(bash.sessions, 2)
    const programs = await post('tally', { field: 'programs', scope: { range: { start: T0, end: T0 + 21 * DAY_MS } } }) as { value: { stats: Array<Record<string, unknown>> } }
    assert.deepEqual(programs.value.stats.map(stat => stat.name), ['ls', 'boom'])
    const models = await post('tally', { field: 'models', scope: { range: { start: T0, end: T0 + 21 * DAY_MS } } }) as { value: { stats: Array<Record<string, unknown>> } }
    assert.deepEqual(models.value.stats.map(stat => stat.name), ['deepseek-v4', 'deepseek-v4-flash'])
    const providers = await post('tally', { field: 'providers', scope: { range: { start: T0, end: T0 + 21 * DAY_MS } } }) as { value: { stats: Array<Record<string, unknown>> } }
    assert.deepEqual(providers.value.stats.map(stat => stat.name), ['deepseek'])
  })

  test('day filters and ordering apply', async () => {
    const { post } = seededFixture()
    const tools = await post('tally', { field: 'tools', scope: { day: FILES_DAY } }) as { value: { stats: Array<Record<string, unknown>> } }
    assert.deepEqual(tools.value.stats.map(stat => stat.name), ['ask_user_question', 'bash', 'write', 'read'])
    const empty = await post('tally', { field: 'skills', scope: { day: ROOT_DAY } }) as { value: { stats: unknown[] } }
    assert.deepEqual(empty.value.stats, [])
  })

  test('unknown fields fail', async () => {
    const { post } = seededFixture()
    assert.equal((await post('tally', { field: 'weird' }) as { error: { message: string } }).error.message, 'unknown field')
  })
})

test('the status route answers without a now callback and caps are enforced on non-string days', async () => {
  const fixture = openQueryFixture({})
  const out = await fixture.post('status') as { ok: unknown; value: Record<string, unknown> }
  assert.equal(out.ok, true)
  assert.equal((await fixture.post('sessions', { scope: { day: 5 } }) as { error: { message: string } }).error.message, 'day must be a string')
})

test('sessions ids mode tolerates an empty list, unknown ids and title fallback to id', async () => {
  const fixture = seededFixture()
  new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    .write({ sessionId: 'nocwd', session: { created_at: 1 } })
  const empty = await fixture.post('sessions', { ids: [] }) as { value: { rows: unknown[] } }
  assert.deepEqual(empty.value.rows, [])
  const out = await fixture.post('sessions', { ids: ['nocwd', 'root'] }) as { value: { rows: Array<Record<string, unknown>> } }
  assert.deepEqual(out.value.rows.map(row => row.id), ['nocwd', 'root'])
  assert.equal(out.value.rows[0].title, 'nocwd')
  assert.equal(out.value.rows[0].cwd, undefined)
})

test('the prepared statement cache stays bounded across varying scope shapes', async () => {
  const fixture = seededFixture()
  for (let size = 1; size <= 120; size++) {
    const ids = Array.from({ length: (size % 7) + 1 }, (_, index) => `s${index}`)
    const out = await fixture.post('sessions', { ids }) as { value: { rows: unknown[] } }
    assert.ok(Array.isArray(out.value.rows))
  }
  for (const query of ['a', 'b', 'c', 'd']) {
    const out = await fixture.post('sessions', { scope: { ...ALL, query } }) as { value: { rows: unknown[] } }
    assert.ok(Array.isArray(out.value.rows))
  }
  const out = await fixture.post('sessions', { scope: ALL }) as { value: { rows: unknown[] } }
  assert.equal(out.value.rows.length, 4)
})

test('scope range strings, invalid ranges, blank sessionId, title-less cwd and internal errors', async () => {
  const fixture = seededFixture()
  const stringRange = await fixture.post('sessions', { scope: { range: '30d' } }) as { value: { rows: unknown[] } }
  assert.deepEqual(stringRange.value.rows, [])
  const invalid = await fixture.post('sessions', { scope: { range: 'weird' } }) as { value: { rows: unknown[] } }
  assert.deepEqual(invalid.value.rows, [])
  const junkRange = await fixture.post('sessions', { scope: { range: { start: 'x' } } }) as { value: { rows: unknown[] } }
  assert.deepEqual(junkRange.value.rows, [])
  const blankId = await fixture.post('requests', { sessionId: '' }) as { error: { message: string } }
  assert.equal(blankId.error.message, 'sessionId must be a non-empty string')
  const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
  writer.write({ sessionId: 'slashed', session: { created_at: 1, cwd: '/' } })
  writer.write({ sessionId: 'untitled', session: { created_at: 2, cwd: '/repo/untitled' } })
  const titled = await fixture.post('sessions', { ids: ['slashed'] }) as { value: { rows: Array<Record<string, unknown>> } }
  assert.equal(titled.value.rows[0].title, 'slashed')
  const named = await fixture.post('sessions', { ids: ['untitled'] }) as { value: { rows: Array<Record<string, unknown>> } }
  assert.equal(named.value.rows[0].title, 'untitled')
  new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
    .write({ sessionId: 'missingDetailRev', session: { created_at: 3 } })
  const looseRev = await fixture.post('context', { sessionId: 'missingDetailRev', detailRev: 4 }) as { value: { rev: number } }
  assert.equal(looseRev.value.rev, 0)
  writer.write({ sessionId: 'broken', session: { created_at: 1 }, ops: [{ table: 'surface_nodes', patch: { session_id: 'broken', seq: 1, cat: 'user', tokens: 1, calls: 'not json' } }] })
  const broken = await fixture.post('timeline', { sessionId: 'broken' }) as { error: { code: string } }
  assert.equal(broken.error.code, 'gateway/internal')
})

test('summary parts validation and cost sessions without a book', async () => {
  const fixture = seededFixture(depsWith({ pricing: () => null }))
  assert.equal((await fixture.post('summary', { parts: 'x' }) as { error: { message: string } }).error.message, 'parts must be an array')
  const out = await fixture.post('summary', { scope: ALL, parts: ['usage', 'cost'] }) as { value: Record<string, unknown> }
  assert.equal(out.value.cost_sessions, 0)
  assert.equal(out.value.usage_sessions, 4)
  assert.equal(out.value.cost_usd, null)
})

test('the statement cache evicts beyond its bound without drift', async () => {
  const fixture = seededFixture()
  for (let index = 0; index < 220; index++) {
    const scope: Record<string, unknown> = { ...ALL }
    if (index % 3 === 0) scope.query = `needle${index}`
    if (index % 5 === 0) scope.model = `model${index}`
    if (index % 2 === 0) scope.group = index % 4 === 0 ? 'Root Project' : '__ungrouped__'
    const out = await fixture.post('sessions', { scope, page: index % 2 }) as { value: { rows: unknown[] } }
    assert.ok(Array.isArray(out.value.rows))
  }
  const out = await fixture.post('sessions', { scope: ALL }) as { value: { rows: Array<{ id: string }> } }
  assert.deepEqual(out.value.rows.map(row => row.id), ['stream', 'files', 'skill', 'root'])
})

describe('query routes — remaining coverage', () => {
  test('prepare evicts beyond its bound and keeps serving fresh SQL', async () => {
    const fixture = seededFixture()
    const { prepare } = await import('../../../src/host/store/query')
    const env = { db: fixture.handle.db, handle: fixture.handle, deps: {}, now: () => NOW, statements: new Map() } as never
    for (let index = 0; index < 250; index++) {
      prepare(env, `SELECT ${index} AS marker`)
    }
    assert.equal((env as { statements: Map<string, unknown> }).statements.size <= 192, true)
    const prepared = prepare(env, 'SELECT 1 AS fresh')
    assert.equal((prepared.get() as { fresh: number }).fresh, 1)
  })

  test('days honor the active coverage filter and steps-only days count', async () => {
    const fixture = seededFixture()
    new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
      .write({ sessionId: 'stepsonly', session: { created_at: 1, blank: 0 }, ops: [
        { table: 'steps', patch: { session_id: 'stepsonly', seq: 1, start_time: 5, end_time: 15, wall_ms: 10, day: '2023-01-01', active_ms: 10, wait_ms: 0, idle_ms: 0, tool_busy_ms: 0 } },
      ] })
    const out = await fixture.post('days', { scope: { coverage: 'active', range: { start: 0, end: 9_000_000_000_000 } } }) as { value: { days: Array<Record<string, unknown>> } }
    const day = out.value.days.find(entry => entry.key === '2023-01-01')
    assert.notEqual(day, undefined)
    assert.equal((day as Record<string, unknown> | undefined)?.calls, 0)
    assert.equal((day as Record<string, unknown> | undefined)?.wall_ms, 10)
    assert.equal((day as Record<string, unknown> | undefined)?.sessions, 0)
  })
})
