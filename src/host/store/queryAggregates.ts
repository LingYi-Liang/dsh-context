import { CATS, RING_ORDER, billedParts } from '../../shared/categories'
import { calculateSessionCost, priceFaceOf, priceLookupsOf } from '../../shared/pricing'
import type { BackfillCoverage, CostPriceFace, CostPriceMiss, OverviewPartTotal, SessionCostUsage, TimingTotals, ToolTimingTotals } from '../../shared/types'
import { faceOf, missOf } from '../cost'
import {
  dayWindow, famCteBody, idParamsOf, inList, matchedRootsSql, prepare, queryFailure, rootParams, scopeOf,
  usageSumColumns,
  type QueryEnv, type QueryRow, type QueryRouteSpec, type RootFilter,
} from './query'

export interface FamSource {
  readonly prefix: string
  readonly params: Record<string, string | number | null>
}

export function famSourceOfFilter(filter: RootFilter): FamSource {
  return { prefix: matchedRootsSql(filter, ''), params: rootParams(filter) }
}

export function famSourceOfIds(ids: readonly string[]): FamSource {
  const initial = `SELECT id, id, 0 FROM sessions s WHERE s.id IN (${inList(ids, 'id')})`
  return { prefix: `WITH RECURSIVE ${famCteBody('fam', initial)}`, params: idParamsOf(ids, 'id') }
}

const TIMING_TOOLS_MAX = 16

const ZEROED_COVERAGE: BackfillCoverage = {
  complete: true,
  remaining: 0,
  failed: 0,
  running: false,
  total: 0,
  covered: 0,
  unsupported: 0,
}

export type BucketRow = Record<string, unknown>

function bucketTotalsOf(rows: readonly BucketRow[]): { input: number; cacheRead: number; cacheWrite: number; output: number } | null {
  if (rows.length === 0) return null
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  for (const row of rows) {
    totals.input += row.input as number
    totals.cacheRead += row.cache_read as number
    totals.cacheWrite += row.cache_write as number
    totals.output += row.output as number
  }
  return totals
}

