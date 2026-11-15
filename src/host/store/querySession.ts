import type { CommandRecord, ContextEventRecord, FileOpRecord, RequestRecord, SurfaceNode, TimingSpan } from '../../shared/types'
import { attachTurnSpans } from '../../shared/turnSpans'
import {
  dayWindow, enumOf, idParamsOf, inList, limitOf, optionalIntOf, optionalSessionIdOf,
  prepare, queryFailure, scopeOf, sessionIdOf, sessionOrScopeOf, textOf,
  type QueryEnv, type QueryRow, type QueryRouteSpec,
} from './query'
import { costReadOf, curPartsOf, compositionOf, famSourceOfFilter, sessionUsageOf, timingOf, type FamSource } from './queryAggregates'

function famSourceOfOne(sessionId: string): FamSource {
  return {
    prefix: 'WITH fam(member, root, depth) AS (SELECT :sessionId, :sessionId, 0)',
    params: { sessionId },
  }
}

const SYSTEMS_TAIL = 8

const EPOCHS_TAIL = 50

const SLOW_MS = 10_000

const COMMANDS_LIMIT = 400

const EVENTS_LIMIT = 400

const NODES_LIMIT = 500

const ARCHIVE_LIMIT = 400

const TIMING_SPANS_LIMIT = 500

const REQUESTS_LIMIT = 500

const STEPS_LIMIT = 500

const FILE_OPS_LIMIT = 400

const SKILL_LOADS_LIMIT = 500

const EVENT_KINDS = new Set(['inject', 'compaction', 'prune', 'model', 'mode'])

const FILE_KINDS = new Set(['read', 'write', 'search'])

const COMMAND_STATUS_FILTERS = new Set(['failed', 'slow', 'background'])

const COMMAND_SORTS: ReadonlySet<'latest' | 'slowest'> = new Set(['latest', 'slowest'])

function sessionRow(env: QueryEnv, sessionId: string): Record<string, unknown> | undefined {
  return prepare(env, `SELECT id, fold_status, detail_rev, cur_total, last_user, fold_error, model, provider,
      context_window, max_output_tokens, reasoning_effort FROM sessions WHERE id = ?`).get(sessionId)
}

function scalarCount(env: QueryEnv, sql: string, params: Record<string, string | number | null>): number {
  return (prepare(env, sql).get(params) as { n: number }).n
}

function injectCountOf(env: QueryEnv, sessionId: string): number {
  return scalarCount(env, `SELECT
      (SELECT COUNT(*) FROM events WHERE session_id = :sessionId AND kind = 'inject')
      + (SELECT COUNT(*) FROM skill_loads WHERE session_id = :sessionId AND source = 'result') AS n`,
  { sessionId })
}

function contextRoute(env: QueryEnv, body: QueryRow): unknown {
  const sessionId = sessionIdOf(body)
  const row = sessionRow(env, sessionId)
  if (row === undefined) return null
  const source = famSourceOfOne(sessionId)
  const composition = compositionOf(env, source)
  const counts: Record<string, unknown> = {
    turns: wireTurnsOf(env, sessionId),
    steps: scalarCount(env, 'SELECT COUNT(*) AS n FROM steps WHERE session_id = :sessionId AND end_time IS NOT NULL', { sessionId }),
    injects: injectCountOf(env, sessionId),
    compactions: scalarCount(env, "SELECT COUNT(*) AS n FROM events WHERE session_id = :sessionId AND kind = 'compaction'", { sessionId }),
    prunes: scalarCount(env, "SELECT COUNT(*) AS n FROM events WHERE session_id = :sessionId AND kind = 'prune'", { sessionId }),
    skills: distinctSkillNamesOf(env, sessionId),
  }
  const value: Record<string, unknown> = {
    rev: row.detail_rev,
    fold_status: row.fold_status,
    cur_total: row.cur_total,
    cur_parts: curPartsOf(sessionId, composition),
    counts,
    timing: timingOf(env, source),
    systems: systemsTail(env, sessionId),
    epochs: epochsTail(env, sessionId),
    cost_read: costReadOf(env, sessionUsageOf(env, sessionId)),
  }
  const lastUser = row.last_user as string | null
  if (lastUser !== null) value.last_user = lastUser
  const model = row.model as string | null
  if (model !== null) value.model = model
  const provider = row.provider as string | null
  if (provider !== null) value.provider = provider
  const contextWindow = row.context_window as number | null
  if (contextWindow !== null) value.context_window = contextWindow
  const maxOutput = row.max_output_tokens as number | null
  if (maxOutput !== null) value.max_output_tokens = maxOutput
  const reasoningEffort = row.reasoning_effort as string | null
  if (reasoningEffort !== null) value.reasoning_effort = reasoningEffort
  const foldError = row.fold_error as string | null
  if (foldError !== null) value.fold_error = foldError
  return value
}

