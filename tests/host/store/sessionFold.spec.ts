import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, test } from 'vitest'
import { resolveBounds } from '../../../src/host/config'
import { applyTimeline, createTimelineState, type TimelineEvent, type TimelineState } from '../../../src/host/fold'
import { buildTimelineView } from '../../../src/host/foldWire'
import { applyActivity } from '../../../src/host/activity'
import { flushSession, foldEventsToRows, deserializeFoldState, serializeFoldState } from '../../../src/host/store/sessionFold'
import { openStore, type StoreHandle } from '../../../src/host/store/store'
import { StoreWriter } from '../../../src/host/store/writer'
import {
  assistantMessage,
  compaction,
  endSeed,
  header,
  requestContext,
  stepEnd,
  stepStart,
  systemMessage,
  toolCall,
  toolResult,
  userMessage,
} from '../helpers/events'

const dirs: string[] = []

function text(value: string): [{ type: string, text: string }] {
  return [{ type: 'text', text: value }]
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

interface Fixture {
  handle: StoreHandle
  writer: StoreWriter
  foldToDb(events: readonly TimelineEvent[], sessionId?: string, foldState?: boolean): TimelineState
}

function fixture(): Fixture {
  const handle = openStore({ path: join(mkdtempSync(join(tmpdir(), 'dsh-ctx-fold-')), 'index.sqlite') })
  dirs.push(handle.path === ':memory:' ? '' : handle.path.replace(/[/\\]storages.*$/, ''))
  const writer = new StoreWriter(handle.db, () => handle.bumpGeneration())
  const foldToDb = (events: readonly TimelineEvent[], sessionId = 's1', foldState = true): TimelineState => {
    const run = foldEventsToRows(sessionId, events, resolveBounds(undefined))
    flushSession(writer, run, { foldState, now: 1_000 })
    return run.state
  }
  return { handle, writer, foldToDb }
}

function rows(handle: StoreHandle, sql: string, params: Array<string | number | null> = []): Array<Record<string, unknown>> {
  return handle.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
}

describe('session row emitter', () => {
  test('a canonical session emits request, step, tool, surface, event and header rows', () => {
    const { handle, foldToDb } = fixture()
    try {
      const events: TimelineEvent[] = [
        header(1, { tools: [{ name: 'bash', description: 'run' }], config: { model: 'deepseek-v4', provider: 'deepseek' } }),
        systemMessage(2),
        requestContext(3, { contextWindow: 128000 }),
        stepStart(4),
        userMessage(5, text('hello'), { kind: 'user' }),
        assistantMessage(6, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } }),
        toolCall(7, { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}', turn: 1, step: 0 }),
        toolResult(8, { callId: 'c1', content: text('ok') }),
        stepEnd(9),
        assistantMessage(10, { turn: 2, step: 1, usage: { inputTokens: 20, outputTokens: 8 } }),
        compaction(11, 'summary', { shadowedTokenCount: 12, shadowedSeqs: [5] }),
        userMessage(12, text('after compaction'), { kind: 'user' }, { surfaceOp: { op: 'replace', startSeq: 5, endSeq: 6 } }),
      ]
      foldToDb(events)
      const session = handle.db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<string, unknown>
      assert.equal(session.model, 'deepseek-v4')
      assert.equal(session.provider, 'deepseek')
      assert.equal(session.last_seq, 12)
      assert.equal(session.fold_status, 'ok')
      assert.equal(session.context_window, 128000)
      assert.equal(session.last_user, 'after compaction')
      assert.equal(session.billed_tokens, 10 + 3 + 5 + 20 + 8)
      assert.ok((session.cur_total as number) > 0)

      const requests = rows(handle, 'SELECT * FROM requests ORDER BY seq')
      assert.equal(requests.length, 2)
      assert.equal(requests[0].starts_turn, 1)
      assert.equal(requests[1].starts_turn, 1)
      assert.equal(requests[0].total_tokens, (requests[0].system_tokens as number) + (requests[0].tools_tokens as number)
        + (requests[0].user_tokens as number) + (requests[0].inject_tokens as number) + (requests[0].skill_tokens as number)
        + (requests[0].assistant_tokens as number) + (requests[0].tool_tokens as number))
      assert.equal(requests[0].output_tokens, 5)
      assert.equal(requests[0].prompt_tokens, 13)

      const steps = rows(handle, 'SELECT * FROM steps')
      assert.equal(steps.length, 1)
      assert.notEqual(steps[0].end_time, null)
      assert.equal(steps[0].request_seq, 6)
      assert.ok((steps[0].wall_ms as number) > 0)

      const calls = rows(handle, 'SELECT * FROM tool_calls')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].status, 'completed')
      assert.equal(calls[0].program, 'ls')
      assert.notEqual(calls[0].duration_ms, null)

      const surface = rows(handle, 'SELECT * FROM surface_nodes ORDER BY seq')
      assert.equal(surface.length, 5)
      const replaced = surface.find(node => node.seq === 5) as Record<string, unknown>
      assert.notEqual(replaced.gone_seq, null)

      const eventRows = rows(handle, 'SELECT * FROM events ORDER BY seq')
      assert.equal(eventRows.length, 1)

      const epochs = rows(handle, 'SELECT * FROM header_epochs')
      assert.equal(epochs.length, 1)
      assert.equal(epochs[0].tools_tokens, (epochs[0].tools_tokens as number))

      const tools = rows(handle, 'SELECT * FROM header_tools')
      assert.equal(tools.length, 1)

      const prompts = rows(handle, 'SELECT * FROM system_prompts')
      assert.equal(prompts.length, 1)

      assert.ok(rows(handle, 'SELECT * FROM timing_spans').length >= 1)
    } finally {
      handle.close()
    }
  })

  test('replay from a serialized fold state reproduces the single-shot rows', () => {
    const { handle, writer, foldToDb } = fixture()
    try {
      const events: TimelineEvent[] = [
        header(1, { config: { model: 'm1', provider: 'deepseek' } }),
        stepStart(2),
        userMessage(3, text('q1'), { kind: 'user' }),
        assistantMessage(4, { turn: 1, usage: { inputTokens: 4, outputTokens: 2 } }),
        toolCall(5, { callId: 'c1', name: 'bash', arguments: '{"command":"pwd"}', turn: 1 }),
        toolResult(6, { callId: 'c1', content: text('/repo') }),
        stepEnd(7),
      ]
      foldToDb(events, 'single')

      const first = foldEventsToRows('replay', events.slice(0, 4), resolveBounds(undefined))
      flushSession(writer, first, { now: 1_000 })
      const restored = deserializeFoldState(serializeFoldState(first.state))
      assert.notEqual(restored, null)
      const resumed = foldEventsToRows('replay', events.slice(4), resolveBounds(undefined), {
        startState: restored ?? undefined,
        startSeq: first.lastSeq,
      })
      flushSession(writer, resumed, { now: 2_000 })

      const pick = (id: string): { billed: number; cur: number; calls: Array<Record<string, unknown>> } => {
        const session = handle.db.prepare('SELECT billed_tokens, cur_total FROM sessions WHERE id = ?').get(id) as Record<string, unknown>
        return {
          billed: session.billed_tokens as number,
          cur: session.cur_total as number,
          calls: rows(handle, 'SELECT status, duration_ms, program FROM tool_calls WHERE session_id = ?', [id]),
        }
      }
      assert.equal(pick('replay').billed, 4 + 2)
      assert.deepEqual(pick('replay'), pick('single'))
      const replayRequests = rows(handle, 'SELECT * FROM requests WHERE session_id = ? ORDER BY seq', ['replay'])
      const singleRequests = rows(handle, 'SELECT * FROM requests WHERE session_id = ? ORDER BY seq', ['single'])
      assert.deepEqual(
        replayRequests.map(row => { const { session_id: _sid, ...rest } = row; return rest }),
        singleRequests.map(row => { const { session_id: _sid, ...rest } = row; return rest }),
      )
    } finally {
      handle.close()
    }
  })

  test('fold state serialization rejects version mismatches and junk', () => {
    const state = createTimelineState()
    const json = serializeFoldState(state)
    assert.notEqual(deserializeFoldState(json), null)
    const tampered = JSON.stringify({ version: 1, state: JSON.parse(json).state })
    assert.equal(deserializeFoldState(tampered), null)
    assert.equal(deserializeFoldState('not json'), null)
    assert.equal(deserializeFoldState('null'), null)
    assert.equal(deserializeFoldState('5'), null)
    assert.equal(deserializeFoldState(JSON.stringify({ version: 42, state: { sums: 'broken' } })), null)
  })

  test('large flushes split into chunked transactions and land every row', () => {
    const { handle, writer } = fixture()
    try {
      const events: TimelineEvent[] = [header(1, { config: { model: 'm', provider: 'other-llm' } })]
      for (let seq = 2; seq <= 90; seq += 2) {
        events.push(stepStart(seq))
        events.push(assistantMessage(seq + 1, { turn: seq, step: seq, usage: { inputTokens: 10, outputTokens: 5 } }))
      }
      const run = foldEventsToRows('chunked', events, resolveBounds(undefined))
      flushSession(writer, run, { now: 1_000, opsPerTransaction: 30, identity: { path: '/logs/x', size: 7, mtime: 9 } })
      const session = handle.db.prepare('SELECT * FROM sessions WHERE id = ?').get('chunked') as Record<string, unknown>
      assert.equal(session.fold_status, 'ok')
      assert.equal(session.last_seq, 91)
      assert.equal(session.detail_rev, 1)
      assert.equal(session.log_path, '/logs/x')
      assert.equal(session.log_size, 7)
      const surface = (handle.db.prepare('SELECT COUNT(*) AS n FROM surface_nodes WHERE session_id = ?').get('chunked') as { n: number }).n
      assert.equal(surface, 45)
    } finally {
      handle.close()
    }
  })
})

