import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { ModelBook } from '../../shared/pricing'
import { dayKeyOf } from '../../shared/days'
import type { BackfillCoverage, OverviewCoverage, OverviewPartTotal, OverviewRange } from '../../shared/types'
import { failure, readBody, reply } from '../postRoute'
import { windowOf, type Window } from '../overviewAggregate'
import type { StoreHandle } from './store'
import { metricRoutes } from './queryAggregates'
import { listRoutes } from './queryList'
import { sessionRoutes } from './querySession'

export interface QueryRoute {
  readonly path: string
  readonly fetch: (request: Request) => Promise<Response>
}

export interface QueryRoutesDeps {
  readonly pricing?: () => ModelBook | null
  readonly harnessSupported?: boolean
  readonly backfillRunning?: () => boolean
  readonly coverage?: () => BackfillCoverage
  readonly workspaceTitles?: () => readonly string[]
  readonly now?: () => number
}

export interface QueryEnv {
  readonly db: DatabaseSync
  readonly handle: StoreHandle
  readonly deps: QueryRoutesDeps
  readonly now: () => number
  readonly statements: Map<string, StatementSync>
}

export class QueryError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function queryFailure(code: string, message: string): never {
  throw new QueryError(code, message)
}

export const LIMIT_MAX = 500

export const QUERY_MAX_CHARS = 500

export const IDS_MAX = 256

export const UNGROUPED_KEY = '__ungrouped__'

export const PAGE_SIZE = 12

export type QueryRow = Record<string, unknown>

const PREPARED_MAX = 192

export function prepare(env: QueryEnv, sql: string): StatementSync {
  const cached = env.statements.get(sql)
  if (cached !== undefined) return cached
  const prepared = env.db.prepare(sql)
  env.statements.set(sql, prepared)
  if (env.statements.size > PREPARED_MAX) {
    for (const key of env.statements.keys()) {
      env.statements.delete(key)
      break
    }
  }
  return prepared
}

export function optionalIntOf(body: QueryRow, field: string): number | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    queryFailure('dsh-context/bad-request', `${field} must be a number`)
  }
  return Math.floor(value)
}

export function limitOf(body: QueryRow, field: string, fallback: number): number {
  const value = optionalIntOf(body, field)
  if (value === undefined) return fallback
  if (value < 1 || value > LIMIT_MAX) {
    queryFailure('dsh-context/bad-request', `${field} must be between 1 and ${LIMIT_MAX}`)
  }
  return value
}

export function sessionIdOf(body: QueryRow): string {
  const value = body.sessionId
  if (typeof value !== 'string' || value === '') {
    queryFailure('dsh-context/bad-request', 'missing sessionId')
  }
  return value
}

export function optionalSessionIdOf(body: QueryRow): string | undefined {
  const value = body.sessionId
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value === '') {
    queryFailure('dsh-context/bad-request', 'sessionId must be a non-empty string')
  }
  return value
}

export function textOf(body: QueryRow, field: string, max: number): string | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    queryFailure('dsh-context/bad-request', `${field} must be a string`)
  }
  if (value.length > max) {
    queryFailure('dsh-context/bad-request', `${field} must contain at most ${max} characters`)
  }
  return value
}

export function idsOf(body: QueryRow): string[] | undefined {
  const value = body.ids
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) {
    queryFailure('dsh-context/bad-request', 'ids must be an array of strings')
  }
  if (value.length > IDS_MAX) {
    queryFailure('dsh-context/bad-request', `ids must contain at most ${IDS_MAX} entries`)
  }
  return value as string[]
}

export function enumOf<T extends string>(body: QueryRow, field: string, allowed: ReadonlySet<T>, message: string): T {
  const value = body[field]
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    queryFailure('dsh-context/bad-request', message)
  }
  return value as T
}

export const COVERAGES = new Set<OverviewCoverage>(['all', 'active', 'archived'])

export const SORTS = new Set<'recent' | 'tokens' | 'context'>(['recent', 'tokens', 'context'])