function wireTurnsOf(env: QueryEnv, sessionId: string): number {
  const rows = prepare(env, `SELECT COALESCE(SUM(starts_turn), 0) AS turns
    FROM requests WHERE session_id = :sessionId AND is_inherited = 0`,
  ).all({ sessionId }) as Array<{ turns: number }>
  return rows[0].turns
}

function distinctSkillNamesOf(env: QueryEnv, sessionId: string): number {
  return scalarCount(env, 'SELECT COUNT(DISTINCT name) AS n FROM skill_loads WHERE session_id = :sessionId', { sessionId })
}

function systemsTail(env: QueryEnv, sessionId: string): Array<Record<string, unknown>> {
  const rows = prepare(env,
    'SELECT seq, time, tokens FROM system_prompts WHERE session_id = :sessionId ORDER BY seq DESC LIMIT :tail',
  ).all({ sessionId, tail: SYSTEMS_TAIL }) as Array<Record<string, unknown>>
  return rows.reverse().map(row => ({ seq: row.seq as number, time: row.time as number, tokens: row.tokens as number }))
}

function epochsTail(env: QueryEnv, sessionId: string): Array<Record<string, unknown>> {
  const rows = prepare(env, `SELECT seq, time, tools_tokens, reason FROM header_epochs
      WHERE session_id = :sessionId ORDER BY seq DESC LIMIT :tail`).all({ sessionId, tail: EPOCHS_TAIL }) as
    Array<Record<string, unknown>>
  rows.reverse()
  if (rows.length === 0) return []
  const epochSeqs = rows.map(row => row.seq as number)
  const toolRows = prepare(env, `SELECT epoch_seq, ordinal, name, tokens, plugin FROM header_tools
      WHERE session_id = :sessionId AND epoch_seq IN (${inList(epochSeqs, 'epoch')})
      ORDER BY epoch_seq ASC, ordinal ASC`).all({ sessionId, ...idParamsOf(epochSeqs, 'epoch') }) as
    Array<Record<string, unknown>>
  const toolsByEpoch = new Map<number, Array<Record<string, unknown>>>()
  for (const tool of toolRows) {
    const list = toolsByEpoch.get(tool.epoch_seq as number) ?? []
    list.push(tool)
    toolsByEpoch.set(tool.epoch_seq as number, list)
  }
  return rows.map((row) => {
    const seq = row.seq as number
    const out: Record<string, unknown> = {
      seq,
      time: row.time,
      tools_tokens: row.tools_tokens,
      tools: (toolsByEpoch.get(seq) ?? []).map(tool => ({
        name: tool.name as string,
        tokens: tool.tokens as number,
        ...(tool.plugin === null ? {} : { plugin: tool.plugin as string }),
      })),
    }
    const reason = row.reason as string | null
    if (reason !== null) out.reason = reason
    return out
  })
}

function surfaceNodeOf(row: Record<string, unknown>): SurfaceNode {
  const node: SurfaceNode = {
    seq: row.seq as number,
    cat: row.cat as SurfaceNode['cat'],
    tokens: row.tokens as number,
  }
  const time = row.time as number | null
  if (time !== null) node.time = time
  const reasoning = row.reasoning_tokens as number | null
  if (reasoning !== null) node.reasoning = reasoning
  const answerTokens = row.answer_tokens as number | null
  if (answerTokens !== null) node.answerTokens = answerTokens
  const callTokens = row.call_tokens as number | null
  if (callTokens !== null) node.callTokens = callTokens
  const imgs = row.imgs as number | null
  if (imgs !== null) node.imgs = imgs
  const form = row.form as string | null
  if (form !== null) node.form = form
  const name = row.name as string | null
  if (name !== null) node.name = name
  const tool = row.tool as string | null
  if (tool !== null) node.tool = tool
  const skill = row.skill as string | null
  if (skill !== null) node.skill = skill
  const agent = row.agent as string | null
  if (agent !== null) node.agent = agent
  if (row.is_error === 1) node.err = true
  const calls = row.calls as string | null
  if (calls !== null) node.calls = JSON.parse(calls) as string[]
  const preview = row.preview as string | null
  if (preview !== null) node.text = preview
  const goneSeq = row.gone_seq as number | null
  if (goneSeq !== null) node.gone = goneSeq
  return node
}

const SURFACE_COLUMNS = 'seq, time, cat, tokens, reasoning_tokens, answer_tokens, call_tokens, imgs, form, name, agent, tool, skill, is_error, calls, preview, gone_seq'

