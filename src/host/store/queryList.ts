import { calculateSessionCost, type ModelBook } from '../../shared/pricing'
import { dayKeyOf } from '../../shared/days'
import type { OverviewGroupCount, OverviewTallyStat, SessionCostUsage } from '../../shared/types'
import { STORE_SCHEMA_VERSION } from './schema'
import {
  dayWindow, enumOf, idParamsOf, idsOf, inList, limitOf, matchedRootsSql, optionalIntOf, optionalSessionIdOf,
  PAGE_SIZE, prepare, queryFailure, rootParams, scopeOf, sessionOrScopeOf, SORTS, textOf, titleOf, UNGROUPED_KEY,
  usageSumColumns,
  type QueryEnv, type QueryRow, type QueryRouteSpec, type QueryScope, type RootFilter, type SessionRow,
} from './query'
import {
  compositionForIds, curPartsOf, famSourceOfFilter, famSourceOfIds, groupRowsBy, requestCountsOf,
  scalarCounts, scalarDayKeys, sessionUsageOf, costReadOf, usageBuckets, usageOfBuckets,
  type BucketRow, type Composition, type CountMaps,
} from './queryAggregates'

const DAYS_WINDOW_MS = 56 * 86_400_000

const TURNS_COUNT_SQL = 'SELECT session_id AS id, COALESCE(SUM(starts_turn), 0) AS value FROM requests WHERE session_id IN (#IDS#) AND is_inherited = 0 GROUP BY session_id'

const STEPS_COUNT_SQL = 'SELECT session_id AS id, COUNT(*) AS value FROM steps WHERE session_id IN (#IDS#) AND end_time IS NOT NULL GROUP BY session_id'

const CREATED_DAY_SQL = 'SELECT session_id AS id, MIN(day) AS value FROM requests WHERE session_id IN (#IDS#) AND is_inherited = 0 GROUP BY session_id'

const FLEET_MESSAGES_COUNT_SQL = `SELECT session_id AS id, COUNT(*) AS value FROM events WHERE session_id IN (#IDS#)
    AND kind = 'inject' AND name IN ('agent-message', 'team-message', 'subagent-settled') GROUP BY session_id`

const SESSION_ROW_COLUMNS = `SELECT s.id, s.title, s.cwd, s.archived, s.running, s.workspace_title, s.updated_at, s.created_at,
    fs.billed AS billed_tokens, s.cur_total, s.model, s.context_window, s.max_output_tokens, s.last_user,
    s.parent_session, s.origin, s.fold_status
  FROM sessions s JOIN roots r ON r.id = s.id JOIN fam_sum fs ON fs.id = s.id`

const SESSION_ROW_COLUMNS_BY_IDS = `SELECT s.id, s.title, s.cwd, s.archived, s.running, s.workspace_title, s.updated_at, s.created_at,
    fs.billed AS billed_tokens, s.cur_total, s.model, s.context_window, s.max_output_tokens, s.last_user,
    s.parent_session, s.origin, s.fold_status
  FROM sessions s JOIN fam_sum fs ON fs.id = s.id WHERE s.id IN (#IDS#) AND s.vanished_at IS NULL`

const FAM_SUM = ', fam_sum AS (SELECT f.root AS id, SUM(m.billed_tokens) AS billed FROM fam f JOIN sessions m ON m.id = f.member GROUP BY f.root)'

const SORT_KEYS: Record<'recent' | 'tokens' | 'context', string> = {
  recent: 's.updated_at',
  tokens: 'fs.billed',
  context: 's.cur_total',
}

function sessionRowOf(row: BucketRow, composition: Composition, counts: CountMaps): SessionRow {
  const id = row.id as string
  const cwd = row.cwd as string | null
  const out: SessionRow = {
    id,
    title: titleOf(row.title as string | null, cwd, id),
    archived: row.archived === 1,
    running: row.running === 1,
    updated_at: row.updated_at as number,
    created_at: row.created_at as number,
    billed_tokens: row.billed_tokens as number,
    cur_total: row.cur_total as number,
    cur_parts: curPartsOf(id, composition),
    turns: counts.turns.get(id) ?? 0,
    steps: counts.steps.get(id) ?? 0,
    fold_status: row.fold_status as SessionRow['fold_status'],
    cost_usd: counts.costs.get(id) ?? null,
  }
  if (cwd !== null) out.cwd = cwd
  const workspaceTitle = row.workspace_title as string | null
  if (workspaceTitle !== null) out.workspace_title = workspaceTitle
  const model = row.model as string | null
  if (model !== null) out.model = model
  const contextWindow = row.context_window as number | null
  if (contextWindow !== null) out.context_window = contextWindow
  const maxOutput = row.max_output_tokens as number | null
  if (maxOutput !== null) out.max_output_tokens = maxOutput
  const lastUser = row.last_user as string | null
  if (lastUser !== null) out.last_user = lastUser
  const parent = row.parent_session as string | null
  if (parent !== null) out.parent_session = parent
  if (row.origin === 'subagent') out.origin = 'subagent'
  const createdDay = counts.createdDays.get(id)
  if (createdDay !== undefined && createdDay !== null) out.created_day = createdDay
  return out
}