const PICK_FIELDS = new Set<'skills' | 'tools' | 'programs'>(['skills', 'tools', 'programs'])

const RANGES = new Set<string>(['today', '7d', '30d'])

export interface QueryScope {
  readonly window: Window
  readonly day: string | null
  readonly coverage: OverviewCoverage
  readonly group: string | null
  readonly query: string
  readonly model: string | null
  readonly running: boolean | null
  readonly pick: { field: 'skills' | 'tools' | 'programs'; name: string } | null
  readonly floor: string | null
  readonly ceiling: string | null
}

export function rangeOf(value: unknown): OverviewRange {
  if (typeof value === 'string' && RANGES.has(value)) return value as OverviewRange
  if (value !== null && typeof value === 'object') {
    const data = value as { start?: unknown; end?: unknown }
    if (typeof data.start === 'number' && Number.isFinite(data.start)
      && typeof data.end === 'number' && Number.isFinite(data.end)) {
      return { start: data.start, end: data.end }
    }
  }
  return '30d'
}

export function scopeOf(body: QueryRow, now: number): QueryScope {
  const raw = body.scope
  const data: QueryRow = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as QueryRow : {}
  const coverageRaw = data.coverage
  if (coverageRaw !== undefined && coverageRaw !== null
    && (typeof coverageRaw !== 'string' || !COVERAGES.has(coverageRaw as OverviewCoverage))) {
    queryFailure('dsh-context/bad-request', 'unknown coverage')
  }
  const coverage = (coverageRaw as OverviewCoverage | undefined) ?? 'all'
  const day = textOf(data, 'day', 32)
  const group = textOf(data, 'group', 200)
  const query = textOf(data, 'query', QUERY_MAX_CHARS)
  const model = textOf(data, 'model', 200)
  const runningRaw = data.running
  if (runningRaw !== undefined && runningRaw !== null && typeof runningRaw !== 'boolean') {
    queryFailure('dsh-context/bad-request', 'running must be a boolean')
  }
  const pickRaw = data.pick
  let pick: QueryScope['pick'] = null
  if (pickRaw !== undefined && pickRaw !== null) {
    if (typeof pickRaw !== 'object' || Array.isArray(pickRaw)) {
      queryFailure('dsh-context/bad-request', 'pick must be an object')
    }
    const pickData = pickRaw as QueryRow
    const field = enumOf(pickData, 'field', PICK_FIELDS, 'unknown pick.field')
    const name = textOf(pickData, 'name', 200)
    if (name === undefined) queryFailure('dsh-context/bad-request', 'missing pick.name')
    pick = { field, name }
  }
  const range = data.range === undefined || data.range === null ? '30d' : rangeOf(data.range)
  const window = windowOf(range, day ?? null, now)
  return {
    window,
    day: day ?? null,
    coverage,
    group: group ?? null,
    query: (query ?? '').trim().toLowerCase(),
    model: model ?? null,
    running: typeof runningRaw === 'boolean' ? runningRaw : null,
    pick,
    floor: dayKeyOf(window.start),
    ceiling: window.end === null ? null : dayKeyOf(window.end),
  }
}

export interface SessionRow {
  id: string
  title: string
  cwd?: string
  archived: boolean
  running: boolean
  workspace_title?: string
  updated_at: number
  created_at: number
  billed_tokens: number
  cur_total: number
  cur_parts: OverviewPartTotal[]
  turns: number
  steps: number
  model?: string
  context_window?: number
  max_output_tokens?: number
  last_user?: string
  parent_session?: string
  origin?: 'subagent'
  fold_status: 'pending' | 'ok' | 'failed' | 'unsupported' | 'folding'
  cost_usd: number | null
  created_day?: string
}

const ROOT_BASE = "s.blank = 0 AND COALESCE(s.origin, '') != 'subagent' AND s.vanished_at IS NULL"

export const ROOT_BASE_SQL = ROOT_BASE

export interface RootFilter {
  readonly scope: QueryScope
  readonly withGroup: boolean
  readonly withPick: boolean
}