function timelineRoute(env: QueryEnv, body: QueryRow): unknown {
  const sessionId = sessionIdOf(body)
  const seq = optionalIntOf(body, 'seq')
  const limit = limitOf(body, 'limit', NODES_LIMIT)
  const archiveRaw = body.archive
  if (archiveRaw !== undefined && archiveRaw !== null && (typeof archiveRaw !== 'object' || Array.isArray(archiveRaw))) {
    queryFailure('dsh-context/bad-request', 'archive must be an object')
  }
  const archiveData: QueryRow = archiveRaw === undefined || archiveRaw === null ? {} : archiveRaw as QueryRow
  const beforeGone = optionalIntOf(archiveData, 'before_gone')
  const archiveLimit = limitOf(archiveData, 'limit', ARCHIVE_LIMIT)
  const asOf = seq === undefined
    ? 'gone_seq IS NULL'
    : 'seq <= :seq AND (gone_seq IS NULL OR gone_seq > :seq)'
  const tailRows = prepare(env, `SELECT ${SURFACE_COLUMNS} FROM surface_nodes
      WHERE session_id = :sessionId AND ${asOf} ORDER BY seq DESC LIMIT :limit`).all({
    sessionId, ...(seq === undefined ? {} : { seq }), limit,
  }) as Array<Record<string, unknown>>
  const tailMin = tailRows.length > 0 ? (tailRows[tailRows.length - 1].seq as number) : Number.MAX_SAFE_INTEGER
  const pinnedRows = prepare(env, `SELECT ${SURFACE_COLUMNS} FROM surface_nodes
      WHERE session_id = :sessionId AND ${asOf} AND seq < :tailMin AND cat IN ('inject', 'skill')
      ORDER BY seq ASC`).all({
    sessionId, ...(seq === undefined ? {} : { seq }), tailMin,
  }) as Array<Record<string, unknown>>
  const dropped = prepare(env, `SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS floor FROM surface_nodes
      WHERE session_id = :sessionId AND ${asOf} AND seq < :tailMin
      AND cat NOT IN ('inject', 'skill')`).get({
    sessionId, ...(seq === undefined ? {} : { seq }), tailMin,
  }) as { n: number; floor: number }
  const nodes = [...pinnedRows, ...tailRows.reverse()].map(surfaceNodeOf)
  const value: Record<string, unknown> = { nodes, dropped_total: dropped.n }
  if (dropped.n > 0) value.surface_floor = dropped.floor
  const archiveWhere = seq !== undefined
    ? 'gone_seq <= :seq'
    : `${beforeGone === undefined ? '' : 'gone_seq < :beforeGone AND '}gone_seq IS NOT NULL`
  const archiveRows = prepare(env, `SELECT ${SURFACE_COLUMNS} FROM surface_nodes
      WHERE session_id = :sessionId AND ${archiveWhere} ORDER BY gone_seq DESC LIMIT :archiveLimit`).all({
    sessionId, ...(seq === undefined ? {} : { seq }), ...(beforeGone === undefined ? {} : { beforeGone }), archiveLimit,
  }) as Array<Record<string, unknown>>
  value.archive = archiveRows.reverse().map(surfaceNodeOf)
  if (archiveRows.length === archiveLimit && archiveRows.length > 0) {
    value.archive_floor = archiveRows[0].gone_seq
  }
  return value
}

type SqlParams = Record<string, string | number | null>

type RowMapper<T> = (row: Record<string, unknown>) => T

function pageRows<T>(env: QueryEnv, sql: string, params: SqlParams, map: RowMapper<T>): T[] {
  const rows = prepare(env, sql).all(params) as Array<Record<string, unknown>>
  return rows.reverse().map(map)
}