export function usageOfBuckets(rows: readonly BucketRow[]): SessionCostUsage {
  const usage: SessionCostUsage = {}
  for (const row of rows) {
    const provider = (row.provider as string | null) ?? ''
    const model = row.model as string
    const period = (row.period as 'peak' | 'off' | null) ?? 'peak'
    const models = usage[provider] ?? (usage[provider] = {})
    const periods = models[model] ?? (models[model] = {})
    const prev = periods[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    periods[period] = {
      uncached: prev.uncached + (row.input as number),
      cacheRead: prev.cacheRead + (row.cache_read as number),
      cacheWrite: prev.cacheWrite + (row.cache_write as number),
      output: prev.output + (row.output as number),
    }
  }
  return usage
}

export function cacheHitOf(totals: { input: number; cacheRead: number; cacheWrite: number } | null): string | null {
  if (totals === null) return null
  const billed = totals.input + totals.cacheRead + totals.cacheWrite
  if (!(billed > 0)) return null
  const scaled = Math.trunc((totals.cacheRead / billed) * 100 * 100 + 1e-9)
  return `${Math.floor(scaled / 100)}.${String(scaled % 100).padStart(2, '0')}`
}

export function usageBuckets(env: QueryEnv, source: FamSource, windowed: boolean): BucketRow[] {
  const windowClause = windowed ? ` AND ${dayWindow('r')}` : ''
  const sql = `${source.prefix}, usage AS (
    SELECT r.provider AS provider, r.model AS model, r.period AS period,
      ${usageSumColumns()}
    FROM requests r JOIN fam f ON f.member = r.session_id
    WHERE r.is_inherited = 0 AND r.model IS NOT NULL${windowClause} GROUP BY r.provider, r.model, r.period) SELECT * FROM usage`
  return prepare(env, sql).all(source.params)
}

function costUsdOf(env: QueryEnv, usage: SessionCostUsage | null): number | null {
  const book = env.deps.pricing?.() ?? null
  if (book === null || usage === null) return null
  return calculateSessionCost(usage, book)
}

export interface CostReadValue {
  usd: number | null
  ready: boolean
  faces: CostPriceFace[]
  misses: CostPriceMiss[]
}

export function costReadOf(env: QueryEnv, usage: SessionCostUsage | null): CostReadValue {
  const book = env.deps.pricing?.() ?? null
  if (usage === null || book === null) return { usd: null, ready: book !== null, faces: [], misses: [] }
  const faces: CostPriceFace[] = []
  const misses: CostPriceMiss[] = []
  for (const lookup of priceLookupsOf(usage, book)) {
    if (lookup.face !== null) faces.push(faceOf(lookup.provider, lookup.model, lookup.face))
    else misses.push(missOf(lookup.provider, lookup.model, lookup.miss))
  }
  return { usd: calculateSessionCost(usage, book), ready: true, faces, misses }
}

export function sessionUsageOf(env: QueryEnv, sessionId: string): SessionCostUsage | null {
  const rows = prepare(env, `
    SELECT r.provider AS provider, r.model AS model, r.period AS period,
      ${usageSumColumns()}
    FROM requests r WHERE r.session_id = :sessionId AND r.is_inherited = 0 AND r.model IS NOT NULL
    GROUP BY r.provider, r.model, r.period`).all({ sessionId }) as BucketRow[]
  return rows.length === 0 ? null : usageOfBuckets(rows)
}

export interface Composition {
  readonly cats: Map<string, Map<string, number>>
  readonly assistant: Map<string, { reasoning: number; answers: number; calls: number }>
  readonly system: Map<string, number>
  readonly tools: Map<string, number>
}

export function compositionOf(env: QueryEnv, source: FamSource): Composition {
  const composition: Composition = { cats: new Map(), assistant: new Map(), system: new Map(), tools: new Map() }
  const surfaceSql = `${source.prefix}, m AS (
    SELECT sn.session_id AS id, sn.cat AS cat, SUM(sn.tokens) AS n,
      SUM(CASE WHEN sn.cat = 'assistant' THEN COALESCE(sn.reasoning_tokens, 0) ELSE 0 END) AS reasoning,
      SUM(CASE WHEN sn.cat = 'assistant' THEN COALESCE(sn.answer_tokens, 0) ELSE 0 END) AS answers,
      SUM(CASE WHEN sn.cat = 'assistant' THEN COALESCE(sn.call_tokens, 0) ELSE 0 END) AS calls
    FROM surface_nodes sn JOIN fam f ON f.member = sn.session_id
    WHERE sn.gone_seq IS NULL GROUP BY sn.session_id, sn.cat) SELECT * FROM m`
  for (const row of prepare(env, surfaceSql).all(source.params) as BucketRow[]) {
    absorbSurfaceRow(composition, row)
  }
  const systemSql = `${source.prefix}, m AS (
    SELECT sp.session_id AS id, sp.tokens AS tokens FROM system_prompts sp
    JOIN (SELECT sn2.session_id, MAX(sn2.seq) AS seq FROM system_prompts sn2 JOIN fam f2 ON f2.member = sn2.session_id
      WHERE sn2.tokens > 0 GROUP BY sn2.session_id) latest
    ON latest.session_id = sp.session_id AND latest.seq = sp.seq) SELECT * FROM m`
  for (const row of prepare(env, systemSql).all(source.params) as BucketRow[]) {
    composition.system.set(row.id as string, row.tokens as number)
  }
  const epochsSql = `${source.prefix}, m AS (
    SELECT he.session_id AS id, he.tools_tokens AS tokens FROM header_epochs he
    JOIN (SELECT sn2.session_id, MAX(sn2.seq) AS seq FROM header_epochs sn2 JOIN fam f2 ON f2.member = sn2.session_id
      GROUP BY sn2.session_id) latest
    ON latest.session_id = he.session_id AND latest.seq = he.seq) SELECT * FROM m`
  for (const row of prepare(env, epochsSql).all(source.params) as BucketRow[]) {
    composition.tools.set(row.id as string, row.tokens as number)
  }
  return composition
}

export function compositionForIds(env: QueryEnv, ids: readonly string[]): Composition {
  const composition: Composition = { cats: new Map(), assistant: new Map(), system: new Map(), tools: new Map() }
  if (ids.length === 0) return composition
  const surfaceSql = `SELECT session_id AS id, cat, SUM(tokens) AS n,
      SUM(CASE WHEN cat = 'assistant' THEN COALESCE(reasoning_tokens, 0) ELSE 0 END) AS reasoning,
      SUM(CASE WHEN cat = 'assistant' THEN COALESCE(answer_tokens, 0) ELSE 0 END) AS answers,
      SUM(CASE WHEN cat = 'assistant' THEN COALESCE(call_tokens, 0) ELSE 0 END) AS calls
    FROM surface_nodes WHERE session_id IN (${inList(ids, 'id')}) AND gone_seq IS NULL GROUP BY session_id, cat`
  for (const row of prepare(env, surfaceSql).all(idParamsOf(ids, 'id')) as BucketRow[]) {
    absorbSurfaceRow(composition, row)
  }
  const systemSql = `SELECT sp.session_id AS id, sp.tokens AS tokens FROM system_prompts sp
    JOIN (SELECT session_id, MAX(seq) AS seq FROM system_prompts
      WHERE session_id IN (${inList(ids, 'id')}) AND tokens > 0 GROUP BY session_id) latest
    ON latest.session_id = sp.session_id AND latest.seq = sp.seq`
  for (const row of prepare(env, systemSql).all(idParamsOf(ids, 'id')) as BucketRow[]) {
    composition.system.set(row.id as string, row.tokens as number)
  }
  const epochsSql = `SELECT he.session_id AS id, he.tools_tokens AS tokens FROM header_epochs he
    JOIN (SELECT session_id, MAX(seq) AS seq FROM header_epochs
      WHERE session_id IN (${inList(ids, 'id')}) GROUP BY session_id) latest
    ON latest.session_id = he.session_id AND latest.seq = he.seq`
  for (const row of prepare(env, epochsSql).all(idParamsOf(ids, 'id')) as BucketRow[]) {
    composition.tools.set(row.id as string, row.tokens as number)
  }
  return composition
}

function absorbSurfaceRow(composition: Composition, row: BucketRow): void {
  const id = row.id as string
  const byCat = composition.cats.get(id) ?? new Map<string, number>()
  byCat.set(row.cat as string, row.n as number)
  composition.cats.set(id, byCat)
  if (row.cat === 'assistant') {
    composition.assistant.set(id, {
      reasoning: row.reasoning as number,
      answers: row.answers as number,
      calls: row.calls as number,
    })
  }
}

export function curPartsOf(id: string, composition: Composition): OverviewPartTotal[] {
  const byCat = composition.cats.get(id) ?? new Map<string, number>()
  const current: Record<string, number> = {
    system: composition.system.get(id) ?? 0,
    tools: composition.tools.get(id) ?? 0,
    user: byCat.get('user') ?? 0,
    inject: byCat.get('inject') ?? 0,
    skill: byCat.get('skill') ?? 0,
    assistant: byCat.get('assistant') ?? 0,
    tool: byCat.get('tool') ?? 0,
  }
  const parts: OverviewPartTotal[] = []
  for (const category of CATS) {
    if (current[category.key] > 0) parts.push({ key: category.key, value: current[category.key] })
  }
  return parts
}

export function scalarCounts(env: QueryEnv, sql: string, ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>()
  if (ids.length === 0) return out
  const rows = prepare(env, sql.replace('#IDS#', inList(ids, 'id'))).all(idParamsOf(ids, 'id')) as BucketRow[]
  for (const row of rows) out.set(row.id as string, row.value as number)
  return out
}

export function scalarDayKeys(env: QueryEnv, sql: string, ids: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>()
  if (ids.length === 0) return out
  const rows = prepare(env, sql.replace('#IDS#', inList(ids, 'id'))).all(idParamsOf(ids, 'id')) as BucketRow[]
  for (const row of rows) out.set(row.id as string, row.value as string | null)
  return out
}

export function requestCountsOf(env: QueryEnv, ids: readonly string[]): Map<string, number> {
  return scalarCounts(env, 'SELECT session_id AS id, COUNT(*) AS value FROM requests WHERE session_id IN (#IDS#) GROUP BY session_id', ids)
}

export type CountMaps = {
  turns: Map<string, number>
  steps: Map<string, number>
  createdDays: Map<string, string | null>
  costs: Map<string, number | null>
}

const SUMMARY_TIMING_STEPS_SQL = (source: FamSource): string => `${source.prefix}, m AS (
    SELECT COALESCE(SUM(st.wall_ms), 0) AS wall, COALESCE(SUM(st.ttft_ms), 0) AS ttft,
      COALESCE(SUM(st.tool_busy_ms), 0) AS busy, COALESCE(SUM(st.idle_ms), 0) AS idle,
      EXISTS(SELECT 1 FROM steps s2 JOIN fam f2 ON f2.member = s2.session_id WHERE s2.end_time IS NOT NULL) AS any_step
    FROM steps st JOIN fam f ON f.member = st.session_id WHERE st.end_time IS NOT NULL
  ) SELECT wall, ttft, busy, idle, any_step FROM m`

const SUMMARY_TIMING_REQUESTS_SQL = (source: FamSource): string => `${source.prefix}, m AS (
    SELECT COUNT(*) AS calls, COALESCE(SUM(r.gen_ms), 0) AS gen,
      COALESCE(SUM(CASE WHEN r.gen_ms IS NOT NULL AND r.output_tokens IS NOT NULL THEN r.output_tokens ELSE 0 END), 0) AS speed_tokens,
      EXISTS(SELECT 1 FROM requests r2 JOIN fam f2 ON f2.member = r2.session_id
        WHERE r2.gen_ms IS NOT NULL AND r2.output_tokens IS NOT NULL) AS any_speed
    FROM requests r JOIN fam f ON f.member = r.session_id
  ) SELECT calls, gen, speed_tokens, any_speed FROM m`

const SUMMARY_TIMING_CALLS_SQL = (source: FamSource): string => `${source.prefix}, m AS (
    SELECT COUNT(*) AS tool_calls, COALESCE(SUM(tc.duration_ms), 0) AS tools_ms
    FROM tool_calls tc JOIN fam f ON f.member = tc.session_id
    WHERE tc.transport = 0 AND tc.result_seq IS NOT NULL
  ) SELECT tool_calls, tools_ms FROM m`

const SUMMARY_TIMING_SPANS_SQL = (source: FamSource): string => `${source.prefix}, m AS (
    SELECT sp.kind AS kind, COUNT(*) AS n, COALESCE(SUM(sp.end_time - sp.start_time), 0) AS ms
    FROM timing_spans sp JOIN fam f ON f.member = sp.session_id GROUP BY sp.kind
  ) SELECT kind, n, ms FROM m`

const SUMMARY_TIMING_TOOLS_SQL = (source: FamSource): string => `${source.prefix}, m AS (
    SELECT tc.name AS name, COUNT(*) AS calls, SUM(tc.duration_ms) AS ms
    FROM tool_calls tc JOIN fam f ON f.member = tc.session_id
    WHERE tc.transport = 0 AND tc.duration_ms IS NOT NULL GROUP BY tc.name
  ) SELECT name, calls, ms FROM m`

function toolsMapOf(rows: readonly BucketRow[]): Record<string, ToolTimingTotals> {
  const sorted = [...rows].sort((left, right) => (right.ms as number) - (left.ms as number)).slice(0, TIMING_TOOLS_MAX)
  const tools: Record<string, ToolTimingTotals> = {}
  for (const row of sorted) tools[row.name as string] = { calls: row.calls as number, ms: row.ms as number }
  return tools
}

export function timingOf(env: QueryEnv, source: FamSource): TimingTotals | null {
  const steps = prepare(env, SUMMARY_TIMING_STEPS_SQL(source)).get(source.params) as BucketRow
  const requests = prepare(env, SUMMARY_TIMING_REQUESTS_SQL(source)).get(source.params) as BucketRow
  if (steps.any_step === 0 && requests.calls === 0) return null
  const calls = prepare(env, SUMMARY_TIMING_CALLS_SQL(source)).get(source.params) as BucketRow
  const timing: TimingTotals = {
    wallMs: steps.wall as number,
    ttftMs: steps.ttft as number,
    genMs: requests.gen as number,
    calls: requests.calls as number,
    toolsMs: calls.tools_ms as number,
    toolCalls: calls.tool_calls as number,
    tools: toolsMapOf(prepare(env, SUMMARY_TIMING_TOOLS_SQL(source)).all(source.params)),
    toolBusyMs: steps.busy as number,
  }
  if ((steps.idle as number) > 0) timing.idleMs = steps.idle as number
  if (requests.any_speed === 1) {
    timing.speedTokens = requests.speed_tokens as number
    timing.speedMs = requests.gen as number
  }
  for (const row of prepare(env, SUMMARY_TIMING_SPANS_SQL(source)).all(source.params) as BucketRow[]) {
    if (row.kind === 'reasoning') {
      timing.reasoningMs = row.ms as number
      timing.reasoningBlocks = row.n as number
    } else if (row.kind === 'text') {
      timing.textMs = row.ms as number
      timing.textBlocks = row.n as number
    } else if (row.kind === 'toolarg') {
      timing.toolArgMs = row.ms as number
      timing.toolArgBlocks = row.n as number
    }
  }
  return timing
}

export function windowTimingOf(env: QueryEnv, source: FamSource): { calls: number; tool_calls: number; tools_ms: number; wall_ms: number } {
  const calls = prepare(env, `${source.prefix}, m AS (
    SELECT COUNT(*) AS calls FROM requests r JOIN fam f ON f.member = r.session_id
    WHERE r.is_inherited = 0 AND ${dayWindow('r')}
  ) SELECT calls FROM m`).get(source.params) as { calls: number }
  const tools = prepare(env, `${source.prefix}, m AS (
    SELECT COALESCE(SUM(CASE WHEN tc.result_seq IS NOT NULL THEN 1 ELSE 0 END), 0) AS tool_calls,
      COALESCE(SUM(CASE WHEN tc.duration_ms IS NOT NULL THEN tc.duration_ms ELSE 0 END), 0) AS tools_ms
    FROM tool_calls tc JOIN fam f ON f.member = tc.session_id
    WHERE tc.transport = 0 AND ${dayWindow('tc')}
  ) SELECT tool_calls, tools_ms FROM m`).get(source.params) as { tool_calls: number; tools_ms: number }
  const steps = prepare(env, `${source.prefix}, m AS (
    SELECT COALESCE(SUM(st.wall_ms), 0) AS wall_ms FROM steps st JOIN fam f ON f.member = st.session_id
    WHERE st.end_time IS NOT NULL AND ${dayWindow('st')}
  ) SELECT wall_ms FROM m`).get(source.params) as { wall_ms: number }
  return { calls: calls.calls, tool_calls: tools.tool_calls, tools_ms: tools.tools_ms, wall_ms: steps.wall_ms }
}

export interface UsageTotals {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

interface MemberStats {
  readonly hasUsage: number
  readonly totals: UsageTotals
  readonly generated: { reasoning: number; answers: number; calls: number }
}

function memberStatsOf(env: QueryEnv, source: FamSource): Map<string, MemberStats> {
  const windowed = `r.model IS NOT NULL AND (r.input_tokens IS NOT NULL OR r.cache_read_tokens IS NOT NULL
          OR r.cache_write_tokens IS NOT NULL OR r.output_tokens IS NOT NULL) AND ${dayWindow('r')}`
  const sql = `${source.prefix}, m AS (
    SELECT r.session_id AS id,
      MAX(CASE WHEN ${windowed} THEN 1 ELSE 0 END) AS has_usage,
      SUM(CASE WHEN ${windowed} THEN COALESCE(r.input_tokens, 0) ELSE 0 END) AS input,
      SUM(CASE WHEN ${windowed} THEN COALESCE(r.cache_read_tokens, 0) ELSE 0 END) AS cache_read,
      SUM(CASE WHEN ${windowed} THEN COALESCE(r.cache_write_tokens, 0) ELSE 0 END) AS cache_write,
      SUM(CASE WHEN ${windowed} THEN COALESCE(r.output_tokens, 0) ELSE 0 END) AS output,
      SUM(CASE WHEN r.reasoning_tokens IS NOT NULL THEN CASE WHEN r.output_tokens IS NOT NULL
          THEN min(r.reasoning_tokens, r.output_tokens) ELSE r.reasoning_tokens END
        ELSE COALESCE(sn.reasoning_tokens, 0) END) AS reasoning,
      SUM(COALESCE(sn.answer_tokens, 0)) AS answers, SUM(COALESCE(sn.call_tokens, 0)) AS calls
    FROM requests r JOIN fam f ON f.member = r.session_id
    LEFT JOIN surface_nodes sn ON sn.session_id = r.session_id AND sn.seq = r.seq
    WHERE r.is_inherited = 0
    GROUP BY r.session_id) SELECT * FROM m`
  const out = new Map<string, MemberStats>()
  for (const row of prepare(env, sql).all(source.params) as BucketRow[]) {
    out.set(row.id as string, {
      hasUsage: row.has_usage as number,
      totals: {
        input: row.input as number,
        cacheRead: row.cache_read as number,
        cacheWrite: row.cache_write as number,
        output: row.output as number,
      },
      generated: {
        reasoning: row.reasoning as number,
        answers: row.answers as number,
        calls: row.calls as number,
      },
    })
  }
  return out
}

function tokenPartsOf(env: QueryEnv, source: FamSource): OverviewPartTotal[] | null {
  const composition = compositionOf(env, source)
  const stats = memberStatsOf(env, source)
  const sums = new Map<string, number>()
  let any = false
  for (const [id, stat] of stats) {
    if (stat.hasUsage === 0) continue
    const byCat = composition.cats.get(id) ?? new Map<string, number>()
    const assistant = composition.assistant.get(id) ?? { reasoning: 0, answers: 0, calls: 0 }
    const totals = stat.totals
    const gen = stat.generated
    const parts = billedParts({
      system: composition.system.get(id) ?? 0,
      tools: composition.tools.get(id) ?? 0,
      user: byCat.get('user') ?? 0,
      inject: byCat.get('inject') ?? 0,
      skill: byCat.get('skill') ?? 0,
      assistant: byCat.get('assistant') ?? 0,
      assistantReasoning: assistant.reasoning,
      assistantAnswerTokens: assistant.answers,
      assistantCallTokens: assistant.calls,
      tool: byCat.get('tool') ?? 0,
      total: 0,
    }, null, {
      uncachedInputTokens: totals.input,
      cacheReadTokens: totals.cacheRead,
      cacheWriteTokens: totals.cacheWrite,
      outputTokens: totals.output,
    }, { reasoning: gen.reasoning, answers: gen.answers, calls: gen.calls })
    any = true
    for (const part of parts) {
      if (!Number.isFinite(part.value) || part.value <= 0) continue
      sums.set(part.key, (sums.get(part.key) ?? 0) + part.value)
    }
  }
  if (!any) return null
  const out: OverviewPartTotal[] = []
  for (const key of RING_ORDER) {
    const value = sums.get(key)
    if (value === undefined || value <= 0) continue
    out.push({ key, value })
  }
  return out
}

const PART_FIELDS = ['kpi', 'tokens', 'usage', 'timing', 'cost'] as const

type SummaryPart = (typeof PART_FIELDS)[number]

const SUMMARY_PARTS = new Set<string>(PART_FIELDS)

function partsSetOf(body: QueryRow): Set<SummaryPart> {
  const raw = body.parts
  if (raw === undefined || raw === null) return new Set(PART_FIELDS)
  if (!Array.isArray(raw)) queryFailure('dsh-context/bad-request', 'parts must be an array')
  const parts = new Set<SummaryPart>()
  for (const entry of raw) {
    if (typeof entry !== 'string' || !SUMMARY_PARTS.has(entry)) queryFailure('dsh-context/bad-request', 'unknown part')
    parts.add(entry as SummaryPart)
  }
  return parts
}

function usageSessionsOf(env: QueryEnv, source: FamSource): number {
  const sql = `${source.prefix}, m AS (
    SELECT f.root AS id, MAX(CASE WHEN r.model IS NOT NULL AND (r.input_tokens IS NOT NULL OR r.cache_read_tokens IS NOT NULL
        OR r.cache_write_tokens IS NOT NULL OR r.output_tokens IS NOT NULL) THEN 1 ELSE 0 END) AS has
    FROM requests r JOIN fam f ON f.member = r.session_id
    WHERE r.is_inherited = 0 AND ${dayWindow('r')}
    GROUP BY f.root) SELECT COUNT(*) AS n FROM m WHERE has = 1`
  return (prepare(env, sql).get(source.params) as { n: number }).n
}

function costSessionsOf(env: QueryEnv, source: FamSource): number {
  const book = env.deps.pricing?.() ?? null
  if (book === null) return 0
  const sql = `${source.prefix}, m AS (
    SELECT DISTINCT f.root AS id, r.provider AS provider, r.model AS model
    FROM requests r JOIN fam f ON f.member = r.session_id
    WHERE r.is_inherited = 0 AND r.model IS NOT NULL AND (r.input_tokens IS NOT NULL OR r.cache_read_tokens IS NOT NULL
      OR r.cache_write_tokens IS NOT NULL OR r.output_tokens IS NOT NULL)
      AND ${dayWindow('r')}
  ) SELECT id, provider, model FROM m`
  const byRoot = groupRowsBy(prepare(env, sql).all(source.params), 'id')
  let count = 0
  for (const models of byRoot.values()) {
    if (models.every(row => priceFaceOf(book, (row.provider as string | null) ?? '', row.model as string) !== null)) count++
  }
  return count
}

export function groupRowsBy(rows: readonly BucketRow[], field: string): Map<string, BucketRow[]> {
  const byKey = new Map<string, BucketRow[]>()
  for (const row of rows) {
    const key = row[field] as string
    const list = byKey.get(key) ?? []
    list.push(row)
    byKey.set(key, list)
  }
  return byKey
}

function summaryRoute(env: QueryEnv, body: QueryRow): unknown {
  const parts = partsSetOf(body)
  const scope = scopeOf(body, env.now())
  const source = famSourceOfFilter({ scope, withGroup: true, withPick: true })
  const counts: Record<string, unknown> = {}
  const value: Record<string, unknown> = { counts, coverage: env.deps.coverage?.() ?? ZEROED_COVERAGE }
  if (parts.has('kpi')) {
    const row = prepare(env, matchedRootsSql({ scope, withGroup: true, withPick: true }, `,
      matched AS (SELECT COUNT(*) AS sessions,
        COALESCE(SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END), 0) AS archived
        FROM (SELECT DISTINCT s.id, s.archived AS archived FROM sessions s JOIN roots r ON r.id = s.id))
      SELECT m.sessions, m.archived,
        (SELECT COUNT(*) FROM sessions s2 WHERE s2.blank = 0 AND COALESCE(s2.origin, '') != 'subagent' AND s2.vanished_at IS NULL) AS sessions_total
      FROM matched m`)).get(source.params) as BucketRow
    counts.sessions = row.sessions
    counts.sessions_total = row.sessions_total
    counts.sessions_archived = row.archived
    counts.archived_scoped = row.archived
    value.turns = (prepare(env, `${source.prefix}, m AS (
      SELECT COALESCE(SUM(r.starts_turn), 0) AS turns FROM requests r JOIN fam f ON f.member = r.session_id
      WHERE r.is_inherited = 0 AND ${dayWindow('r')}
    ) SELECT turns FROM m`).get(source.params) as { turns: number }).turns
  }
  if (parts.has('tokens') || parts.has('cost') || parts.has('usage')) {
    const buckets = usageBuckets(env, source, true)
    const totals = bucketTotalsOf(buckets)
    if (parts.has('tokens')) {
      value.tokens = totals === null ? 0 : totals.input + totals.cacheRead + totals.cacheWrite + totals.output
      value.cache_hit = cacheHitOf(totals)
      value.token_parts = tokenPartsOf(env, source)
    }
    if (parts.has('usage')) {
      value.usage_sessions = usageSessionsOf(env, source)
      value.cost_sessions = costSessionsOf(env, source)
    }
    if (parts.has('cost')) {
      value.cost_usd = costUsdOf(env, buckets.length === 0 ? null : usageOfBuckets(buckets))
    }
  }
  if (parts.has('timing')) {
    value.timing = timingOf(env, source)
    value.window_timing = windowTimingOf(env, source)
  }
  return value
}

export const metricRoutes: QueryRouteSpec[] = [
  { path: 'summary', run: summaryRoute },
]
