import type { FileOpRecord, SurfaceNode } from '../../shared/types'
import { dayKeyOf } from '../../shared/days'
import { commandProgramOf } from '../../shared/commands'
import type { CommandStateRecord } from '../foldState'
import { estimateToolSchema } from '../pricing'
import type { RowOp, RowPatch, RowValue } from './writer'

const PREVIEW_CHARS_MAX = 2_000

const DETAIL_CHARS_MAX = 200

export type RowSink = {
  surface(node: SurfaceNode): void
  surfaceGone(seq: number, goneSeq: number): void
  request(row: RequestRow): void
  requestActive(seq: number, activeMs: number): void
  stepStart(row: StepStartRow): void
  stepEnd(startSeq: number, patch: StepEndPatch): void
  toolCall(row: ToolCallRow): void
  toolCallPatch(callId: string, patch: ToolCallPatch): void
  eventShadowUpdate(seq: number, tokens: number, grossTokens: number | null): void
  event(row: EventRow): void
  systemPrompt(seq: number, time: number, tokens: number): void
  systemPromptsDropped(seqs: readonly number[]): void
  headerEpoch(seq: number, time: number, toolsTokens: number, reason: unknown): void
  headerTools(seq: number, tools: readonly unknown[]): void
  fileOps(ops: readonly FileOpRecord[]): void
  skillLoad(seq: number, time: number, name: string, source: 'invocation' | 'result' | 'dispatch'): void
  spans(rows: readonly { kind: string; start: number; end: number }[]): void
  inheritedCut(seq: number): void
}

export interface RequestRow {
  seq: number
  time: number
  turn?: number
  step?: number
  day: string | null
  startsTurn: boolean
  system: number
  tools: number
  user: number
  inject: number
  skill: number
  assistant: number
  tool: number
  total: number
  model?: string
  provider?: string
  period: 'peak' | 'off' | null
  usage: {
    prompt?: number
    input?: number | null
    cacheRead?: number | null
    cacheWrite?: number | null
    output?: number | null
    reasoning?: number | null
  } | null
  genMs?: number
}

export interface StepStartRow {
  seq: number
  time: number
  turn?: number
  step?: number
}

export interface StepEndPatch {
  end_time: number
  wall_ms: number
  active_ms: number
  wait_ms: number
  idle_ms: number
  tool_busy_ms: number
  ttft_ms: number | null
  request_seq: number | null
  beats_full: boolean
}

export interface ToolCallRow {
  seq: number
  callId: string
  name: string
  start: number
  turn?: number
  step?: number
  plugin?: string
  arguments?: unknown
  record?: CommandStateRecord
}

export interface ToolCallPatch {
  resultSeq?: number
  end?: number
  durationMs?: number
  isError?: boolean
  transport?: boolean
  rec?: CommandStateRecord
}

export interface EventRow {
  seq: number
  time: number
  kind: 'inject' | 'compaction' | 'prune' | 'model' | 'mode'
  sub?: string
  form?: string
  name?: string
  agent?: string
  detail?: string
  tokens?: number
  grossTokens?: number
  count?: number
  from?: string
  to?: string
}

export interface SessionRowEmitter extends RowSink {
  readonly sessionId: string
  takeOps(): RowOp[]
  takeInheritedCut(): number | null
}

interface EmitterOptions {
  sessionId: string
  pluginOf?: (tool: string) => string | undefined
}

function capped(value: string | undefined, max: number): string | null {
  if (value === undefined || value === '') return null
  return value.length > max ? value.slice(0, max) : value
}

function flag(value: boolean | undefined): RowValue {
  return value === true ? 1 : 0
}

function optionalNumber(value: number | undefined): RowValue {
  return value === undefined ? null : value
}