function requestsRoute(env: QueryEnv, body: QueryRow): unknown {
  const { sessionId } = sessionOrScopeOf(body, 'requests')
  const limit = limitOf(body, 'limit', REQUESTS_LIMIT)
  const cursor = optionalIntOf(body, 'cursor')
  const offsetFromEnd = optionalIntOf(body, 'offsetFromEnd')
  if (cursor !== undefined && offsetFromEnd !== undefined) {
    queryFailure('dsh-context/bad-request', 'cursor and offsetFromEnd are mutually exclusive')
  }
  const groupByRaw = body.group_by
  if (groupByRaw !== undefined && groupByRaw !== null
    && (typeof groupByRaw !== 'string' || groupByRaw !== 'turn')) {
    queryFailure('dsh-context/bad-request', 'unknown group_by')
  }
  const groupBy = groupByRaw === 'turn' ? 'turn' : undefined
  const turn = optionalIntOf(body, 'turn')
  const day = textOf(body, 'day', 32)
  const model = textOf(body, 'model', 200)
  if (sessionId !== undefined) {
    const query: RequestQuery = { cursor: groupBy === undefined ? cursor : undefined, turn, day, model }
    const filters = sessionRequestFilters(query)
    const where = `session_id = :sessionId${filters}${query.cursor === undefined ? '' : ' AND seq < :cursor'}`
    const base = requestParams(sessionId, query)
    if (groupBy === 'turn') {
      const rows = prepare(env, `SELECT turn, COUNT(*) AS n, COALESCE(SUM(COALESCE(input_tokens, 0)
          + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens,
        COALESCE(SUM(gen_ms), 0) AS gen_ms, COALESCE(SUM(active_ms), 0) AS active_ms
      FROM requests WHERE ${where} GROUP BY turn ORDER BY turn ASC`).all(base) as Array<Record<string, unknown>>
      return { requests: rows.map(turnAggregateRowOf), total: rows.length }
    }
    const total = scalarCount(env, `SELECT COUNT(*) AS n FROM requests WHERE ${where}`, base)
    const sql = `SELECT * FROM requests WHERE ${where} ORDER BY seq DESC LIMIT :limit OFFSET :offset`
    const rows = pageRows(env, sql, {
      ...base,
      limit,
      offset: offsetFromEnd === undefined || offsetFromEnd <= 0 ? 0 : offsetFromEnd,
    }, requestRowOf)
    const value: Record<string, unknown> = { requests: rows, total }
    if (rows.length === limit && rows.length > 0) value.cursor = rows[0].seq
    return value
  }
  const scope = scopeOf(body, env.now())
  const source = famSourceOfFilter({ scope, withGroup: true, withPick: true })
  const filters = requestScopeFilters(turn, day, model)
  const extra: SqlParams = {}
  if (turn !== undefined) extra.turn = turn
  if (day !== undefined) extra.day = day
  if (model !== undefined) extra.model = model
  if (groupBy === 'turn') {
    const rows = prepare(env, `${source.prefix}, m AS (
      SELECT r.turn AS turn, COUNT(*) AS n, COALESCE(SUM(COALESCE(r.input_tokens, 0)
          + COALESCE(r.cache_read_tokens, 0) + COALESCE(r.cache_write_tokens, 0) + COALESCE(r.output_tokens, 0)), 0) AS tokens,
        COALESCE(SUM(r.gen_ms), 0) AS gen_ms, COALESCE(SUM(r.active_ms), 0) AS active_ms
      FROM requests r JOIN fam f ON f.member = r.session_id
      WHERE r.is_inherited = 0${filters} AND ${dayWindow('r')} GROUP BY r.turn) SELECT * FROM m`,
    ).all({ ...source.params, ...extra }) as Array<Record<string, unknown>>
    return { requests: rows.map(turnAggregateRowOf), total: rows.length }
  }
  const cursorClause = cursor === undefined ? '' : ' AND r.seq < :cursor'
  const total = (prepare(env, `${source.prefix}, m AS (SELECT COUNT(*) AS n FROM requests r JOIN fam f ON f.member = r.session_id
      WHERE r.is_inherited = 0${filters}${cursorClause} AND ${dayWindow('r')}) SELECT n FROM m`).get({
    ...source.params, ...extra, ...(cursor === undefined ? {} : { cursor }),
  }) as { n: number }).n
  const sql = `${source.prefix} SELECT r.* FROM requests r JOIN fam f ON f.member = r.session_id
    WHERE r.is_inherited = 0${filters}${cursorClause} AND ${dayWindow('r')}
    ORDER BY r.time DESC, r.session_id ASC, r.seq DESC LIMIT :limit`
  const rows = prepare(env, sql).all({
    ...source.params, ...extra, ...(cursor === undefined ? {} : { cursor }), limit,
  }) as Array<Record<string, unknown>>
  return { requests: rows.map(requestRowOf), total }
}

function turnAggregateRowOf(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    n: row.n,
    tokens: row.tokens,
    gen_ms: row.gen_ms,
    active_ms: row.active_ms,
  }
  optionalColumn(row, 'turn', 'turn', out)
  return out
}

function requestScopeFilters(turn: number | undefined, day: string | undefined, model: string | undefined): string {
  let filters = ''
  if (turn !== undefined) filters += ' AND r.turn = :turn'
  if (day !== undefined) filters += ' AND r.day = :day'
  if (model !== undefined) filters += ' AND r.model = :model'
  return filters
}

interface RequestQuery {
  readonly cursor: number | undefined
  readonly turn: number | undefined
  readonly day: string | undefined
  readonly model: string | undefined
}

function requestParams(sessionId: string, query: RequestQuery): SqlParams {
  const params: SqlParams = { sessionId }
  if (query.cursor !== undefined) params.cursor = query.cursor
  if (query.turn !== undefined) params.turn = query.turn
  if (query.day !== undefined) params.day = query.day
  if (query.model !== undefined) params.model = query.model
  return params
}

function sessionRequestFilters(query: RequestQuery): string {
  let filters = ''
  if (query.turn !== undefined) filters += ' AND turn = :turn'
  if (query.day !== undefined) filters += ' AND day = :day'
  if (query.model !== undefined) filters += ' AND model = :model'
  return filters
}

function optionalColumn(row: Record<string, unknown>, column: string, key: string, out: Record<string, unknown>): void {
  const value = row[column]
  if (value !== null) out[key] = value
}