interface PickSource {
  readonly table: string
  readonly filter: string
}

const PICK_SOURCES: Record<'skills' | 'tools' | 'programs', PickSource> = {
  skills: { table: 'skill_loads', filter: 'x.name = :pickName' },
  tools: { table: 'tool_calls', filter: 'x.name = :pickName AND x.result_seq IS NOT NULL' },
  programs: { table: 'tool_calls', filter: 'x.program = :pickName' },
}

export function dayWindow(alias: string): string {
  return `(${alias}.day >= :dayFloor OR :dayFloor IS NULL) AND (${alias}.day <= :dayCeiling OR :dayCeiling IS NULL)`
}

export function usageSumColumns(): string {
  return 'SUM(COALESCE(r.input_tokens, 0)) AS input, SUM(COALESCE(r.cache_read_tokens, 0)) AS cache_read,'
    + ' SUM(COALESCE(r.cache_write_tokens, 0)) AS cache_write, SUM(COALESCE(r.output_tokens, 0)) AS output'
}

export function famCteBody(name: string, initial: string): string {
  return `${name}(member, root, depth) AS (
    ${initial}
    UNION ALL
    SELECT s.id, ${name}.root, ${name}.depth + 1 FROM sessions s JOIN ${name}
      ON s.parent_session = ${name}.member AND s.origin = 'subagent' AND s.blank = 0
    WHERE ${name}.depth < 16
  )`
}

export function sessionOrScopeOf(body: QueryRow, route: string): { sessionId: string | undefined; hasScope: boolean } {
  const sessionId = optionalSessionIdOf(body)
  const hasScope = body.scope !== undefined && body.scope !== null
  if (sessionId === undefined && !hasScope) {
    queryFailure('dsh-context/bad-request', `${route} requires sessionId or scope`)
  }
  if (sessionId !== undefined && hasScope) {
    queryFailure('dsh-context/bad-request', `${route} takes sessionId or scope, not both`)
  }
  return { sessionId, hasScope }
}

function staticFilterSql(filter: RootFilter): string {
  const scope = filter.scope
  let where = ''
  if (scope.coverage === 'active') where += ' AND s.archived = 0'
  else if (scope.coverage === 'archived') where += ' AND s.archived = 1'
  if (filter.withGroup && scope.group !== null) {
    where += scope.group === UNGROUPED_KEY ? ' AND s.workspace_title IS NULL' : ' AND s.workspace_title = :group'
  }
  if (scope.query !== '') {
    where += " AND (instr(lower(COALESCE(s.title, '')), :query) > 0"
      + " OR instr(lower(COALESCE(s.cwd, '')), :query) > 0"
      + " OR instr(lower(COALESCE(s.last_user, '')), :query) > 0)"
  }
  if (scope.running !== null) where += ' AND s.running = :running'
  if (scope.model !== null) where += ' AND s.model = :model'
  return where
}

function familyFilterSql(filter: RootFilter): string {
  const scope = filter.scope
  let where = ` AND (rs.updated_at >= :windowStart AND (:windowEnd IS NULL OR rs.updated_at <= :windowEnd)
    OR EXISTS (SELECT 1 FROM requests r WHERE r.session_id = f.member AND r.is_inherited = 0 AND ${dayWindow('r')}))`
  if (scope.day !== null) {
    where += ` AND EXISTS (SELECT 1 FROM requests r WHERE r.session_id = f.member AND r.is_inherited = 0
      AND r.day >= :dayFloor AND r.day <= :dayCeiling)`
  }
  if (filter.withPick && scope.pick !== null) {
    const source = PICK_SOURCES[scope.pick.field]
    where += ` AND EXISTS (SELECT 1 FROM fam_all p JOIN ${source.table} x ON x.session_id = p.member
      WHERE p.root = f.root AND ${source.filter} AND ${dayWindow('x')})`
  }
  return where
}