function pageClamp(page: number, total: number, pageSize: number): number {
  const count = Math.max(1, Math.ceil(total / pageSize))
  return Math.min(Math.max(0, page), count - 1)
}

function sessionCostsOf(env: QueryEnv, ids: readonly string[]): Map<string, number | null> {
  const out = new Map<string, number | null>()
  if (ids.length === 0) return out
  for (const id of ids) out.set(id, null)
  const book = env.deps.pricing?.() ?? null
  if (book === null) return out
  const source = famSourceOfIds(ids)
  const sql = `${source.prefix}, usage AS (
    SELECT f.root AS root, r.provider AS provider, r.model AS model, r.period AS period,
      ${usageSumColumns()}
    FROM requests r JOIN fam f ON f.member = r.session_id
    WHERE r.is_inherited = 0 AND r.model IS NOT NULL
    GROUP BY f.root, r.provider, r.model, r.period) SELECT * FROM usage`
  const byRoot = groupRowsBy(prepare(env, sql).all(source.params), 'root')
  for (const id of ids) {
    const buckets = byRoot.get(id)
    if (buckets !== undefined) out.set(id, calculateSessionCost(usageOfBuckets(buckets), book))
  }
  return out
}

function buildSessionRows(env: QueryEnv, rows: readonly BucketRow[]): SessionRow[] {
  const ids = rows.map(row => row.id as string)
  const composition = compositionForIds(env, ids)
  const counts: CountMaps = {
    turns: scalarCounts(env, TURNS_COUNT_SQL, ids),
    steps: scalarCounts(env, STEPS_COUNT_SQL, ids),
    createdDays: scalarDayKeys(env, CREATED_DAY_SQL, ids),
    costs: sessionCostsOf(env, ids),
  }
  return rows.map(row => sessionRowOf(row, composition, counts))
}

function sessionsRoute(env: QueryEnv, body: QueryRow): unknown {
  const ids = idsOf(body)
  if (ids !== undefined) return sessionsByIds(env, ids)
  const scope = scopeOf(body, env.now())
  const sortRaw = body.sort
  if (sortRaw !== undefined && sortRaw !== null && (typeof sortRaw !== 'string' || !SORTS.has(sortRaw as 'recent'))) {
    queryFailure('dsh-context/bad-request', 'unknown sort')
  }
  const sort = (sortRaw as 'recent' | 'tokens' | 'context' | undefined) ?? 'recent'
  const page = Math.max(0, optionalIntOf(body, 'page') ?? 0)
  const pageSize = limitOf(body, 'pageSize', PAGE_SIZE)
  const filter: RootFilter = { scope, withGroup: true, withPick: true }
  const scoped: RootFilter = { scope, withGroup: false, withPick: false }
  const params = rootParams(filter)
  const total = (prepare(env, matchedRootsSql(filter, ' SELECT COUNT(DISTINCT id) AS total FROM roots')).get(params) as { total: number }).total
  const rowsSql = matchedRootsSql(filter, `${FAM_SUM} ${SESSION_ROW_COLUMNS}
    ORDER BY ${SORT_KEYS[sort]} DESC, s.id ASC LIMIT :pageSize OFFSET :offset`)
  const rows = prepare(env, rowsSql).all({
    ...params, pageSize, offset: pageClamp(page, total, pageSize) * pageSize,
  }) as BucketRow[]
  const scopedParams = rootParams(scoped)
  const scopeTotal = (prepare(env, matchedRootsSql(scoped, ' SELECT COUNT(DISTINCT id) AS total FROM roots')).get(scopedParams) as { total: number }).total
  const groupRows = prepare(env, matchedRootsSql(scoped,
    ' SELECT s.workspace_title AS key, COUNT(DISTINCT s.id) AS count FROM sessions s JOIN roots r ON r.id = s.id GROUP BY s.workspace_title')).all(scopedParams) as BucketRow[]
  return {
    rows: buildSessionRows(env, rows),
    total,
    scope_total: scopeTotal,
    groups: groupsOf(env, groupRows),
  }
}