function requestRowOf(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    seq: row.seq,
    time: row.time,
    starts_turn: row.starts_turn === 1,
    system_tokens: row.system_tokens,
    tools_tokens: row.tools_tokens,
    user_tokens: row.user_tokens,
    inject_tokens: row.inject_tokens,
    skill_tokens: row.skill_tokens,
    assistant_tokens: row.assistant_tokens,
    tool_tokens: row.tool_tokens,
    total_tokens: row.total_tokens,
  }
  optionalColumn(row, 'turn', 'turn', out)
  optionalColumn(row, 'step', 'step', out)
  optionalColumn(row, 'day', 'day', out)
  optionalColumn(row, 'model', 'model', out)
  optionalColumn(row, 'provider', 'provider', out)
  optionalColumn(row, 'period', 'period', out)
  optionalColumn(row, 'prompt_tokens', 'prompt_tokens', out)
  optionalColumn(row, 'input_tokens', 'input_tokens', out)
  optionalColumn(row, 'cache_read_tokens', 'cache_read_tokens', out)
  optionalColumn(row, 'cache_write_tokens', 'cache_write_tokens', out)
  optionalColumn(row, 'output_tokens', 'output_tokens', out)
  optionalColumn(row, 'reasoning_tokens', 'reasoning_tokens', out)
  optionalColumn(row, 'gen_ms', 'gen_ms', out)
  optionalColumn(row, 'active_ms', 'active_ms', out)
  return out
}

function stepsRoute(env: QueryEnv, body: QueryRow): unknown {
  const sessionId = sessionIdOf(body)
  const limit = limitOf(body, 'limit', STEPS_LIMIT)
  const cursor = optionalIntOf(body, 'cursor')
  const where = `session_id = :sessionId${cursor === undefined ? '' : ' AND seq < :cursor'}`
  const params: Record<string, string | number | null> = { sessionId, ...(cursor === undefined ? {} : { cursor }) }
  const total = scalarCount(env, `SELECT COUNT(*) AS n FROM steps WHERE ${where} AND end_time IS NOT NULL`, params)
  const rows = pageRows(env, `SELECT * FROM steps WHERE ${where} ORDER BY seq DESC LIMIT :limit`, { ...params, limit }, (row) => {
    const out: Record<string, unknown> = {
      seq: row.seq,
      start_time: row.start_time,
      wall_ms: row.wall_ms,
      active_ms: row.active_ms,
      wait_ms: row.wait_ms,
      idle_ms: row.idle_ms,
      tool_busy_ms: row.tool_busy_ms,
      beats_full: row.beats_full === 1,
    }
    optionalColumn(row, 'turn', 'turn', out)
    optionalColumn(row, 'step', 'step', out)
    optionalColumn(row, 'end_time', 'end_time', out)
    optionalColumn(row, 'day', 'day', out)
    optionalColumn(row, 'request_seq', 'request_seq', out)
    optionalColumn(row, 'ttft_ms', 'ttft_ms', out)
    return out
  })
  return { steps: rows, total }
}

function commandRowOf(row: Record<string, unknown>): CommandRecord {
  const out: Record<string, unknown> = {
    seq: row.seq,
    time: row.start_time,
    tool: row.name,
    start: row.start_time,
    status: (row.status ?? 'running'),
    err: row.is_error === 1,
  }
  optionalColumn(row, 'result_seq', 'resultSeq', out)
  optionalColumn(row, 'cmd', 'cmd', out)
  optionalColumn(row, 'cmd_description', 'description', out)
  optionalColumn(row, 'cmd_cwd', 'cwd', out)
  optionalColumn(row, 'timeout_ms', 'timeoutMs', out)
  optionalColumn(row, 'sandbox', 'sandbox', out)
  optionalColumn(row, 'parent_seq', 'parent', out)
  optionalColumn(row, 'turn', 'turn', out)
  optionalColumn(row, 'step', 'step', out)
  optionalColumn(row, 'end_time', 'end', out)
  optionalColumn(row, 'exit_code', 'exit', out)
  optionalColumn(row, 'signal', 'signal', out)
  optionalColumn(row, 'out_chars', 'outChars', out)
  const flags: Array<[string, string]> = [
    ['cmd_truncated', 'cmdTruncated'],
    ['code_mode', 'codeMode'],
    ['background', 'background'],
    ['exit_inferred', 'exitInferred'],
    ['timed_out', 'timedOut'],
    ['stopped', 'stopped'],
    ['denied', 'denied'],
    ['out_truncated', 'outTruncated'],
    ['stderr', 'stderr'],
    ['derived', 'derived'],
  ]
  for (const [column, key] of flags) {
    if (row[column] === 1) out[key] = true
  }
  return out as unknown as CommandRecord
}

function commandFilters(status: string | undefined, query: CommandQuery): string {
  let filters = ''
  if (status === 'failed') filters += " AND tc.status IN ('failed', 'killed')"
  else if (status === 'slow') filters += ` AND tc.duration_ms >= ${SLOW_MS}`
  else if (status === 'background') filters += ' AND tc.background = 1'
  if (query.program !== undefined) filters += ' AND tc.program = :program'
  if (query.query !== undefined && query.query !== '') {
    filters += " AND (instr(lower(COALESCE(tc.cmd, '')), :queryText) > 0"
      + " OR instr(lower(COALESCE(tc.cmd_description, '')), :queryText) > 0"
      + " OR instr(lower(COALESCE(tc.cmd_cwd, '')), :queryText) > 0"
      + " OR instr(lower(COALESCE(tc.program, '')), :queryText) > 0)"
  }
  return filters
}

