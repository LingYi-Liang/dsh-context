import assert from 'node:assert/strict'
import { afterAll, describe, test } from 'vitest'
import { applyTimeline, createTimelineState, type TimelineEvent, type TimelineState } from '../../../src/host/fold'
import { buildTimelineView } from '../../../src/host/foldWire'
import { applyActivity } from '../../../src/host/activity'
import { resolveBounds } from '../../../src/host/config'
import { activityTotalsOf, hostSessionOf, type HostRow, type HostSession } from '../../../src/host/overviewCorpus'
import {
  daysOf, matches, pageOf, pageRowOf, sortOf, summaryOf, tallyStatsOf, groupCountsOf, windowOf,
  type Filters,
} from '../../../src/host/overviewAggregate'
import { faceOf, missOf, type CostSource } from '../../../src/host/cost'
import { StoreWriter } from '../../../src/host/store/writer'
import { calculateSessionCost, priceLookupsOf } from '../../../src/shared/pricing'
import type { ActivityDay, ActivityTally, BackfillCoverage, ContextActivity, OverviewTallyField, SessionCostRead, SessionCostUsage } from '../../../src/shared/types'
import {
  ALL, BOOK, DAY_MS, NOW, T0, depsWith, disposeQueryFixtures, fileEvents, seededFixture, canonicalEvents, skillEvents,
  type QueryFixture,
} from '../helpers/queryFixture'

const BOUNDS = resolveBounds(undefined)

const COVERAGE: BackfillCoverage = {
  complete: true,
  remaining: 0,
  failed: 0,
  running: false,
  total: 4,
  covered: 4,
  unsupported: 0,
}

const cost: CostSource = {
  ready: () => true,
  usd: usage => usage === null || usage === undefined ? null : calculateSessionCost(usage, BOOK),
  complete: usage => {
    if (usage === null || usage === undefined) return false
    const lookups = priceLookupsOf(usage, BOOK)
    return lookups.length > 0 && lookups.every(lookup => lookup.face !== null)
  },
  read(usage: SessionCostUsage | null | undefined): SessionCostRead | undefined {
    if (usage === null || usage === undefined) return undefined
    const faces: SessionCostRead['faces'] = []
    const misses: SessionCostRead['misses'] = []
    for (const lookup of priceLookupsOf(usage, BOOK)) {
      if (lookup.face !== null) faces.push(faceOf(lookup.provider, lookup.model, lookup.face))
      else misses.push(missOf(lookup.provider, lookup.model, lookup.miss))
    }
    return { usd: calculateSessionCost(usage, BOOK), ready: true, ...(faces.length === 0 ? {} : { faces }), ...(misses.length === 0 ? {} : { misses }) }
  },
  version: () => 1,
}

function foldEvents(events: readonly TimelineEvent[]): { state: TimelineState; activity: ContextActivity } {
  let state = createTimelineState()
  let activity: ContextActivity = { days: {} }
  for (const event of events) {
    state = applyTimeline(state, event, BOUNDS)
    activity = applyActivity(activity, event as never)
  }
  return { state, activity }
}

interface OldSpec {
  readonly id: string
  readonly events: readonly TimelineEvent[]
  readonly createdAt: number
  readonly cwd: string
  readonly parent?: string
  readonly origin?: 'subagent'
  readonly archived?: boolean
  readonly group?: string
  readonly running?: boolean
}

const SPECS: OldSpec[] = [
  { id: 'root', events: canonicalEvents(1, T0), createdAt: T0, cwd: '/repo/root', group: 'Root Project', running: true },
  { id: 'sub', events: canonicalEvents(2, T0), createdAt: T0 + 500, cwd: '/repo/root', parent: 'root', origin: 'subagent' },
  { id: 'skill', events: skillEvents(T0 + 5 * DAY_MS), createdAt: T0 + 5 * DAY_MS, cwd: '/repo/skill', group: 'Skill Project', archived: true },
  { id: 'files', events: fileEvents(T0 + 10 * DAY_MS), createdAt: T0 + 10 * DAY_MS, cwd: '/repo/files' },
]