export function createSessionRowEmitter(options: EmitterOptions): SessionRowEmitter {
  const { sessionId } = options
  const ops: RowOp[] = []
  const callSeqs = new Map<string, number>()
  let inheritedCut: number | null = null
  let spanSeq = 0
  const ordinals = new Map<number, number>()

  const put = (table: RowOp['table'], patch: RowPatch): void => {
    ops.push({ table, patch })
  }
  const patchBySeq = (table: RowOp['table'], seq: number, patch: RowPatch): void => {
    // Patches are pure UPDATEs: the row was inserted earlier (call start, step
    // start, surface node) and must never be re-created with default columns.
    ops.push({ table, patch: { session_id: sessionId, seq, ...patch }, update: 'seq' })
  }
  const patchByCallId = (callId: string, patch: RowPatch): void => {
    const seq = callSeqs.get(callId)
    if (seq !== undefined) {
      patchBySeq('tool_calls', seq, patch)
      return
    }
    // The call predates this fold (replay past a checkpoint): update through the unique pairing key.
    ops.push({ table: 'tool_calls', patch: { session_id: sessionId, call_id: callId, ...patch }, update: 'call_id' })
  }

  const emitter: SessionRowEmitter = {
    sessionId,
    takeOps(): RowOp[] {
      const taken = ops.splice(0, ops.length)
      ordinals.clear()
      return taken
    },
    takeInheritedCut(): number | null {
      const cut = inheritedCut
      inheritedCut = null
      return cut
    },

    surface(node: SurfaceNode): void {
      put('surface_nodes', {
        session_id: sessionId,
        seq: node.seq,
        time: optionalNumber(node.time),
        cat: node.cat,
        tokens: node.tokens,
        reasoning_tokens: optionalNumber(node.reasoning),
        answer_tokens: optionalNumber(node.answerTokens),
        call_tokens: optionalNumber(node.callTokens),
        imgs: optionalNumber(node.imgs),
        form: node.form ?? null,
        name: node.name ?? null,
        agent: node.agent ?? null,
        tool: node.tool ?? null,
        skill: node.skill ?? null,
        is_error: flag(node.err),
        calls: node.calls !== undefined ? JSON.stringify(node.calls) : null,
        preview: capped(node.text, PREVIEW_CHARS_MAX),
        gone_seq: optionalNumber(node.gone),
      })
    },

    surfaceGone(seq: number, goneSeq: number): void {
      patchBySeq('surface_nodes', seq, { gone_seq: goneSeq })
    },

    request(row: RequestRow): void {
      const usage = row.usage
      put('requests', {
        session_id: sessionId,
        seq: row.seq,
        time: row.time,
        day: row.day,
        turn: optionalNumber(row.turn),
        step: optionalNumber(row.step),
        starts_turn: flag(row.startsTurn),
        system_tokens: row.system,
        tools_tokens: row.tools,
        user_tokens: row.user,
        inject_tokens: row.inject,
        skill_tokens: row.skill,
        assistant_tokens: row.assistant,
        tool_tokens: row.tool,
        total_tokens: row.total,
        model: row.model ?? null,
        provider: row.provider ?? null,
        period: row.period ?? null,
        prompt_tokens: optionalNumber(usage?.prompt),
        input_tokens: usage?.input ?? null,
        cache_read_tokens: usage?.cacheRead ?? null,
        cache_write_tokens: usage?.cacheWrite ?? null,
        output_tokens: usage?.output ?? null,
        reasoning_tokens: usage?.reasoning ?? null,
        gen_ms: optionalNumber(row.genMs),
      })
    },

    requestActive(seq: number, activeMs: number): void {
      patchBySeq('requests', seq, { active_ms: activeMs })
    },

    stepStart(row: StepStartRow): void {
      put('steps', {
        session_id: sessionId,
        seq: row.seq,
        turn: optionalNumber(row.turn),
        step: optionalNumber(row.step),
        start_time: row.time,
        day: dayKeyOf(row.time),
      })
    },

    stepEnd(startSeq: number, patch: StepEndPatch): void {
      patchBySeq('steps', startSeq, {
        end_time: patch.end_time,
        wall_ms: patch.wall_ms,
        active_ms: patch.active_ms,
        wait_ms: patch.wait_ms,
        idle_ms: patch.idle_ms,
        tool_busy_ms: patch.tool_busy_ms,
        ttft_ms: patch.ttft_ms,
        request_seq: patch.request_seq,
        beats_full: flag(patch.beats_full),
      })
    },

    toolCall(row: ToolCallRow): void {
      callSeqs.set(row.callId, row.seq)
      const record = row.record
      const program = commandProgramOf(record?.tool ?? row.name, row.arguments)
      put('tool_calls', {
        session_id: sessionId,
        seq: row.seq,
        call_id: row.callId,
        name: row.name,
        plugin: row.plugin ?? null,
        transport: 0,
        code_mode: flag(record?.codeMode === true),
        parent_seq: optionalNumber(record?.parent),
        turn: optionalNumber(record?.turn ?? row.turn),
        step: optionalNumber(record?.step ?? row.step),
        day: dayKeyOf(record?.time ?? row.start),
        start_time: record?.start ?? row.start,
        status: 'running',
        background: flag(record?.background === true),
        timeout_ms: optionalNumber(record?.timeoutMs),
        sandbox: record?.sandbox ?? null,
        cmd: record?.cmd ?? null,
        cmd_truncated: flag(record?.cmdTruncated === true),
        cmd_description: record?.description ?? null,
        cmd_cwd: record?.cwd ?? null,
        program: program ?? null,
      })
    },

    toolCallPatch(callId: string, patch: ToolCallPatch): void {
      const row: RowPatch = {}
      const record = patch.rec
      if (record !== undefined) {
        row.status = record.status
        row.exit_code = optionalNumber(record.exit)
        row.exit_inferred = flag(record.exitInferred === true)
        row.signal = record.signal ?? null
        row.timed_out = flag(record.timedOut === true)
        row.stopped = flag(record.stopped === true)
        row.denied = flag(record.denied === true)
        row.background = flag(record.background === true)
        row.derived = flag(record.derived === true)
        row.out_chars = optionalNumber(record.outChars)
        row.out_truncated = flag(record.outTruncated === true)
        row.stderr = flag(record.stderr === true)
        if (record.cwd !== undefined) row.cmd_cwd = record.cwd
      }
      if (patch.resultSeq !== undefined) row.result_seq = patch.resultSeq
      if (patch.end !== undefined) row.end_time = patch.end
      if (patch.durationMs !== undefined) row.duration_ms = patch.durationMs
      if (patch.isError !== undefined) row.is_error = flag(patch.isError)
      if (patch.transport !== undefined) row.transport = flag(patch.transport)
      if (Object.keys(row).length === 0) return
      patchByCallId(callId, row)
    },

    eventShadowUpdate(seq: number, tokens: number, grossTokens: number | null): void {
      patchBySeq('events', seq, { tokens, gross_tokens: grossTokens })
    },

    event(row: EventRow): void {
      put('events', {
        session_id: sessionId,
        seq: row.seq,
        time: row.time,
        kind: row.kind,
        sub: row.sub ?? null,
        form: row.form ?? null,
        name: row.name ?? null,
        agent: row.agent ?? null,
        detail: capped(row.detail, DETAIL_CHARS_MAX),
        tokens: optionalNumber(row.tokens),
        gross_tokens: optionalNumber(row.grossTokens),
        node_count: optionalNumber(row.count),
        model_from: row.from ?? null,
        model_to: row.to ?? null,
      })
    },

    systemPrompt(seq: number, time: number, tokens: number): void {
      put('system_prompts', { session_id: sessionId, seq, time, tokens })
    },

    systemPromptsDropped(seqs: readonly number[]): void {
      for (const seq of seqs) {
        ops.push({ table: 'system_prompts', patch: { session_id: sessionId, seq }, delete: true })
      }
    },

    headerEpoch(seq: number, time: number, toolsTokens: number, reason: unknown): void {
      put('header_epochs', {
        session_id: sessionId,
        seq,
        time,
        tools_tokens: toolsTokens,
        reason: typeof reason === 'string' ? reason : null,
      })
    },

    headerTools(seq: number, tools: readonly unknown[]): void {
      for (let ordinal = 0; ordinal < tools.length; ordinal++) {
        const tool = tools[ordinal]
        if (tool === null || typeof tool !== 'object') continue
        const record = tool as { name?: unknown; plugin?: unknown }
        const name = typeof record.name === 'string' && record.name !== '' ? record.name : '?'
        put('header_tools', {
          session_id: sessionId,
          epoch_seq: seq,
          ordinal,
          name,
          tokens: estimateToolSchema(tool),
          plugin: typeof record.plugin === 'string' && record.plugin !== '' ? record.plugin : null,
        })
      }
    },

    fileOps(rows: readonly FileOpRecord[]): void {
      for (const op of rows) {
        const ordinal = ordinals.get(op.seq) ?? 0
        ordinals.set(op.seq, ordinal + 1)
        const read = op.read
        put('file_ops', {
          session_id: sessionId,
          seq: op.seq,
          ordinal,
          time: optionalNumber(op.time),
          kind: op.kind,
          tool: op.tool,
          path: op.path,
          is_error: flag(op.err),
          lines_added: op.added,
          lines_removed: op.removed,
          detail: capped(op.detail, DETAIL_CHARS_MAX),
          hits: optionalNumber(op.hits),
          read_start: read !== undefined && 'start' in read ? optionalNumber(read.start) : null,
          read_count: read !== undefined ? optionalNumber(read.count) : null,
          read_est: read !== undefined && 'est' in read ? 1 : 0,
          parent_seq: optionalNumber(op.parent),
          program: op.program ?? null,
          is_pattern: flag(op.pattern === true),
        })
      }
    },

    skillLoad(seq: number, time: number, name: string, source: 'invocation' | 'result' | 'dispatch'): void {
      put('skill_loads', { session_id: sessionId, seq, time, day: dayKeyOf(time), name, source })
    },

    spans(rows: readonly { kind: string; start: number; end: number }[]): void {
      for (const span of rows) {
        put('timing_spans', {
          session_id: sessionId,
          span_seq: spanSeq++,
          start_time: span.start,
          end_time: span.end,
          kind: span.kind,
        })
      }
    },

    inheritedCut(seq: number): void {
      inheritedCut = seq
    },
  }
  return emitter
}