interface CommandQuery {
  readonly program: string | undefined
  readonly query: string | undefined
}

function commandParams(query: CommandQuery): SqlParams {
  const params: SqlParams = {}
  if (query.program !== undefined) params.program = query.program
  if (query.query !== undefined && query.query !== '') params.queryText = query.query.toLowerCase()
  return params
}

function toolCallsRoute(env: QueryEnv, body: QueryRow): unknown {
  const { sessionId } = sessionOrScopeOf(body, 'tool-calls')
  const statusRaw = body.status
  if (statusRaw !== undefined && statusRaw !== null
    && (typeof statusRaw !== 'string' || !COMMAND_STATUS_FILTERS.has(statusRaw))) {
    queryFailure('dsh-context/bad-request', 'unknown status')
  }
  const status = statusRaw as string | undefined
  const commandQuery: CommandQuery = { program: textOf(body, 'program', 200), query: textOf(body, 'query', 500) }
  const sortRaw = body.sort
  if (sortRaw !== undefined && sortRaw !== null && (typeof sortRaw !== 'string' || !COMMAND_SORTS.has(sortRaw as 'latest'))) {
    queryFailure('dsh-context/bad-request', 'unknown sort')
  }
  const sort = (sortRaw as 'latest' | 'slowest' | undefined) ?? 'latest'
  const limit = limitOf(body, 'limit', COMMANDS_LIMIT)
  const beforeSeq = optionalIntOf(body, 'before_seq')
  const filters = commandFilters(status, commandQuery)
  const params = commandParams(commandQuery)
  const cursorClause = beforeSeq === undefined ? '' : ' AND tc.seq < :beforeSeq'
  if (sessionId !== undefined) {
    const where = 'tc.session_id = :sessionId'
    const total = scalarCount(env, `SELECT COUNT(*) AS n FROM tool_calls tc WHERE ${where}${filters}`, { ...params, sessionId })
    const sql = `SELECT tc.* FROM tool_calls tc WHERE ${where}${filters}${cursorClause} ORDER BY ${commandOrder(sort)} LIMIT :limit`
    const page = { ...params, sessionId, ...(beforeSeq === undefined ? {} : { beforeSeq }), limit }
    const rows = prepare(env, sql).all(page) as Array<Record<string, unknown>>
    return { calls: rows.map(commandRowOf), total }
  }
  const scope = scopeOf(body, env.now())
  const source = famSourceOfFilter({ scope, withGroup: true, withPick: true })
  const total = (prepare(env, `${source.prefix}, m AS (
      SELECT COUNT(*) AS n FROM tool_calls tc JOIN fam f ON f.member = tc.session_id WHERE 1 = 1${filters} AND ${dayWindow('tc')}
    ) SELECT n FROM m`).get({ ...source.params, ...params }) as { n: number }).n
  const sql = `${source.prefix} SELECT tc.* FROM tool_calls tc JOIN fam f ON f.member = tc.session_id WHERE 1 = 1${filters}${cursorClause} AND ${dayWindow('tc')}
    ORDER BY ${commandOrder(sort)} LIMIT :limit`
  const page = { ...source.params, ...params, ...(beforeSeq === undefined ? {} : { beforeSeq }), limit }
  const rows = prepare(env, sql).all(page) as Array<Record<string, unknown>>
  return { calls: rows.map(commandRowOf), total }
}

function commandOrder(sort: 'latest' | 'slowest'): string {
  return sort === 'slowest'
    ? 'COALESCE(tc.duration_ms, -1) DESC, tc.start_time DESC, tc.seq DESC'
    : 'tc.start_time DESC, tc.seq DESC'
}

function fileOpRowOf(row: Record<string, unknown>): FileOpRecord {
  const out: Record<string, unknown> = {
    seq: row.seq,
    path: row.path,
    kind: row.kind,
    tool: row.tool,
    err: row.is_error === 1,
    added: row.lines_added,
    removed: row.lines_removed,
  }
  optionalColumn(row, 'time', 'time', out)
  optionalColumn(row, 'detail', 'detail', out)
  optionalColumn(row, 'hits', 'hits', out)
  optionalColumn(row, 'parent_seq', 'parent', out)
  optionalColumn(row, 'program', 'program', out)
  if (row.is_pattern === 1) out.pattern = true
  const readCount = row.read_count as number | null
  if (readCount !== null) {
    out.read = row.read_est === 1 ? { count: readCount, est: true as const } : { start: row.read_start as number, count: readCount }
  }
  return out as unknown as FileOpRecord
}