function hostSessionsOf(specs: readonly OldSpec[]): Map<string, HostSession> {
  const sessions = new Map<string, HostSession>()
  for (const spec of specs) {
    const { state, activity } = foldEvents(spec.events)
    let lastPromptAt = 0
    for (const event of spec.events) {
      if (event.type === 'user/message' && (event.data as { source?: { kind?: unknown } }).source?.kind === 'user') {
        lastPromptAt = Math.max(lastPromptAt, event.time)
      }
    }
    const snapshot = buildTimelineView(state, BOUNDS)
    const session = hostSessionOf(spec.id, {
      id: spec.id,
      createdAt: spec.createdAt,
      cwd: spec.cwd,
      ...(spec.parent === undefined ? {} : { parentSession: spec.parent }),
      ...(spec.origin === undefined ? {} : { origin: spec.origin }),
    }, 'sig', {
      contextTimeline: snapshot,
      contextActivity: activity,
      sessionListMetadata: { blank: false, ...(lastPromptAt > 0 ? { lastPromptAt } : {}) },
    })
    sessions.set(spec.id, session)
  }
  return sessions
}

function mergeActivities(members: readonly (ContextActivity | null)[]): ContextActivity | null {
  const days: Record<string, ActivityDay> = {}
  let any = false
  for (const activity of members) {
    if (activity === null) continue
    any = true
    for (const key of Object.keys(activity.days)) {
      const entry = activity.days[key]
      if (!Object.hasOwn(days, key)) {
        days[key] = {
          tokens: entry.tokens,
          requests: entry.requests,
          ...(entry.cost === undefined ? {} : { cost: entry.cost }),
          ...(entry.turns === undefined ? {} : { turns: entry.turns }),
          ...(entry.toolCalls === undefined ? {} : { toolCalls: entry.toolCalls }),
          ...(entry.toolsMs === undefined ? {} : { toolsMs: entry.toolsMs }),
          ...(entry.wallMs === undefined ? {} : { wallMs: entry.wallMs }),
          ...(entry.skills === undefined ? {} : { skills: entry.skills }),
          ...(entry.tools === undefined ? {} : { tools: entry.tools }),
          ...(entry.cmds === undefined ? {} : { cmds: entry.cmds }),
        }
        continue
      }
      const prev = days[key]
      prev.tokens += entry.tokens
      prev.requests += entry.requests
      for (const field of ['turns', 'toolCalls', 'toolsMs', 'wallMs'] as const) {
        if (entry[field] === undefined && prev[field] === undefined) continue
        prev[field] = (prev[field] ?? 0) + (entry[field] ?? 0)
      }
      if (entry.cost !== undefined) {
        prev.cost = mergeCost(prev.cost, entry.cost)
      }
      if (entry.skills !== undefined) prev.skills = mergeTallies(prev.skills, entry.skills)
      if (entry.tools !== undefined) prev.tools = mergeTallies(prev.tools, entry.tools)
      if (entry.cmds !== undefined) prev.cmds = mergeTallies(prev.cmds, entry.cmds)
    }
  }
  return any ? { days } : null
}