function sessionsByIds(env: QueryEnv, ids: readonly string[]): unknown {
  if (ids.length === 0) return { rows: [] }
  const source = famSourceOfIds(ids)
  const rowsSql = `${source.prefix}${FAM_SUM} ${SESSION_ROW_COLUMNS_BY_IDS.replace('#IDS#', inList(ids, 'rid'))}
    ORDER BY s.id ASC`
  const rows = prepare(env, rowsSql).all({ ...source.params, ...idParamsOf(ids, 'rid') }) as BucketRow[]
  return { rows: buildSessionRows(env, rows) }
}

function groupsOf(env: QueryEnv, rows: readonly BucketRow[]): OverviewGroupCount[] {
  const counts = new Map<string, number>()
  let ungrouped = 0
  for (const row of rows) {
    const key = row.key as string | null
    if (key === null) ungrouped = row.count as number
    else counts.set(key, row.count as number)
  }
  const groups: OverviewGroupCount[] = []
  for (const title of env.deps.workspaceTitles?.() ?? []) {
    const count = counts.get(title)
    if (count !== undefined) groups.push({ key: title, count })
    counts.delete(title)
  }
  for (const [key, count] of [...counts].sort((left, right) => left[0].localeCompare(right[0]))) {
    groups.push({ key, count })
  }
  if (ungrouped > 0) groups.push({ key: UNGROUPED_KEY, count: ungrouped })
  return groups
}

function daysScopeOf(env: QueryEnv, body: QueryRow): QueryScope {
  const raw = body.scope
  const data: QueryRow = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as QueryRow : {}
  const scope = scopeOf(body, env.now())
  if ((data.range !== undefined && data.range !== null) || scope.day !== null) return scope
  return { ...scope, floor: dayKeyOf(env.now() - DAYS_WINDOW_MS), ceiling: null }
}