function fileOpsRoute(env: QueryEnv, body: QueryRow): unknown {
  const sessionId = sessionIdOf(body)
  const mode = enumOf(body, 'mode', new Set(['list', 'paths']), 'unknown mode')
  const kindRaw = body.kind
  if (kindRaw !== undefined && kindRaw !== null && (typeof kindRaw !== 'string' || !FILE_KINDS.has(kindRaw))) {
    queryFailure('dsh-context/bad-request', 'unknown kind')
  }
  const kindClause = kindRaw === undefined || kindRaw === null ? '' : ' AND kind = :kind'
  const kindParams: Record<string, string> = kindRaw === undefined || kindRaw === null ? {} : { kind: kindRaw }
  if (mode === 'paths') {
    const rows = prepare(env, `SELECT path, COUNT(*) AS count, SUM(lines_added) AS added, SUM(lines_removed) AS removed,
        MAX(time) AS last, MAX(is_error) AS err FROM file_ops
      WHERE session_id = :sessionId${kindClause} GROUP BY path ORDER BY count DESC, path ASC`).all({ sessionId, ...kindParams }) as
      Array<Record<string, unknown>>
    return {
      paths: rows.map(row => ({
        path: row.path as string,
        count: row.count as number,
        added: row.added as number,
        removed: row.removed as number,
        ...(row.last === null ? {} : { last: row.last as number }),
        err: row.err === 1,
      })),
    }
  }
  const limit = limitOf(body, 'limit', FILE_OPS_LIMIT)
  const cursor = optionalIntOf(body, 'cursor')
  const where = `session_id = :sessionId${kindClause}${cursor === undefined ? '' : ' AND seq < :cursor'}`
  const base = { sessionId, ...kindParams, ...(cursor === undefined ? {} : { cursor }) }
  const total = scalarCount(env, `SELECT COUNT(*) AS n FROM file_ops WHERE ${where}`, base)
  const rows = pageRows(env, `SELECT * FROM file_ops WHERE ${where} ORDER BY seq DESC, ordinal DESC LIMIT :limit`, { ...base, limit }, fileOpRowOf)
  return { ops: rows, total }
}

function eventRowOf(row: Record<string, unknown>): ContextEventRecord {
  const out: Record<string, unknown> = {
    seq: row.seq,
    time: row.time,
    kind: row.kind,
  }
  optionalColumn(row, 'sub', 'sub', out)
  optionalColumn(row, 'form', 'form', out)
  optionalColumn(row, 'name', 'name', out)
  optionalColumn(row, 'agent', 'agent', out)
  optionalColumn(row, 'detail', 'detail', out)
  optionalColumn(row, 'tokens', 'tokens', out)
  optionalColumn(row, 'gross_tokens', 'grossTokens', out)
  optionalColumn(row, 'node_count', 'count', out)
  optionalColumn(row, 'model_from', 'from', out)
  optionalColumn(row, 'model_to', 'to', out)
  return out as unknown as ContextEventRecord
}

function eventsRoute(env: QueryEnv, body: QueryRow): unknown {
  const sessionId = sessionIdOf(body)
  const kindsRaw = body.kinds
  let kinds: string[] | undefined
  if (kindsRaw !== undefined && kindsRaw !== null) {
    if (!Array.isArray(kindsRaw) || kindsRaw.some(kind => typeof kind !== 'string')) {
      queryFailure('dsh-context/bad-request', 'kinds must be an array of strings')
    }
    for (const kind of kindsRaw as string[]) {
      if (!EVENT_KINDS.has(kind)) queryFailure('dsh-context/bad-request', 'unknown kind')
    }
    kinds = kindsRaw as string[]
  }
  const limit = limitOf(body, 'limit', EVENTS_LIMIT)
  const cursor = optionalIntOf(body, 'cursor')
  const kindsClause = kinds === undefined ? '' : ` AND kind IN (${inList(kinds, 'kind')})`
  const where = `session_id = :sessionId${kindsClause}${cursor === undefined ? '' : ' AND seq < :cursor'}`
  const base: Record<string, string | number | null> = { sessionId }
  if (kinds !== undefined) Object.assign(base, idParamsOf(kinds, 'kind'))
  if (cursor !== undefined) base.cursor = cursor
  const total = scalarCount(env, `SELECT COUNT(*) AS n FROM events WHERE ${where}`, base)
  const rows = pageRows(env, `SELECT * FROM events WHERE ${where} ORDER BY seq DESC LIMIT :limit`, { ...base, limit }, eventRowOf)
  return { events: withTurnSpans(env, sessionId, rows), total }
}