export function rootParams(filter: RootFilter): Record<string, string | number | null> {
  const scope = filter.scope
  const params: Record<string, string | number | null> = {
    windowStart: scope.window.start,
    windowEnd: scope.window.end,
    dayFloor: scope.day ?? scope.floor,
    dayCeiling: scope.day ?? scope.ceiling,
  }
  if (filter.withGroup && scope.group !== null && scope.group !== UNGROUPED_KEY) params.group = scope.group
  if (scope.query !== '') params.query = scope.query
  if (scope.running !== null) params.running = scope.running ? 1 : 0
  if (scope.model !== null) params.model = scope.model
  if (filter.withPick && scope.pick !== null) params.pickName = scope.pick.name
  return params
}

export function matchedRootsSql(filter: RootFilter, tail: string): string {
  return `WITH RECURSIVE ${famCteBody('fam_all', `SELECT id, id, 0 FROM sessions s WHERE ${ROOT_BASE}${staticFilterSql(filter)}`)}
  , roots AS (
    SELECT DISTINCT f.root AS id FROM fam_all f JOIN sessions rs ON rs.id = f.root WHERE 1 = 1${familyFilterSql(filter)}
  ), ${famCteBody('fam', 'SELECT id, id, 0 FROM roots')}${tail}`
}

export function idParamsOf(ids: readonly (string | number)[], prefix: string): Record<string, string | number> {
  const params: Record<string, string | number> = {}
  ids.forEach((id, index) => { params[`${prefix}${index}`] = id })
  return params
}

export function inList(ids: readonly (string | number)[], prefix: string): string {
  return ids.map((_, index) => `:${prefix}${index}`).join(', ')
}

export function titleOf(title: string | null, cwd: string | null, id: string): string {
  if (title !== null && title !== '') return title
  if (cwd !== null) {
    const base = workspaceTitleOf(cwd)
    if (base !== '') return base
  }
  return id
}

export interface QueryRouteSpec {
  readonly path: string
  readonly run: (env: QueryEnv, body: QueryRow) => unknown
}

const QUERY_ROUTE_PREFIX = '/api/dsh-context/query'

function gateOf(env: QueryEnv, body: QueryRow): boolean {
  const generation = optionalIntOf(body, 'generation')
  if (generation !== undefined) {
    const pricing = optionalIntOf(body, 'pricing_version')
    if (generation === env.handle.generation()
      && (pricing === undefined || pricing === env.handle.pricingVersion())) {
      return true
    }
  }
  const detailRev = optionalIntOf(body, 'detailRev')
  if (detailRev !== undefined) {
    const sessionId = body.sessionId
    if (typeof sessionId === 'string' && sessionId !== '') {
      const row = prepare(env, 'SELECT detail_rev FROM sessions WHERE id = ?').get(sessionId) as
        | { detail_rev: number }
        | undefined
      if (row !== undefined && row.detail_rev === detailRev) return true
    }
  }
  return false
}

export function createQueryRoutes(handle: StoreHandle, deps: QueryRoutesDeps = {}): QueryRoute[] {
  const env: QueryEnv = { db: handle.db, handle, deps, now: deps.now ?? (() => Date.now()), statements: new Map() }
  const specs: QueryRouteSpec[] = [...listRoutes, ...metricRoutes, ...sessionRoutes]
  return specs.map((spec) => {
    const path = `${QUERY_ROUTE_PREFIX}/${spec.path}`
    return {
      path,
      fetch: async (request: Request): Promise<Response> => {
        const read = await readBody(request)
        if (!read.ok) return read.response
        const body = read.body
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return failure('dsh-context/bad-request', 'body must be an object')
        }
        try {
          if (gateOf(env, body as QueryRow)) {
            return reply({ ok: true, generation: env.handle.generation(), unchanged: true })
          }
          const value = spec.run(env, body as QueryRow)
          return reply({
            ok: true,
            value,
            generation: env.handle.generation(),
            pricing_version: env.handle.pricingVersion(),
          })
        } catch (error) {
          if (error instanceof QueryError) return failure(error.code, error.message)
          return failure('gateway/internal', String(error))
        }
      },
    }
  })
}