function mergeCost(prev: SessionCostUsage | undefined, next: SessionCostUsage): SessionCostUsage {
  const out: SessionCostUsage = prev === undefined ? {} : structuredClone(prev)
  for (const provider of Object.keys(next)) {
    const models = out[provider] ?? (out[provider] = {})
    for (const model of Object.keys(next[provider])) {
      const periods = models[model] ?? (models[model] = {})
      for (const period of ['peak', 'off'] as const) {
        const bucket = next[provider][model][period]
        if (bucket === undefined) continue
        const target = periods[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        periods[period] = {
          uncached: target.uncached + bucket.uncached,
          cacheRead: target.cacheRead + bucket.cacheRead,
          cacheWrite: target.cacheWrite + bucket.cacheWrite,
          output: target.output + bucket.output,
        }
      }
    }
  }
  return out
}

function mergeTallies(
  left: Record<string, ActivityTally> | undefined,
  right: Record<string, ActivityTally>,
): Record<string, ActivityTally> {
  const out: Record<string, ActivityTally> = { ...left }
  for (const name of Object.keys(right)) {
    const tally = right[name]
    if (!Object.hasOwn(out, name)) {
      out[name] = tally
      continue
    }
    out[name] = { n: out[name].n + tally.n, last: Math.max(out[name].last, tally.last) }
  }
  return out
}

function oldRowsOf(sessions: Map<string, HostSession>): HostRow[] {
  const byId = new Map<string, HostSession>()
  for (const [id, session] of [...sessions].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
    if (session.blank) continue
    byId.set(id, session)
  }
  const children = new Map<string, HostSession[]>()
  for (const session of byId.values()) {
    if (session.origin !== 'subagent' || session.parentSession === undefined) continue
    const list = children.get(session.parentSession) ?? []
    list.push(session)
    children.set(session.parentSession, list)
  }
  const rows: HostRow[] = []
  for (const session of byId.values()) {
    if (session.origin === 'subagent') continue
    const family: HostSession[] = [session]
    const queue = [session.id]
    for (let index = 0; index < queue.length; index++) {
      for (const child of children.get(queue[index]) ?? []) {
        family.push(child)
        queue.push(child.id)
      }
    }
    const activity = family.length === 1 ? session.activity : mergeActivities(family.map(member => member.activity))
    const totals = activityTotalsOf(activity)
    let createdDay: string | undefined
    const days = activity?.days
    if (days !== undefined) {
      for (const key of Object.keys(days)) {
        if (createdDay === undefined || key < createdDay) createdDay = key
      }
    }
    rows.push({
      session,
      archived: session.id === 'skill',
      ...(session.id === 'root' || session.id === 'skill' ? { group: session.id === 'root' ? 'Root Project' : 'Skill Project' } : {}),
      running: session.id === 'root',
      activity,
      family,
      totals,
      ...(createdDay === undefined ? {} : { createdDay }),
    })
  }
  return rows
}

const FILTERS: Filters = {
  window: windowOf(ALL.range, null, NOW),
  day: null,
  coverage: 'all',
  group: null,
  query: '',
  pick: null,
}

function newFixture(): QueryFixture {
  const fixture = seededFixture(depsWith({ coverage: () => COVERAGE }))
  const writer = new StoreWriter(fixture.handle.db, () => fixture.handle.bumpGeneration())
  writer.deleteSession('stream')
  writer.write({ sessionId: 'skill', session: { archived: 1 } })
  return fixture
}

function scopedOldRows(rows: readonly HostRow[], filters: Filters): HostRow[] {
  return rows.filter(row => matches(row, { ...filters, group: null, pick: null }))
}

describe('parity — sessions rows vs matches + sortOf + pageRowOf', () => {
  test('recent sort rows carry identical shared fields', async () => {
    const fixture = newFixture()
    const oldRows = oldRowsOf(hostSessionsOf(SPECS))
    const scoped = scopedOldRows(oldRows, FILTERS)
    const sorted = sortOf(oldRows, 'recent')
    const paged = pageOf(sorted, 0)
    const out = await fixture.post('sessions', { scope: ALL, sort: 'recent' }) as { value: { rows: Array<Record<string, unknown>>; total: number; scope_total: number; groups: Array<Record<string, unknown>> } }
    assert.deepEqual(out.value.rows.map(row => row.id), paged.items.map(row => row.session.id))
    assert.equal(out.value.total, sorted.length)
    assert.equal(out.value.scope_total, scoped.length)
    const workspace = {
      titles: ['Root Project', 'Skill Project'],
      archived: new Set(['skill']),
    }
    assert.deepEqual(out.value.groups, groupCountsOf(scoped, {
      titles: workspace.titles,
      archived: workspace.archived,
      groups: new Map([['root', 'Root Project'], ['skill', 'Skill Project']]),
      signature: '',
    }))
    for (let index = 0; index < paged.items.length; index++) {
      const expected = pageRowOf(paged.items[index], cost)
      const actual = out.value.rows[index]
      assert.equal(actual.title, expected.title)
      assert.equal(actual.updated_at, expected.updatedAt)
      assert.equal(actual.cwd, expected.cwd)
      assert.equal(actual.running, expected.running)
      assert.equal(actual.archived, expected.archived)
      assert.equal(actual.billed_tokens, expected.tokens)
      assert.equal(actual.turns, expected.turns)
      assert.equal(actual.cur_total, expected.total)
      assert.deepEqual(actual.cur_parts, expected.parts)
      assert.equal(actual.cost_usd, expected.costUsd)
      assert.equal(actual.model, expected.model)
      assert.equal(actual.context_window, expected.contextWindow)
      assert.equal(actual.max_output_tokens, expected.maxOutputTokens)
      assert.equal(actual.last_user, expected.lastUser)
      assert.equal(actual.created_day, expected.createdDay)
      assert.equal(actual.workspace_title, expected.group)
      assert.equal(actual.fold_status, 'ok')
    }
  })

  test('tokens and context sorts agree', async () => {
    const fixture = newFixture()
    const oldRows = oldRowsOf(hostSessionsOf(SPECS))
    for (const sort of ['tokens', 'context'] as const) {
      const sorted = sortOf(oldRows, sort)
      const out = await fixture.post('sessions', { scope: ALL, sort }) as { value: { rows: Array<{ id: string }> } }
      assert.deepEqual(out.value.rows.map(row => row.id), sorted.map(row => row.session.id), sort)
    }
  })

  test('pick filters agree with the old cmds tally pick', async () => {
    const fixture = newFixture()
    const oldRows = oldRowsOf(hostSessionsOf(SPECS))
    const oldPick = oldRows.filter(row => matches(row, {
      ...FILTERS,
      pick: { field: 'cmds', name: 'ls' },
    }))
    const out = await fixture.post('sessions', { scope: { ...ALL, pick: { field: 'programs', name: 'ls' } } }) as { value: { rows: Array<{ id: string }> } }
    assert.deepEqual(out.value.rows.map(row => row.id), oldPick.map(row => row.session.id))
  })
})

describe('parity — summary vs summaryOf', () => {
  test('KPIs, tokens, cost, cache hit and token parts agree', async () => {
    const fixture = newFixture()
    const oldRows = oldRowsOf(hostSessionsOf(SPECS))
    const expected = summaryOf(oldRows, oldRows, FILTERS, cost, COVERAGE)
    const out = await fixture.post('summary', { scope: ALL, parts: ['kpi', 'tokens', 'usage', 'cost'] }) as { value: Record<string, unknown> }
    const counts = out.value.counts as Record<string, unknown>
    assert.equal(counts.sessions, expected.sessions)
    assert.equal(counts.sessions_total, expected.sessionsTotal)
    assert.equal(counts.sessions_archived, expected.sessionsArchived)
    assert.equal(counts.archived_scoped, expected.archivedScoped)
    assert.equal(out.value.turns, expected.turns)
    assert.equal(out.value.tokens, expected.tokens)
    assert.equal(out.value.cost_usd, expected.costUsd)
    assert.equal(out.value.cost_sessions, expected.costSessions)
    assert.equal(out.value.usage_sessions, expected.usageSessions)
    assert.equal(out.value.cache_hit, expected.cacheHit)
    assert.deepEqual(out.value.token_parts, expected.tokenParts)
    assert.deepEqual(out.value.coverage, COVERAGE)
  })

  test('lifetime timing and window timing agree', async () => {
    const fixture = newFixture()
    const oldRows = oldRowsOf(hostSessionsOf(SPECS))
    const expected = summaryOf(oldRows, oldRows, FILTERS, cost, COVERAGE)
    const out = await fixture.post('summary', { scope: ALL, parts: ['timing'] }) as { value: Record<string, unknown> }
    assert.deepEqual(out.value.timing, expected.timing)
    const windowTiming = out.value.window_timing as Record<string, number>
    assert.deepEqual(windowTiming, {
      calls: expected.windowTiming.calls,
      tool_calls: expected.windowTiming.toolCalls,
      tools_ms: expected.windowTiming.toolsMs,
      wall_ms: expected.windowTiming.wallMs,
    })
  })
})


  test('group and pick restricted tallies agree', async () => {
    const fixture = newFixture()
    const oldRows = oldRowsOf(hostSessionsOf(SPECS))
    const groupFilter = { ...FILTERS, group: 'Root Project' }
    const groupExpected = tallyStatsOf(oldRows.filter(row => matches(row, groupFilter)), groupFilter, 'tools')
    const groupOut = await fixture.post('tally', { field: 'tools', scope: { ...ALL, group: 'Root Project' } }) as { value: { stats: Array<Record<string, unknown>> } }
    assert.deepEqual(groupOut.value.stats, groupExpected, 'group')
    const pickFilter: Filters = { ...FILTERS, pick: { field: 'tools', name: 'bash' } }
    const pickExpected = tallyStatsOf(oldRows.filter(row => matches(row, pickFilter)), pickFilter, 'tools')
    const pickOut = await fixture.post('tally', { field: 'tools', scope: { ...ALL, pick: { field: 'tools', name: 'bash' } } }) as { value: { stats: Array<Record<string, unknown>> } }
    assert.deepEqual(pickOut.value.stats, pickExpected, 'pick')
  })

describe('parity — days vs daysOf', () => {
  test('shared day fields agree; new fields are present', async () => {
    const fixture = newFixture()
    const oldRows = oldRowsOf(hostSessionsOf(SPECS))
    const expected = daysOf(oldRows, 'all', cost)
    const out = await fixture.post('days', { scope: { coverage: 'all', range: ALL.range } }) as { value: { days: Array<Record<string, unknown>> } }
    assert.deepEqual(out.value.days.map(day => day.key), expected.map(day => day.key))
    for (let index = 0; index < expected.length; index++) {
      const old = expected[index]
      const row = out.value.days[index]
      assert.equal(row.tokens, old.tokens, old.key)
      assert.equal(row.sessions, old.sessions, old.key)
      assert.equal(row.cost_usd, old.costUsd, old.key)
      assert.ok((row.calls as number) > 0, old.key)
      assert.equal(typeof row.turns, 'number', old.key)
      assert.equal(typeof row.tool_calls, 'number', old.key)
      assert.equal(typeof row.tools_ms, 'number', old.key)
      assert.equal(typeof row.wall_ms, 'number', old.key)
    }
  })
})

describe('parity — tally vs tallyStatsOf', () => {
  test('skills, tools and programs tallies agree', async () => {
    const fixture = newFixture()
    const oldRows = oldRowsOf(hostSessionsOf(SPECS))
    const cases: Array<{ field: OverviewTallyField; newField: string }> = [
      { field: 'skills', newField: 'skills' },
      { field: 'tools', newField: 'tools' },
      { field: 'cmds', newField: 'programs' },
    ]
    for (const parity of cases) {
      const expected = tallyStatsOf(oldRows, FILTERS, parity.field)
      const out = await fixture.post('tally', { field: parity.newField, scope: ALL }) as { value: { stats: Array<Record<string, unknown>> } }
      assert.deepEqual(out.value.stats, expected, parity.field)
    }
  })
})

afterAll(() => {
  disposeQueryFixtures()
})