function withTurnSpans(env: QueryEnv, sessionId: string, events: ContextEventRecord[]): ContextEventRecord[] {
  if (events.length === 0) return events
  const hi = events[events.length - 1].seq
  const lo = events[0].seq
  const requestRows = prepare(env, `SELECT seq, turn, step FROM requests
      WHERE session_id = :sessionId AND seq <= :hi
      AND seq >= COALESCE((SELECT MAX(seq) FROM requests WHERE session_id = :sessionId AND seq <= :lo), 0)
      ORDER BY seq ASC`).all({ sessionId, hi, lo }) as Array<Record<string, unknown>>
  const requests = requestRows.map(row => ({
    seq: row.seq as number,
    ...(row.turn === null ? {} : { turn: row.turn as number }),
    ...(row.step === null ? {} : { step: row.step as number }),
  })) as unknown as RequestRecord[]
  return attachTurnSpans(events, requests)
}

function spansRoute(env: QueryEnv, body: QueryRow): unknown {
  const sessionId = sessionIdOf(body)
  const limit = limitOf(body, 'limit', TIMING_SPANS_LIMIT)
  const before = optionalIntOf(body, 'before')
  const where = `session_id = :sessionId${before === undefined ? '' : ' AND span_seq < :before'}`
  const base = { sessionId, ...(before === undefined ? {} : { before }) }
  const total = scalarCount(env, `SELECT COUNT(*) AS n FROM timing_spans WHERE ${where}`, base)
  const rows = pageRows(env, `SELECT kind, start_time, end_time FROM timing_spans WHERE ${where} ORDER BY span_seq DESC LIMIT :limit`, { ...base, limit }, row => ({
    kind: row.kind as TimingSpan['kind'],
    start: row.start_time as number,
    end: row.end_time as number,
  }))
  return { spans: rows, total }
}

function skillLoadsRoute(env: QueryEnv, body: QueryRow): unknown {
  const sessionId = optionalSessionIdOf(body)
  const hasScope = body.scope !== undefined && body.scope !== null
  if (sessionId === undefined && !hasScope) queryFailure('dsh-context/bad-request', 'skill-loads requires sessionId or scope')
  if (sessionId !== undefined && hasScope) queryFailure('dsh-context/bad-request', 'skill-loads takes sessionId or scope, not both')
  const name = textOf(body, 'name', 200)
  const day = textOf(body, 'day', 32)
  const limit = limitOf(body, 'limit', SKILL_LOADS_LIMIT)
  const cursor = optionalIntOf(body, 'cursor')
  const filters = `${name === undefined ? '' : ' AND name = :name'}${day === undefined ? '' : ' AND day = :day'}`
  const extra = { ...(name === undefined ? {} : { name }), ...(day === undefined ? {} : { day }) }
  if (sessionId !== undefined) {
    const where = `session_id = :sessionId${filters}${cursor === undefined ? '' : ' AND seq < :cursor'}`
    const base = { sessionId, ...extra, ...(cursor === undefined ? {} : { cursor }) }
    const total = scalarCount(env, `SELECT COUNT(*) AS n FROM skill_loads WHERE ${where}`, base)
    const rows = pageRows(env, `SELECT * FROM skill_loads WHERE ${where} ORDER BY seq DESC LIMIT :limit`, { ...base, limit }, skillLoadRowOf)
    return { loads: rows, total }
  }
  const scope = scopeOf(body, env.now())
  const source = famSourceOfFilter({ scope, withGroup: true, withPick: true })
  const windowClause = ` AND ${dayWindow('sl')}`
  const scopeFilters = `${name === undefined ? '' : ' AND sl.name = :name'}${day === undefined ? '' : ' AND sl.day = :day'}`
  const total = (prepare(env, `${source.prefix}, m AS (SELECT COUNT(*) AS n FROM skill_loads sl JOIN fam f ON f.member = sl.session_id
      WHERE 1 = 1${scopeFilters}${windowClause}) SELECT n FROM m`).get({ ...source.params, ...extra }) as { n: number }).n
  const sql = `${source.prefix} SELECT sl.* FROM skill_loads sl JOIN fam f ON f.member = sl.session_id
    WHERE 1 = 1${scopeFilters}${windowClause} ORDER BY sl.time DESC, sl.session_id ASC, sl.seq DESC LIMIT :limit`
  const rows = prepare(env, sql).all({ ...source.params, ...extra, limit }) as Array<Record<string, unknown>>
  return { loads: rows.map(skillLoadRowOf), total }
}

function skillLoadRowOf(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    session_id: row.session_id,
    seq: row.seq,
    time: row.time,
    name: row.name,
    source: row.source,
  }
  optionalColumn(row, 'day', 'day', out)
  return out
}

export const sessionRoutes: QueryRouteSpec[] = [
  { path: 'context', run: contextRoute },
  { path: 'timeline', run: timelineRoute },
  { path: 'requests', run: requestsRoute },
  { path: 'steps', run: stepsRoute },
  { path: 'tool-calls', run: toolCallsRoute },
  { path: 'file-ops', run: fileOpsRoute },
  { path: 'events', run: eventsRoute },
  { path: 'spans', run: spansRoute },
  { path: 'skill-loads', run: skillLoadsRoute },
]