describe('emitter edge paths', () => {
  test('cross-flush tool results, skill loads, system replaces and inherited cuts emit correctly', () => {
    const { handle, writer } = fixture()
    try {
      writer.write({ sessionId: 's1', session: { created_at: 1, updated_at: 1 } })
      const head = header(1, { tools: [{ name: 'bash' }], config: { model: 'm', provider: 'deepseek', reasoningEffort: 'max', maxTokens: 4096 } })
      const sys = systemMessage(2)
      const call = toolCall(3, { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
      const first = foldEventsToRows('s1', [head, sys, call], resolveBounds(undefined))
      flushSession(writer, first, { now: 1_000, foldState: false })

      const systemReplace: TimelineEvent = {
        type: 'system/message', seq: 4, time: 3_500,
        data: { message: { role: 'system', source: { kind: 'plugin' }, content: text('v2') } },
        surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
      }
      const skillUser = userMessage(5, text('skill body'), { kind: 'skill-invocation', name: 'code-review' })
      const result = toolResult(6, { callId: 'c1', content: text('done') })
      const seed = endSeed(7, { inherited: true })
      const second = foldEventsToRows('s1', [systemReplace, 'junk-string', null, skillUser, result, seed], resolveBounds(undefined), {
        startState: first.state,
        startSeq: first.lastSeq,
      })
      flushSession(writer, second, { now: 2_000 })

      const prompts = rows(handle, 'SELECT COUNT(*) AS n FROM system_prompts WHERE session_id = ?', ['s1'])
      assert.equal(prompts[0].n, 1)
      const session = handle.db.prepare('SELECT reasoning_effort, max_output_tokens, billed_tokens, last_seq FROM sessions WHERE id = ?').get('s1') as Record<string, unknown>
      assert.equal(session.reasoning_effort, 'max')
      assert.equal(session.max_output_tokens, 4096)
      assert.equal(session.last_seq, 7)
      assert.equal(session.billed_tokens, 0)
      const loads = rows(handle, 'SELECT name, source FROM skill_loads WHERE session_id = ?', ['s1'])
      assert.equal(loads.length, 1)
      assert.equal(loads[0].source, 'invocation')
      assert.equal(loads[0].name, 'code-review')
      const calls = rows(handle, 'SELECT status, duration_ms FROM tool_calls WHERE session_id = ?', ['s1'])
      assert.equal(calls[0].status, 'completed')
      assert.notEqual(calls[0].duration_ms, null)
    } finally {
      handle.close()
    }
  })

  test('an empty fold flushes only the session row and long last_user values are capped', () => {
    const { handle, writer } = fixture()
    try {
      const run = foldEventsToRows('empty', [], resolveBounds(undefined))
      flushSession(writer, run)
      const session = handle.db.prepare('SELECT fold_status, last_seq FROM sessions WHERE id = ?').get('empty') as Record<string, unknown>
      assert.equal(session.fold_status, 'ok')
      assert.equal(session.last_seq, -1)
      const long = 'x'.repeat(300)
      const run2 = foldEventsToRows('capped', [header(1, { config: { model: 'm' } }), userMessage(2, [{ type: 'text', text: long }], { kind: 'user' })], resolveBounds(undefined))
      flushSession(writer, run2, { now: 5_000 })
      const capped = handle.db.prepare('SELECT last_user, folded_at FROM sessions WHERE id = ?').get('capped') as Record<string, unknown>
      assert.equal(capped.last_user, 'x'.repeat(80))
      assert.equal(capped.folded_at, 5_000)
    } finally {
      handle.close()
    }
  })
})

describe('row parity — rows reproduce the projection wire', () => {
  test('a mixed session folds to identical series, aggregates and tallies', () => {
    const { handle, writer } = fixture()
    try {
      const events: TimelineEvent[] = [
        header(1, { tools: [{ name: 'bash', description: 'run' }], config: { model: 'deepseek-v4', provider: 'deepseek' } }),
        systemMessage(2),
        requestContext(3, { contextWindow: 64000 }),
        stepStart(4, { time: 4_000 }),
        userMessage(5, text('hello'), { kind: 'user' }),
        assistantMessage(6, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 }, time: 6_000, stream: [{ type: 'chunk', time: 5_000, chunk: { type: 'text-delta', text: 'x' } }] }),
        toolCall(7, { callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}', turn: 1, step: 0 }),
        toolResult(8, { callId: 'c1', content: text('ok'), time: 7_000 }),
        stepEnd(9, { time: 8_000 }),
        assistantMessage(10, { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 8 }, time: 10_000 }),
        toolCall(11, { callId: 'c2', name: 'read', arguments: '{"file_path":"/a/b"}' }),
        toolResult(12, { callId: 'c2', content: text('lines'), time: 11_000 }),
        toolCall(13, { callId: 'c3', name: 'bash', arguments: '{"command":"sleep 30"}', turn: 2, step: 2 }),
        toolResult(14, { callId: 'c3', content: text('started background job bg-1\n[still running after 30000ms; moved to background job bg-1]\nThe command keeps running in the background.'), time: 12_000 }),
        compaction(15, 'summary', { shadowedTokenCount: 12, shadowedSeqs: [5] }),
        userMessage(16, text('replacement'), { kind: 'user' }, { surfaceOp: { op: 'replace', startSeq: 5, endSeq: 6 } }),
        assistantMessage(17, { turn: 2, step: 2, usage: { inputTokens: 7, outputTokens: 3 }, time: 12_000 }),
        assistantMessage(18, { turn: 2, step: 3, time: 12_500 }),
        stepEnd(19, { time: 13_000 }),
        stepStart(21, { time: new Date('2026-11-11T10:30:00+08:00').getTime() }),
        assistantMessage(22, { turn: 3, step: 3, usage: { inputTokens: 6, outputTokens: 4 }, time: new Date('2026-11-11T10:30:00+08:00').getTime() + 2_000 }),
        stepEnd(23, { time: new Date('2026-11-11T10:30:00+08:00').getTime() + 3_000 }),
        stepStart(24, { time: new Date('2026-11-11T10:31:00+08:00').getTime() }),
        stepEnd(25, { time: new Date('2026-11-11T10:32:00+08:00').getTime() }),
      ]
      const eventsTyped = events as TimelineEvent[]
      const wireState = eventsTyped.reduce<TimelineState>((state, event) => applyTimeline(state, event, resolveBounds(undefined)), createTimelineState())
      const wire = buildTimelineView(wireState, resolveBounds(undefined))
      const activity = eventsTyped.reduce<ReturnType<typeof applyActivity>>((acc, event) => applyActivity(acc, event as never), { days: {} })

      const run = foldEventsToRows('parity', eventsTyped, resolveBounds(undefined))
      flushSession(writer, run, { now: 20_000 })

      const sessionId = 'parity'
      const requests = rows(handle, 'SELECT * FROM requests WHERE session_id = ? ORDER BY seq', [sessionId])
      assert.equal(requests.length, wire.requests.length)
      for (let index = 0; index < requests.length; index++) {
        const row = requests[index]
        const record = wire.requests[index]
        assert.equal(row.seq, record.seq)
        assert.equal(row.time, record.time)
        assert.equal(row.turn, record.turn)
        assert.equal(row.system_tokens, record.system)
        assert.equal(row.tools_tokens, record.tools)
        assert.equal(row.user_tokens, record.user)
        assert.equal(row.inject_tokens, record.inject)
        assert.equal(row.skill_tokens, record.skill)
        assert.equal(row.assistant_tokens, record.assistant)
        assert.equal(row.tool_tokens, record.tool)
        assert.equal(row.total_tokens, record.total)
        assert.equal(row.prompt_tokens, record.prompt ?? null)
        assert.equal(row.cache_read_tokens, record.cacheRead ?? null)
        assert.equal(row.output_tokens, record.output ?? null)
        assert.equal(row.active_ms, record.activeMs ?? null)
      }

      const surface = rows(handle, 'SELECT seq, cat, tokens, gone_seq FROM surface_nodes WHERE session_id = ? ORDER BY seq', [sessionId])
      const wireNodes = [...wire.nodes, ...wire.archive].sort((a, b) => a.seq - b.seq)
      assert.equal(surface.length, wireNodes.length)
      for (let index = 0; index < surface.length; index++) {
        assert.equal(surface[index].seq, wireNodes[index].seq)
        assert.equal(surface[index].cat, wireNodes[index].cat)
        assert.equal(surface[index].tokens, wireNodes[index].tokens)
        assert.equal(surface[index].gone_seq, wireNodes[index].gone ?? null)
      }

      const live = rows(handle, "SELECT cat, SUM(tokens) AS n FROM surface_nodes WHERE session_id = ? AND gone_seq IS NULL GROUP BY cat", [sessionId])
      const sums: Record<string, number> = { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 }
      for (const row of live) sums[row.cat as string] = row.n as number
      const systemRow = handle.db.prepare(
        "SELECT tokens FROM system_prompts WHERE session_id = ? AND tokens > 0 ORDER BY seq DESC LIMIT 1",
      ).get(sessionId) as { tokens: number } | undefined
      const epochs = handle.db.prepare(
        'SELECT tools_tokens FROM header_epochs WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
      ).get(sessionId) as { tools_tokens: number } | undefined
      const curTotal = Object.values(sums).reduce((n, v) => n + v, 0)
        + (systemRow?.tokens ?? 0) + (epochs?.tools_tokens ?? 0)
      assert.equal(curTotal, wire.current.total)

      const commands = rows(handle, 'SELECT * FROM tool_calls WHERE session_id = ? AND cmd IS NOT NULL ORDER BY seq', [sessionId])
      const wireCommands = wire.commands ?? []
      assert.equal(commands.length, wireCommands.length)
      assert.equal(commands[0].name, wireCommands[0].tool)
      assert.equal(commands[0].status, wireCommands[0].status)
      assert.equal(commands[0].start_time, wireCommands[0].start)
      assert.equal(commands[0].cmd, wireCommands[0].cmd)
      assert.equal(commands[0].exit_code, wireCommands[0].exit)

      const fileOps = rows(handle, 'SELECT * FROM file_ops WHERE session_id = ? ORDER BY seq, ordinal', [sessionId])
      assert.equal(fileOps.length, (wire.fileOps ?? []).length)
      for (let index = 0; index < fileOps.length; index++) {
        assert.equal(fileOps[index].path, (wire.fileOps ?? [])[index].path)
        assert.equal(fileOps[index].kind, (wire.fileOps ?? [])[index].kind)
        assert.equal(fileOps[index].lines_added, (wire.fileOps ?? [])[index].added)
      }

      const eventRows = rows(handle, 'SELECT * FROM events WHERE session_id = ? ORDER BY seq', [sessionId])
      assert.equal(eventRows.length, wire.events.length)
      for (let index = 0; index < eventRows.length; index++) {
        assert.equal(eventRows[index].seq, wire.events[index].seq)
        assert.equal(eventRows[index].kind, wire.events[index].kind)
        assert.equal(eventRows[index].tokens, wire.events[index].tokens ?? null)
        assert.equal(eventRows[index].sub, wire.events[index].sub ?? null)
      }

      const spans = rows(handle, 'SELECT * FROM timing_spans WHERE session_id = ? ORDER BY span_seq', [sessionId])
      assert.equal(spans.length, (wire.spans ?? []).length)
      for (let index = 0; index < spans.length; index++) {
        assert.equal(spans[index].kind, (wire.spans ?? [])[index].kind)
        assert.equal(spans[index].start_time, (wire.spans ?? [])[index].start)
        assert.equal(spans[index].end_time, (wire.spans ?? [])[index].end)
      }

      const timing = wire.timing
      assert.notEqual(timing, undefined)
      if (timing === undefined) return
      const sumOf = (sql: string, params: Array<string | number | null> = [sessionId]): number => {
        const row = handle.db.prepare(sql).get(...params) as { n: number | null }
        return row.n ?? 0
      }
      assert.equal(sumOf('SELECT SUM(wall_ms) AS n FROM steps WHERE session_id = ?'), timing.wallMs)
      assert.equal(sumOf('SELECT SUM(ttft_ms) AS n FROM steps WHERE session_id = ?'), timing.ttftMs)
      assert.equal(sumOf('SELECT SUM(gen_ms) AS n FROM requests WHERE session_id = ?'), timing.genMs)
      assert.equal(sumOf('SELECT COUNT(*) AS n FROM requests WHERE session_id = ?'), timing.calls)
      assert.equal(sumOf("SELECT SUM(duration_ms) AS n FROM tool_calls WHERE session_id = ? AND transport = 0 AND duration_ms IS NOT NULL"), timing.toolsMs)
      assert.equal(sumOf("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ? AND transport = 0 AND result_seq IS NOT NULL"), timing.toolCalls)
      assert.equal(sumOf('SELECT SUM(tool_busy_ms) AS n FROM steps WHERE session_id = ?'), timing.toolBusyMs)
      assert.equal(sumOf('SELECT SUM(idle_ms) AS n FROM steps WHERE session_id = ?'), timing.idleMs ?? 0)
      assert.equal(sumOf("SELECT SUM(end_time - start_time) AS n FROM timing_spans WHERE session_id = ? AND kind = 'reasoning'"), timing.reasoningMs ?? 0)

      const ledger = Object.values(activity.days).reduce((acc: { tokens: number; turns: number; toolCalls: number; toolsMs: number }, day) => ({
        tokens: acc.tokens + day.tokens,
        turns: acc.turns + (day.turns ?? 0),
        toolCalls: acc.toolCalls + (day.toolCalls ?? 0),
        toolsMs: acc.toolsMs + (day.toolsMs ?? 0),
      }), { tokens: 0, turns: 0, toolCalls: 0, toolsMs: 0 })
      const session = handle.db.prepare('SELECT billed_tokens FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown>
      assert.equal(session.billed_tokens, ledger.tokens)
      assert.equal(sumOf('SELECT SUM(starts_turn) AS n FROM requests WHERE session_id = ?'), ledger.turns)
      assert.equal(sumOf("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ? AND transport = 0 AND result_seq IS NOT NULL AND name != 'ask_user_question'"), ledger.toolCalls)
      assert.equal(sumOf("SELECT SUM(duration_ms) AS n FROM tool_calls WHERE session_id = ? AND transport = 0 AND duration_ms IS NOT NULL"), ledger.toolsMs)
    } finally {
      handle.close()
    }
  })
})