function daysRoute(env: QueryEnv, body: QueryRow): unknown {
  const scope = daysScopeOf(env, body)
  const source = famSourceOfFilter({ scope, withGroup: true, withPick: true })
  const requestRows = prepare(env, `${source.prefix}, m AS (
    SELECT r.day AS key, COUNT(*) AS calls, COUNT(DISTINCT f.root) AS sessions, COALESCE(SUM(r.starts_turn), 0) AS turns,
      COALESCE(SUM(COALESCE(r.input_tokens, 0)), 0) AS input, COALESCE(SUM(COALESCE(r.cache_read_tokens, 0)), 0) AS cache_read,
      COALESCE(SUM(COALESCE(r.cache_write_tokens, 0)), 0) AS cache_write, COALESCE(SUM(COALESCE(r.output_tokens, 0)), 0) AS output
    FROM requests r JOIN fam f ON f.member = r.session_id
    WHERE r.is_inherited = 0 AND ${dayWindow('r')} GROUP BY r.day) SELECT * FROM m`).all(source.params) as BucketRow[]
  const toolRows = prepare(env, `${source.prefix}, m AS (
    SELECT tc.day AS key, COALESCE(SUM(CASE WHEN tc.result_seq IS NOT NULL THEN 1 ELSE 0 END), 0) AS tool_calls,
      COALESCE(SUM(CASE WHEN tc.duration_ms IS NOT NULL THEN tc.duration_ms ELSE 0 END), 0) AS tools_ms
    FROM tool_calls tc JOIN fam f ON f.member = tc.session_id
    WHERE tc.transport = 0 AND ${dayWindow('tc')}
    GROUP BY tc.day) SELECT * FROM m`).all(source.params) as BucketRow[]
  const stepRows = prepare(env, `${source.prefix}, m AS (
    SELECT st.day AS key, COALESCE(SUM(st.wall_ms), 0) AS wall_ms
    FROM steps st JOIN fam f ON f.member = st.session_id
    WHERE st.end_time IS NOT NULL AND ${dayWindow('st')}
    GROUP BY st.day) SELECT * FROM m`).all(source.params) as BucketRow[]
  const costRows = prepare(env, `${source.prefix}, m AS (
    SELECT r.day AS key, r.provider AS provider, r.model AS model, r.period AS period,
      ${usageSumColumns()}
    FROM requests r JOIN fam f ON f.member = r.session_id
    WHERE r.is_inherited = 0 AND r.model IS NOT NULL AND ${dayWindow('r')}
    GROUP BY r.day, r.provider, r.model, r.period) SELECT * FROM m`).all(source.params) as BucketRow[]
  const costByDay = groupRowsBy(costRows, 'key')
  interface DayRow {
    key: string
    tokens: number
    calls: number
    sessions: number
    tool_calls: number
    tools_ms: number
    wall_ms: number
    turns: number
    costUsd: number | null
  }
  const days = new Map<string, DayRow>()
  const ensure = (key: string): DayRow => {
    const entry = days.get(key)
    if (entry !== undefined) return entry
    const created: DayRow = { key, tokens: 0, calls: 0, sessions: 0, tool_calls: 0, tools_ms: 0, wall_ms: 0, turns: 0, costUsd: null }
    days.set(key, created)
    return created
  }
  for (const row of requestRows) {
    const day = ensure(row.key as string)
    day.calls += row.calls as number
    day.sessions += row.sessions as number
    day.turns += row.turns as number
    day.tokens += (row.input as number) + (row.cache_read as number) + (row.cache_write as number) + (row.output as number)
  }
  for (const row of toolRows) {
    const day = ensure(row.key as string)
    day.tool_calls += row.tool_calls as number
    day.tools_ms += row.tools_ms as number
  }
  for (const row of stepRows) {
    ensure(row.key as string).wall_ms += row.wall_ms as number
  }
  const book = env.deps.pricing?.() ?? null
  for (const [key, buckets] of costByDay) {
    if (book !== null) ensure(key).costUsd = calculateSessionCost(usageOfBuckets(buckets), book)
  }
  const out = [...days.values()]
    .filter(day => day.calls > 0 || day.tool_calls > 0 || day.wall_ms > 0)
    .sort((left, right) => (left.key < right.key ? -1 : 1))
    .map(day => ({
      key: day.key,
      tokens: day.tokens,
      calls: day.calls,
      sessions: day.sessions,
      tool_calls: day.tool_calls,
      tools_ms: day.tools_ms,
      wall_ms: day.wall_ms,
      turns: day.turns,
      cost_usd: day.costUsd,
    }))
  return { days: out }
}

const TALLY_FIELDS = ['skills', 'tools', 'programs', 'models', 'providers'] as const

type TallyField = (typeof TALLY_FIELDS)[number]

const TALLY_FIELDS_SET: ReadonlySet<TallyField> = new Set<TallyField>(TALLY_FIELDS)

function tallySql(filter: RootFilter, field: TallyField): string {
  const fills: Record<TallyField, [string, string, string, string, string]> = {
    skills: ['sl.name', 'sl.time', 'skill_loads sl', 'sl', '1 = 1'],
    tools: ['tc.name', 'tc.end_time', 'tool_calls tc', 'tc', 'tc.result_seq IS NOT NULL'],
    programs: ['tc.program', 'tc.start_time', 'tool_calls tc', 'tc', 'tc.program IS NOT NULL'],
    models: ['r.model', 'r.time', 'requests r', 'r', 'r.model IS NOT NULL AND r.is_inherited = 0'],
    providers: ['r.provider', 'r.time', 'requests r', 'r', 'r.provider IS NOT NULL AND r.is_inherited = 0'],
  }
  const [column, last, table, alias, where] = fills[field]
  const tail = `SELECT ${column} AS name, COUNT(*) AS n, COUNT(DISTINCT f.root) AS sessions, MAX(${last}) AS last
      FROM ${table} JOIN fam f ON f.member = ${alias}.session_id
      WHERE ${where} AND ${dayWindow(alias)}
      GROUP BY ${column}`
  return matchedRootsSql(filter, `, tally AS (${tail}) SELECT * FROM tally`)
}

function tallyRoute(env: QueryEnv, body: QueryRow): unknown {
  const field = enumOf(body, 'field', TALLY_FIELDS_SET, 'unknown field')
  const scope = scopeOf(body, env.now())
  const filter: RootFilter = { scope, withGroup: true, withPick: true }
  const rows = prepare(env, tallySql(filter, field)).all(rootParams(filter)) as BucketRow[]
  const stats: OverviewTallyStat[] = rows.map(row => ({
    name: row.name as string,
    n: row.n as number,
    sessions: row.sessions as number,
    last: row.last as number,
  }))
  stats.sort((left, right) => (right.n - left.n) || (right.last - left.last) || left.name.localeCompare(right.name))
  return { field, stats }
}

const FAMILY_DEPTH_MAX = 16

function resolveRootId(env: QueryEnv, body: QueryRow): string {
  const sessionId = optionalSessionIdOf(body)
  const rootId = textOf(body, 'rootId', 200)
  if (rootId !== undefined) return rootId
  if (sessionId === undefined) queryFailure('dsh-context/bad-request', 'family requires rootId or sessionId')
  const row = prepare(env, `WITH RECURSIVE up(id, root, depth) AS (
      SELECT ?, ?, 0
      UNION ALL
      SELECT up.id, s.parent_session, up.depth + 1 FROM up JOIN sessions s ON s.id = up.root
      WHERE s.origin = 'subagent' AND s.parent_session IS NOT NULL AND up.depth < ${FAMILY_DEPTH_MAX}
    ) SELECT root FROM up ORDER BY depth DESC LIMIT 1`).get(sessionId, sessionId) as { root: string } | undefined
  return (row as { root: string }).root
}

function familyRoute(env: QueryEnv, body: QueryRow): unknown {
  const needsHistory = body.needs_history
  if (needsHistory !== undefined && needsHistory !== null && typeof needsHistory !== 'boolean') {
    queryFailure('dsh-context/bad-request', 'needs_history must be a boolean')
  }
  const rootId = resolveRootId(env, body)
  const source = famSourceOfIds([rootId])
  const rows = prepare(env, `${source.prefix}
    SELECT s.id, s.title, s.cwd, s.origin, s.running, s.billed_tokens, s.parent_session, f.depth
    FROM sessions s JOIN fam f ON f.member = s.id`).all(source.params) as BucketRow[]
  const byId = new Map<string, BucketRow>()
  const children = new Map<string, string[]>()
  for (const row of rows) {
    byId.set(row.id as string, row)
    const parent = row.parent_session as string | null
    if (row.origin !== 'subagent' || parent === null) continue
    const list = children.get(parent) ?? []
    list.push(row.id as string)
    children.set(parent, list)
  }
  const book = env.deps.pricing?.() ?? null
  const ids = rows.map(row => row.id as string)
  const calls = requestCountsOf(env, ids)
  const messages = scalarCounts(env, FLEET_MESSAGES_COUNT_SQL, ids)
  const costs = familyCostsOf(env, rows, book)
  const members: Array<Record<string, unknown>> = []
  const queue = [rootId]
  let order = 0
  while (queue.length > 0) {
    const id = queue.shift() as string
    const row = byId.get(id)
    if (row === undefined) continue
    members.push({
      id,
      title: titleOf(row.title as string | null, row.cwd as string | null, id),
      ...(row.origin === 'subagent' ? { origin: 'subagent' } : {}),
      running: row.running === 1,
      depth: row.depth,
      order,
      billed_tokens: row.billed_tokens,
      calls: calls.get(id) ?? 0,
      messages_total: messages.get(id) ?? 0,
      ...(book === null ? {} : { cost_usd: costs.get(id) ?? null }),
    })
    order++
    for (const child of (children.get(id) ?? []).sort()) {
      queue.push(child)
    }
  }
  let billedTotal = 0
  let callsTotal = 0
  let messagesTotal = 0
  let costTotal = 0
  for (const member of members) {
    billedTotal += member.billed_tokens as number
    callsTotal += member.calls as number
    messagesTotal += member.messages_total as number
    if (book !== null) costTotal += (member.cost_usd as number | null) ?? 0
  }
  return {
    members,
    totals: {
      billed_tokens: billedTotal,
      calls: callsTotal,
      messages_total: messagesTotal,
      ...(book === null ? {} : { cost_usd: costTotal }),
    },
  }
}

function familyCostsOf(env: QueryEnv, rows: readonly BucketRow[], book: ModelBook | null): Map<string, number | null> {
  const out = new Map<string, number | null>()
  if (book === null || rows.length === 0) return out
  const source = famSourceOfIds(rows.map(row => row.id as string))
  const sql = `${source.prefix}, usage AS (
    SELECT r.session_id AS id, r.provider AS provider, r.model AS model, r.period AS period,
      ${usageSumColumns()}
    FROM requests r JOIN fam f ON f.member = r.session_id
    WHERE r.is_inherited = 0 AND r.model IS NOT NULL
    GROUP BY r.session_id, r.provider, r.model, r.period) SELECT * FROM usage`
  const byId = groupRowsBy(prepare(env, sql).all(source.params), 'id')
  for (const row of rows) {
    const id = row.id as string
    const buckets = byId.get(id)
    out.set(id, buckets === undefined ? null : calculateSessionCost(usageOfBuckets(buckets), book))
  }
  return out
}

function costRoute(env: QueryEnv, body: QueryRow): unknown {
  const { sessionId } = sessionOrScopeOf(body, 'cost')
  const usage: SessionCostUsage | null = sessionId !== undefined
    ? sessionUsageOf(env, sessionId)
    : usageOrNull(usageBuckets(env, famSourceOfFilter({ scope: scopeOf(body, env.now()), withGroup: true, withPick: true }), false))
  return costReadOf(env, usage)
}

function usageOrNull(buckets: readonly BucketRow[]): SessionCostUsage | null {
  return buckets.length === 0 ? null : usageOfBuckets(buckets)
}

const STATUS_COUNTS_SQL = `SELECT
    (SELECT COUNT(*) FROM sessions) AS sessions,
    (SELECT COUNT(*) FROM steps) AS steps,
    (SELECT COUNT(*) FROM requests) AS requests,
    (SELECT COUNT(*) FROM tool_calls) AS tool_calls,
    (SELECT COUNT(*) FROM surface_nodes) AS surface_nodes,
    (SELECT COUNT(*) FROM system_prompts) AS system_prompts,
    (SELECT COUNT(*) FROM header_epochs) AS header_epochs,
    (SELECT COUNT(*) FROM header_tools) AS header_tools,
    (SELECT COUNT(*) FROM events) AS events,
    (SELECT COUNT(*) FROM file_ops) AS file_ops,
    (SELECT COUNT(*) FROM skill_loads) AS skill_loads,
    (SELECT COUNT(*) FROM timing_spans) AS timing_spans,
    (SELECT COUNT(*) FROM fold_state) AS fold_state`

const STATUS_COVERAGE_SQL = `SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN fold_status = 'ok' THEN 1 ELSE 0 END), 0) AS covered,
    COALESCE(SUM(CASE WHEN fold_status IN ('pending', 'folding') THEN 1 ELSE 0 END), 0) AS pending,
    COALESCE(SUM(CASE WHEN fold_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
    COALESCE(SUM(CASE WHEN fold_status = 'unsupported' THEN 1 ELSE 0 END), 0) AS unsupported
  FROM sessions`

function statusRoute(env: QueryEnv): unknown {
  const counts = prepare(env, STATUS_COUNTS_SQL).get() as BucketRow
  const coverage = prepare(env, STATUS_COVERAGE_SQL).get() as BucketRow
  const pageCount = prepare(env, 'PRAGMA page_count').get() as { page_count: number }
  const pageSize = prepare(env, 'PRAGMA page_size').get() as { page_size: number }
  const remaining = coverage.pending as number
  return {
    schema_version: STORE_SCHEMA_VERSION,
    generation: env.handle.generation(),
    pricing_version: env.handle.pricingVersion(),
    ready: (env.deps.pricing?.() ?? null) !== null,
    db_bytes: pageCount.page_count * pageSize.page_size,
    coverage: {
      complete: remaining === 0 && coverage.failed === 0,
      remaining,
      failed: coverage.failed as number,
      running: env.deps.backfillRunning?.() ?? false,
      total: coverage.total as number,
      covered: coverage.covered as number,
      unsupported: coverage.unsupported as number,
    },
    counts,
    harness_supported: env.deps.harnessSupported ?? true,
  }
}

export const listRoutes: QueryRouteSpec[] = [
  { path: 'sessions', run: sessionsRoute },
  { path: 'days', run: daysRoute },
  { path: 'tally', run: tallyRoute },
  { path: 'family', run: familyRoute },
  { path: 'cost', run: costRoute },
  { path: 'status', run: env => statusRoute(env) },
]
