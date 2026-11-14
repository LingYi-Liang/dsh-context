import type { ContextEventRecord, FileOpRecord, RequestRecord, SlimRequestRecord, SystemPromptNode, TimingSpan } from '../shared/types'
import { estimateSystemContent } from '../shared/estimate'
import type { FoldBounds } from './config'
import { estimateToolsTotal, injectionSourceName, isInjection } from './pricing'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { firstTokenTimeOfStream, replaceRangeOf, streamTimingOf } from './logShapes'
import type { DecodeSpan } from './logShapes'
import { opBearingTool, opsOfCall, parseCallArgs, rawArgsNeeded } from '../shared/fileOps'
import { commandArgsOf, commandArgsRecordOf, commandProgramsOf, commandTool, markersOfText, outcomeOfMarkers } from '../shared/commands'
import {
  bumpBg,
  commandRecordOf,
  findCommandIndex,
  jobCallIdOf,
  jobOutcomePatch,
  patchBufferedCommand,
  resultPatchOf,
  resultTextsOf,
  setCommand,
  tallyRun,
} from './foldCommands'
import { TALLY_NAME_CHARS_MAX, TALLY_NAMES_MAX, countCompaction, countInject, countStep, countTurnRuns, noteCommandCall, noteSkillName, noteTurn, slimSurfaceNode, trimState } from './foldState'
import type { CommandStateRecord, TimelineEvent, TimelineState } from './foldState'
import { agentOfInjection, applyAgentAliasEvent, messageOf, skillNameOf, type MessageLike } from './foldInjections'
import { accumulateCost, addDecodeSpan, bumpToolTotals, carveWindows, durOf, ensureTiming, idleGapWindows, mergeWindows, isBeijingPeak, tokenCountOf } from './foldMetering'
import type { UsageLike } from './foldMetering'
import { ASK_USER_TOOL, applySurface, removeSurfaceSeqs } from './foldSurface'
import { isDeepSeekProvider } from '../shared/providers'
import { dayKeyOf } from '../shared/days'
import type { RowSink } from './store/emitter'

function bumpDetailRev(st: TimelineState): void {
  st.detailRev = (st.detailRev ?? 0) + 1
}

const SYSTEM_NODES_MAX = 8

function systemTokensOf(systems: readonly SystemPromptNode[]): number {
  for (let i = systems.length - 1; i >= 0; i--) {
    if (systems[i].tokens > 0) return systems[i].tokens
  }
  return 0
}

function pushSystem(st: TimelineState, node: SystemPromptNode): void {
  const systems = [...(st.systems ?? []), node]
  st.systems = systems.length > SYSTEM_NODES_MAX ? systems.slice(-SYSTEM_NODES_MAX) : systems
  st.systemTokens = systemTokensOf(st.systems)
}

const PENDING_CODE_OPS_MAX = 200

const PENDING_CODE_CMDS_MAX = 200

const PENDING_CODE_STARTS_MAX = 200

function argsRawOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

export function dispatchedSkillOf(data: unknown): string {
  const args = commandArgsRecordOf((data as { arguments?: unknown } | null | undefined)?.arguments)
  const name = args?.name
  return typeof name === 'string' && name !== '' ? name : skillNameOf(data)
}

function pushFileOps(st: TimelineState, ops: FileOpRecord[], sink?: RowSink): void {
  for (const op of ops) {
    st.fileOps.push(op)
    sink?.fileOps([op])
  }
}

function tallyName(map: Record<string, number> | undefined, name: string): Record<string, number> | undefined {
  if (name === '' || name === '__proto__') return undefined
  const key = name.length > TALLY_NAME_CHARS_MAX ? name.slice(0, TALLY_NAME_CHARS_MAX) : name
  const next = { ...(map ?? {}) }
  if (!Object.hasOwn(next, key) && Object.keys(next).length >= TALLY_NAMES_MAX) return undefined
  next[key] = (next[key] ?? 0) + 1
  return next
}

function tallyTool(st: TimelineState, name: string): void {
  const next = tallyName(st.toolTally, name)
  if (next !== undefined) st.toolTally = next
}

function tallyPrograms(st: TimelineState, tool: Parameters<typeof commandProgramsOf>[0], cmd: string): void {
  let tally = st.programTally
  for (const name of commandProgramsOf(tool, cmd)) {
    const next = tallyName(tally, name)
    if (next !== undefined) tally = next
  }
  if (tally !== undefined && tally !== st.programTally) st.programTally = tally
}

function bufferCodeOps(st: TimelineState, rootCallId: string, ops: FileOpRecord[]): void {
  const pending = st.pendingCodeOps ?? {}
  let total = 0
  for (const k in pending) total += pending[k].length
  if (total + ops.length > PENDING_CODE_OPS_MAX) return
  st.pendingCodeOps = { ...pending, [rootCallId]: [...(pending[rootCallId] ?? []), ...ops] }
}

type CloneKey = 'surface' | 'sums' | 'requests' | 'events' | 'archived' | 'callNames' | 'fileOps' | 'timing' | 'commands'

const CLONE_ALL: readonly CloneKey[] = ['surface', 'sums', 'requests', 'events', 'archived', 'callNames', 'fileOps', 'timing', 'commands']

const STEP_BEATS_MAX = 1024

export function applyTimeline(state: TimelineState, event: TimelineEvent, bounds: FoldBounds, sink?: RowSink): TimelineState {
  if (event.type === 'subagent/catalog' || event.type === 'team/member'
    || state.stepStart === undefined || state.stepBeatsFull === true
    || !Number.isFinite(event.time) || event.time < 0) {
    return applyTimelineEvent(state, event, bounds, sink)
  }
  const beats = state.stepBeats
  const next = beats !== undefined && beats.length >= STEP_BEATS_MAX
    ? { ...state, stepBeats: [], stepBeatsFull: true }
    : { ...state, stepBeats: [...(beats ?? []), event.time] }
  const applied = applyTimelineEvent(next, event, bounds, sink)
  return applied === next ? state : applied
}

function applyTimelineEvent(state: TimelineState, event: TimelineEvent, bounds: FoldBounds, sink?: RowSink): TimelineState {
  let st: TimelineState | undefined
  const ensure = (keys: readonly CloneKey[] = CLONE_ALL): TimelineState => {
    st = { ...state }
    for (const key of keys) {
      if (key === 'surface') st.surface = [...state.surface]
      else if (key === 'sums') st.sums = { ...state.sums }
      else if (key === 'requests') st.requests = [...state.requests]
      else if (key === 'events') st.events = [...state.events]
      else if (key === 'archived') st.archived = [...state.archived]
      else if (key === 'callNames') st.callNames = { ...state.callNames }
      else if (key === 'fileOps') st.fileOps = [...state.fileOps]
      else if (key === 'commands') st.commands = [...state.commands]
      else if (state.timing !== undefined) st.timing = { ...state.timing, tools: { ...state.timing.tools } }
    }
    return st
  }

  const bumpTrimmedCommand = (callId: string): TimelineState | undefined => {
    if (bounds.headOnly !== true || (state.commandCallsOverflow !== true && state.commandCalls?.includes(callId) !== true)) return undefined
    const s = ensure([])
    bumpDetailRev(s)
    return s
  }

  const data = event.data
  try {
    switch (event.type) {
      case 'request/header': {
        const header = (data?.header ?? {}) as {
          tools?: unknown[]
          config?: { model?: unknown; provider?: unknown; reasoningEffort?: unknown; maxTokens?: unknown }
        }
        const tools = Array.isArray(header.tools) ? header.tools : []
        const s = ensure(['events'])
        s.toolsTokens = estimateToolsTotal(tools)
        sink?.headerEpoch(event.seq, event.time, s.toolsTokens, data?.reason)
        sink?.headerTools(event.seq, tools)
        if (header.config && typeof header.config.model === 'string') s.model = header.config.model
        if (header.config && typeof header.config.provider === 'string') s.provider = header.config.provider
        if (header.config && typeof header.config.reasoningEffort === 'string' && header.config.reasoningEffort !== '') {
          s.reasoningEffort = header.config.reasoningEffort
        } else {
          delete s.reasoningEffort
        }
        const maxOutputTokens = header.config?.maxTokens
        if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
          s.maxOutputTokens = maxOutputTokens
        } else {
          delete s.maxOutputTokens
        }
        if ((data?.reason === 'change' || data?.reason === 'resume') && s.model && s.lastModel && s.model !== s.lastModel) {
          const rec: ContextEventRecord = { seq: event.seq, time: event.time, kind: 'model', from: s.lastModel, to: s.model }
          s.events.push(rec)
          sink?.event(rec)
          bumpDetailRev(s)
        }
        if (s.model) s.lastModel = s.model
        break
      }
      case 'system/message': {
        const s = ensure(['surface', 'sums', 'archived'])
        delete s.pendingShadowedSeqs
        delete s.pendingShadowEventSeq
        const op = replaceRangeOf(event.surfaceOp)
        if (op !== null) {
          const systems = s.systems ?? []
          s.systems = systems.filter(n => n.seq < op.start || n.seq > op.end)
          const dropped = systems.filter(n => n.seq >= op.start && n.seq <= op.end).map(n => n.seq)
          if (dropped.length > 0) sink?.systemPromptsDropped(dropped)
          const claimed = new Set<number>()
          for (const n of s.surface) {
            if (n.seq >= op.start && n.seq <= op.end) claimed.add(n.seq)
          }
          if (removeSurfaceSeqs(s, claimed, event.seq, bounds, sink).removed.length > 0) bumpDetailRev(s)
        }
        const prompt: SystemPromptNode = { seq: event.seq, time: event.time, tokens: estimateSystemContent(messageOf(data)?.content) }
        pushSystem(s, prompt)
        sink?.systemPrompt(prompt.seq, prompt.time, prompt.tokens)
        break
      }
      case 'request/context': {
        const contextWindow = data && typeof data.contextWindow === 'number' ? data.contextWindow : undefined
        const model = data && typeof data.model === 'string' ? data.model : undefined
        const provider = data && typeof data.provider === 'string' ? data.provider : undefined
        if (contextWindow === undefined && model === undefined && provider === undefined) return state
        if ((contextWindow ?? state.contextWindow) === state.contextWindow
          && (model ?? state.model) === state.model
          && (provider ?? state.provider) === state.provider) return state
        const s = ensure([])
        if (contextWindow !== undefined) s.contextWindow = contextWindow
        if (model !== undefined) s.model = model
        if (provider !== undefined) s.provider = provider
        break
      }
      case 'tool/call': {
        if (data && typeof data.callId === 'string' && typeof data.name === 'string') {
          const cmdTool = commandTool(data.name)
          const s = ensure(cmdTool === null ? ['callNames'] : ['callNames', 'commands'])
          const argsRaw = bounds.headOnly === true || !rawArgsNeeded(data.name) ? undefined : argsRawOf(data.arguments)
          let record: CommandStateRecord | undefined
          if (data.callId !== '__proto__') {
            s.callNames[data.callId] = {
              name: data.name,
              start: event.time,
              ...(argsRaw !== undefined ? { argsRaw } : {}),
            }
          }
          if (cmdTool !== null) {
            const parsed = commandArgsOf(cmdTool, data.arguments, bounds.maxCommandChars)
            if (parsed !== null) {
              record = commandRecordOf({
                seq: event.seq,
                time: event.time,
                tool: cmdTool,
                parsed,
                turn: data.turn,
                step: data.step,
                call: data.callId,
              }, bounds.headOnly === true)
              s.commands.push(record)
              tallyPrograms(s, cmdTool, parsed.cmd)
              if (bounds.headOnly === true) noteCommandCall(s, data.callId)
              if (parsed.background === true) bumpBg(s)
              bumpDetailRev(s)
            }
          }
          if (data.callId !== '__proto__') {
            sink?.toolCall({
              seq: event.seq,
              callId: data.callId,
              name: data.name,
              start: event.time,
              turn: typeof data.turn === 'number' ? data.turn : undefined,
              step: typeof data.step === 'number' ? data.step : undefined,
              arguments: data.arguments,
              record,
            })
          }
        }
        break
      }
      case 'job/registered': {
        const callId = jobCallIdOf(data)
        const startedAt = data?.startedAt
        if (callId === undefined || typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return state
        const index = findCommandIndex(state.commands, callId)
        if (index >= 0) {
          const s = ensure(['commands'])
          const updated = { ...s.commands[index], start: startedAt }
          s.commands[index] = updated
          sink?.toolCallPatch(callId, { rec: updated })
          bumpDetailRev(s)
          break
        }
        if (state.pendingCodeCmds === undefined) return bumpTrimmedCommand(callId) ?? state
        const s = ensure([])
        const patched = patchBufferedCommand(s, state.pendingCodeCmds, callId, rec => ({ ...rec, start: startedAt }))
        if (patched === null) {
          return bumpTrimmedCommand(callId) ?? state
        }
        sink?.toolCallPatch(callId, { rec: patched })
        break
      }
      case 'job/settled': {
        const callId = jobCallIdOf(data)
        const finishedAt = data?.finishedAt
        const status = data?.status
        if (callId === undefined || typeof finishedAt !== 'number' || !Number.isFinite(finishedAt)) return state
        if (status !== 'completed' && status !== 'killed' && status !== 'failed') return state
        const index = findCommandIndex(state.commands, callId)
        if (index >= 0) {
          const s = ensure(['commands'])
          const settled = jobOutcomePatch(s.commands[index], status, finishedAt, data?.detail)
          setCommand(s, index, settled)
          sink?.toolCallPatch(callId, { rec: settled })
          bumpDetailRev(s)
          break
        }
        const pendingCmds = state.pendingCodeCmds
        if (pendingCmds === undefined) return bumpTrimmedCommand(callId) ?? state
        const s = ensure([])
        const patched = patchBufferedCommand(s, pendingCmds, callId, rec => jobOutcomePatch(rec, status, finishedAt, data?.detail))
        if (patched === null) {
          return bumpTrimmedCommand(callId) ?? state
        }
        sink?.toolCallPatch(callId, { rec: patched })
        break
      }
      case 'tool/ptc-dispatch-start': {
        const rootCallId = data?.rootCallId
        const parentCallId = data?.parentCallId
        const subCallId = data?.subCallId
        const name = typeof data?.name === 'string' ? data.name : undefined
        if (typeof rootCallId !== 'string' || typeof subCallId !== 'string') return state
        const cmdTool = commandTool(name)
        const parsed = cmdTool === null ? null : commandArgsOf(cmdTool, data?.arguments, bounds.maxCommandChars)
        const pending = state.pendingCodeCmds ?? {}
        let total = 0
        for (const k in pending) total += pending[k].length
        const buffered = cmdTool !== null && parsed !== null && total + 1 <= PENDING_CODE_CMDS_MAX
        const starts = state.pendingCodeStarts ?? {}
        const withStart = Number.isFinite(event.time) ? { ...starts, [subCallId]: event.time } : starts
        const overCap = Object.keys(withStart).length > PENDING_CODE_STARTS_MAX
        const bounded = overCap
          ? Object.fromEntries(Object.entries(withStart).slice(1))
          : withStart
        const transportParent = typeof parentCallId === 'string' && Object.hasOwn(state.callNames, parentCallId)
          && state.callNames[parentCallId].transport !== true
          && Object.hasOwn(bounded, subCallId)
          ? parentCallId
          : undefined
        if (!buffered && transportParent === undefined && bounded === starts) return state
        const s = ensure([])
        if (bounded !== starts) s.pendingCodeStarts = bounded
        if (transportParent !== undefined) {
          s.callNames = { ...state.callNames, [transportParent]: { ...state.callNames[transportParent], transport: true } }
          sink?.toolCallPatch(transportParent, { transport: true })
        }
        if (!buffered) break
        const rec: CommandStateRecord = commandRecordOf({
          seq: event.seq,
          time: event.time,
          tool: cmdTool,
          parsed,
          codeMode: true,
          call: subCallId,
        }, bounds.headOnly === true)
        if (parsed.background === true) bumpBg(s)
        tallyPrograms(s, cmdTool, parsed.cmd)
        if (bounds.headOnly === true) noteCommandCall(s, subCallId)
        s.pendingCodeCmds = { ...pending, [rootCallId]: [...(pending[rootCallId] ?? []), rec] }
        sink?.toolCall({
          seq: event.seq,
          callId: subCallId,
          /* v8 ignore next 1 */
          name: name ?? '?',
          start: event.time,
          record: rec,
        })
        break
      }
      case 'tool/ptc-dispatch': {
        const rootCallId = data?.rootCallId
        const name = data?.name
        if (typeof rootCallId !== 'string' || typeof name !== 'string') return state
        const subCallId = data?.subCallId
        const starts = state.pendingCodeStarts
        const start = typeof subCallId === 'string' && starts !== undefined && Object.hasOwn(starts, subCallId)
          ? starts[subCallId]
          : undefined
        const bufferedCmds = typeof subCallId === 'string' ? state.pendingCodeCmds?.[rootCallId] : undefined
        const cmdIndex = bufferedCmds?.findIndex(r => r.call === subCallId) ?? -1
        const ops = bounds.headOnly === true ? [] : opsOfCall({
          seq: event.seq,
          time: event.time,
          tool: name,
          argsRaw: opBearingTool(name) ? argsRawOf(data?.arguments) : undefined,
          err: data?.isError === true,
        })
        const skill = name === 'skill' && data?.isError !== true ? dispatchedSkillOf(data) : ''
        const s = ensure(['timing'])
        if (start !== undefined && starts !== undefined && typeof subCallId === 'string') {
          const timing = ensureTiming(s)
          const dur = durOf(start, event.time)
          timing.toolsMs += dur
          timing.toolCalls += 1
          bumpToolTotals(timing, name, dur)
          const kept = Object.fromEntries(Object.entries(starts).filter(([id]) => id !== subCallId))
          if (Object.keys(kept).length > 0) s.pendingCodeStarts = kept
          else delete s.pendingCodeStarts
          sink?.toolCallPatch(subCallId, { resultSeq: event.seq, end: event.time, durationMs: dur })
        }
        tallyTool(s, name)
        if (skill !== '') {
          noteSkillName(s, skill)
          sink?.skillLoad(event.seq, event.time, skill, 'dispatch')
        }
        if (ops.length > 0) bufferCodeOps(s, rootCallId, ops)
        if (bufferedCmds !== undefined && cmdIndex >= 0 && typeof subCallId === 'string') {
          const prev = bufferedCmds[cmdIndex]
          const texts = resultTextsOf(data?.content)
          const markers = markersOfText(texts.at(-1) ?? '')
          const isError = data?.isError === true
          const next: CommandStateRecord = {
            ...prev,
            ...resultPatchOf(texts, markers),
            err: isError,
          }
          if (markers.backgroundAck === true) {
            next.background = true
            if (prev.background !== true) bumpBg(s)
          } else {
            const outcome = outcomeOfMarkers(markers, isError)
            next.status = outcome.status
            if (outcome.exit !== undefined) next.exit = outcome.exit
            if (outcome.exitInferred === true) next.exitInferred = true
            next.end = event.time
            next.derived = true
          }
          const list = [...bufferedCmds]
          list[cmdIndex] = next
          s.pendingCodeCmds = { ...state.pendingCodeCmds, [rootCallId]: list }
          sink?.toolCallPatch(subCallId, { rec: next })
        }
        break
      }
      case 'assistant/attempt': {
        const start = state.stepStart
        if (start === undefined || start.firstToken !== undefined) return state
        const first = firstTokenTimeOfStream(data?.stream)
        if (first === undefined) return state
        const s = ensure([])
        s.stepStart = { time: start.time, seq: start.seq, firstToken: first }
        break
      }
      case 'step/start': {
        const s = ensure([])
        const turn = typeof data?.turn === 'number' ? data.turn : undefined
        const stepLabel = typeof data?.step === 'number' ? data.step : undefined
        s.stepStart = { time: event.time, seq: event.seq }
        sink?.stepStart({ seq: event.seq, time: event.time, turn, step: stepLabel })
        delete s.stepSpans
        delete s.stepWaits
        delete s.stepApprovals
        delete s.stepRequestSeq
        delete s.stepBeats
        delete s.stepBeatsFull
        break
      }
      case 'step/end': {
        const start = state.stepStart
        if (start === undefined) return state
        const s = ensure(state.stepRequestSeq !== undefined ? ['timing', 'requests'] : ['timing'])
        const timing = ensureTiming(s)
        timing.wallMs += durOf(start.time, event.time)
        const waits: { start: number; end: number }[] = [...(state.stepWaits ?? [])]
        for (const id in state.stepApprovals) waits.push({ start: state.stepApprovals[id], end: event.time })
        waits.sort((a, b) => (a.start - b.start) || (a.end - b.end))
        let waitMs = 0
        let waitCursor = start.time
        for (const wait of waits) {
          const from = Math.max(waitCursor, wait.start)
          const to = Math.min(wait.end, event.time)
          if (to > from) { waitMs += to - from; waitCursor = to }
        }
        const activeMs = durOf(start.time, event.time) - waitMs
        const last = state.requests.at(-1)
        const responseTime = last !== undefined && last.seq === state.stepRequestSeq ? last.time : undefined
        if (responseTime !== undefined && last !== undefined) {
          s.requests[s.requests.length - 1] = { ...last, activeMs }
        }
        const painted: TimingSpan[] = []
        for (const span of state.stepSpans ?? []) {
          const from = Math.max(start.time, span.start)
          const to = Math.min(event.time, span.end)
          if (to > from) painted.push({ kind: span.kind, start: from, end: to })
        }
        painted.sort((a, b) => (a.start - b.start) || (a.end - b.end))
        const zoneStart = responseTime ?? start.time
        const gapIdle = state.stepBeatsFull === true ? [] : idleGapWindows(state.stepBeats ?? [], start.time, event.time, zoneStart)
        const waitIdle = mergeWindows(waits.map(w => ({ start: Math.max(w.start, zoneStart), end: Math.min(w.end, event.time) })))
        const residueIdle = mergeWindows([...gapIdle, ...waitIdle])
        const flushed: TimingSpan[] = []
        let cursor = start.time
        let idleMs = 0
        for (const span of painted) {
          const from = Math.max(cursor, span.start)
          if (span.end <= from) continue
          idleMs += carveWindows(flushed, 'other', cursor, from, residueIdle)
          idleMs += carveWindows(flushed, span.kind, from, span.end, waitIdle)
          cursor = span.end
        }
        idleMs += carveWindows(flushed, 'other', cursor, event.time, residueIdle)
        if (bounds.headOnly !== true) s.spans = [...state.spans, ...flushed]
        let toolBusyMs = 0
        for (const span of flushed) {
          if (span.kind === 'tools') toolBusyMs += span.end - span.start
        }
        if (timing.toolBusyMs !== undefined) timing.toolBusyMs += toolBusyMs
        if (idleMs > 0) timing.idleMs = (timing.idleMs ?? 0) + idleMs
        if (start.seq !== undefined) {
          sink?.stepEnd(start.seq, {
            end_time: event.time,
            wall_ms: durOf(start.time, event.time),
            active_ms: activeMs,
            wait_ms: waitMs,
            idle_ms: idleMs,
            tool_busy_ms: toolBusyMs,
            ttft_ms: start.firstToken !== undefined ? durOf(start.time, start.firstToken) : null,
            request_seq: state.stepRequestSeq ?? null,
            beats_full: state.stepBeatsFull === true,
          })
        }
        if (state.stepRequestSeq !== undefined) sink?.requestActive(state.stepRequestSeq, activeMs)
        if (flushed.length > 0) sink?.spans(flushed)
        delete s.stepStart
        delete s.stepSpans
        delete s.stepWaits
        delete s.stepApprovals
        delete s.stepRequestSeq
        delete s.stepBeats
        delete s.stepBeatsFull
        bumpDetailRev(s)
        break
      }
      case 'approval/asked': {
        const id = data?.id
        if (state.stepStart === undefined || typeof id !== 'string') return state
        const s = ensure([])
        s.stepApprovals = { ...state.stepApprovals, [id]: event.time }
        break
      }
      case 'approval/decided': {
        const id = data?.id
        const open = state.stepApprovals
        const askedAt = typeof id === 'string' ? open?.[id] : undefined
        if (open === undefined || askedAt === undefined) return state
        const s = ensure([])
        s.stepWaits = [...(state.stepWaits ?? []), { start: askedAt, end: event.time }]
        const kept: Record<string, number> = {}
        for (const k in open) if (k !== id) kept[k] = open[k]
        if (Object.keys(kept).length > 0) s.stepApprovals = kept
        else delete s.stepApprovals
        break
      }
      case 'subagent/catalog':
      case 'team/member': {
        const applied = applyAgentAliasEvent(state, event.type, data)
        if (applied !== undefined) st = applied
        break
      }
      case 'user/message':
      case 'developer/message': {
        const developer = event.type === 'developer/message'
        const msg = developer ? messageOf(data) : deriveEventMessage(event as never) as MessageLike | null
        if (developer && (msg === null || !Array.isArray(msg.content))) return state
        const s = ensure(['surface', 'sums', 'archived', 'events'])
        bumpDetailRev(s)
        const node = applySurface(s, event, event.type, msg, bounds, sink)
        const source = msg?.source
        if (developer || isInjection(source)) {
          const rec: ContextEventRecord = {
            seq: event.seq,
            time: event.time,
            kind: 'inject',
            form: typeof source?.form === 'string' && source.form !== '' ? source.form : 'context',
            tokens: node.tokens,
          }
          const agent = agentOfInjection(source, msg?.content, state)
          if (agent !== undefined) {
            rec.agent = agent
            node.agent = agent
          }
          if (source?.kind === 'skill-invocation') {
            rec.sub = 'skill'
            rec.name = typeof source.name === 'string' ? source.name : '?'
          } else {
            const label = injectionSourceName(source)
            if (label !== '') {
              rec.name = label
              node.name = label
            }
            if (source?.form === 'notice' && typeof source.summary === 'string' && source.summary !== '') {
              rec.detail = source.summary
            }
          }
          s.events.push(rec)
          sink?.event(rec)
          countInject(s)
          if (rec.sub === 'skill' && typeof rec.name === 'string') {
            noteSkillName(s, rec.name)
            sink?.skillLoad(event.seq, event.time, rec.name, 'invocation')
          }
          sink?.surface(node)
        } else {
          s.humanInputs = (s.humanInputs ?? 0) + 1
          if (node.text !== undefined && node.text !== '') s.lastUser = node.text
        }
        break
      }
      case 'tool/result': {
        const toolMsg = deriveEventMessage(event as never) as MessageLike | null
        const msgSource = toolMsg?.source as { callId?: unknown } | undefined
        const srcId = msgSource?.callId
        const pendingEntry = typeof srcId === 'string' && Object.hasOwn(state.callNames, srcId) ? state.callNames[srcId] : undefined
        const buffered = bounds.headOnly === true || typeof srcId !== 'string' ? undefined : state.pendingCodeOps?.[srcId]
        const bufferedCmds = typeof srcId === 'string' ? state.pendingCodeCmds?.[srcId] : undefined
        const commandCall = pendingEntry !== undefined && commandTool(pendingEntry.name) !== null
        const s = ensure(['surface', 'sums', 'archived', 'events', 'fileOps', 'timing',
          ...((bufferedCmds?.length ?? 0) > 0 || commandCall ? ['commands' as const] : [])])
        bumpDetailRev(s)
        const node = applySurface(s, event, event.type, toolMsg, bounds, sink)
        if (node.tool === ASK_USER_TOOL) s.humanInputs = (s.humanInputs ?? 0) + 1
        if (pendingEntry !== undefined && pendingEntry.name === ASK_USER_TOOL && state.stepStart !== undefined) {
          s.stepWaits = [...(state.stepWaits ?? []), { start: pendingEntry.start, end: event.time }]
        }
        if (pendingEntry !== undefined && typeof srcId === 'string') {
          if (bounds.headOnly !== true) {
            const ops = opsOfCall({
              seq: event.seq,
              time: event.time,
              tool: pendingEntry.name,
              argsRaw: pendingEntry.argsRaw,
              meta: data?.meta,
              err: toolMsg?.isError === true,
            })
            pushFileOps(s, ops, sink)
          }
          if (commandTool(pendingEntry.name) !== null) {
            const index = findCommandIndex(s.commands, srcId)
            if (index >= 0) {
              const prev = s.commands[index]
              const texts = resultTextsOf(toolMsg?.content)
              const markers = markersOfText(texts.at(-1) ?? '')
              const isError = toolMsg?.isError === true
              const next: CommandStateRecord = {
                ...prev,
                ...resultPatchOf(texts, markers),
                resultSeq: event.seq,
                err: isError,
              }
              if (markers.exit !== undefined) delete next.exitInferred
              const metaCwd = (data?.meta as { cwd?: unknown } | null | undefined)?.cwd
              if (typeof metaCwd === 'string' && metaCwd !== '') next.cwd = metaCwd
              if (markers.backgroundAck === true) {
                next.background = true
                if (prev.background !== true) bumpBg(s)
              } else if (prev.status === 'running') {
                const outcome = outcomeOfMarkers(markers, isError)
                next.status = outcome.status
                if (prev.tool !== 'run_code') {
                  if (outcome.exit !== undefined) next.exit = outcome.exit
                  if (outcome.exitInferred === true) next.exitInferred = true
                }
                next.end = event.time
                next.derived = true
              }
              setCommand(s, index, next)
              sink?.toolCallPatch(srcId, {
                resultSeq: event.seq,
                end: next.end,
                durationMs: next.end !== undefined ? durOf(prev.start, next.end) : undefined,
                isError,
                rec: next,
              })
            }
          } else {
            sink?.toolCallPatch(srcId, {
              resultSeq: event.seq,
              end: event.time,
              durationMs: durOf(pendingEntry.start, event.time),
              isError: toolMsg?.isError === true,
              transport: pendingEntry.transport === true,
            })
          }
        }
        if (buffered !== undefined && buffered.length > 0) {
          const program = parseCallArgs(pendingEntry?.argsRaw)?.description
          pushFileOps(s, buffered.map(op => ({
            ...op,
            parent: event.seq,
            ...(typeof program === 'string' && program !== '' ? { program } : {}),
          })), sink)
          const kept: Record<string, FileOpRecord[]> = {}
          for (const k in s.pendingCodeOps) {
            if (k !== srcId) kept[k] = s.pendingCodeOps[k]
          }
          if (Object.keys(kept).length > 0) s.pendingCodeOps = kept
          else delete s.pendingCodeOps
        }
        if (bufferedCmds !== undefined && bufferedCmds.length > 0) {
          for (const rec of bufferedCmds) {
            const next: CommandStateRecord = { ...rec, parent: event.seq }
            s.commands.push(next)
            if (next.status !== 'running') tallyRun(s, next)
            /* v8 ignore next 1 */
            sink?.toolCall({ seq: rec.seq, callId: rec.call ?? `seq:${String(rec.seq)}`, name: rec.tool, start: rec.start, record: next })
          }
          const kept: Record<string, CommandStateRecord[]> = {}
          for (const k in s.pendingCodeCmds) {
            if (k !== srcId) kept[k] = s.pendingCodeCmds[k]
          }
          if (Object.keys(kept).length > 0) s.pendingCodeCmds = kept
          else delete s.pendingCodeCmds
        }
        if (node.tool === 'skill' || node.tool === undefined) {
          const name = skillNameOf(toolMsg)
          if (name !== '') {
            node.skill = name
            if (node.tool === undefined) node.tool = 'skill'
            s.sums.tool -= node.tokens
            node.cat = 'skill'
            s.sums.skill += node.tokens
            s.events.push({ seq: event.seq, time: event.time, kind: 'inject', form: 'instructions', sub: 'skill', name, tokens: node.tokens })
            countInject(s)
            noteSkillName(s, name)
            sink?.skillLoad(event.seq, event.time, name, 'result')
            sink?.surface(node)
            if (bounds.headOnly === true) {
              const i = s.surface.findIndex(n => n.seq === node.seq)
              /* v8 ignore next 1 */
              if (i >= 0) s.surface[i] = slimSurfaceNode(node)
            }
          }
        }
        if ((node.cat === 'tool' || node.cat === 'skill') && node.tool !== undefined && node.tool !== '') {
          tallyTool(s, node.tool)
        }
        break
      }
      case 'assistant/message': {
        const usage = data?.usage as UsageLike | null | undefined
        const s = ensure(['surface', 'sums', 'archived', 'events', 'requests', 'timing'])
        bumpDetailRev(s)
        const total = s.systemTokens + s.toolsTokens + s.sums.user + s.sums.inject + s.sums.skill + s.sums.assistant + s.sums.tool
        const slim: SlimRequestRecord = { time: event.time, seq: event.seq, total }
        const full: RequestRecord | null = bounds.headOnly === true
          ? null
          : {
            ...slim,
            system: s.systemTokens,
            tools: s.toolsTokens,
            user: s.sums.user,
            inject: s.sums.inject,
            skill: s.sums.skill,
            assistant: s.sums.assistant,
            tool: s.sums.tool,
          }
        const record = full ?? slim
        if (data && typeof data.turn === 'number') record.turn = data.turn
        if (data && typeof data.step === 'number') record.step = data.step
        if (state.stepStart !== undefined) s.stepRequestSeq = record.seq
        const initiated = state.stepStart?.time ?? event.time
        const startsTurn = record.turn !== undefined
          && (state.totals === undefined || state.totals.lastTurn !== record.turn)
        let requestGenMs: number | undefined
        let output: number | null = null
        let input: number | null = null
        let cacheRead: number | null = null
        let cacheWrite: number | null = null
        if (usage !== null && typeof usage === 'object') {
          input = tokenCountOf(usage.inputTokens)
          cacheRead = tokenCountOf(usage.cacheReadTokens)
          cacheWrite = tokenCountOf(usage.cacheWriteTokens)
          output = tokenCountOf(usage.outputTokens)
          if (input !== null || cacheRead !== null || cacheWrite !== null || output !== null) {
            record.prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
            if (full !== null) {
              if (cacheRead !== null) full.cacheRead = cacheRead
              if (output !== null) full.output = output
            }
            accumulateCost(s, event.time, {
              uncached: input ?? 0,
              cacheRead: cacheRead ?? 0,
              cacheWrite: cacheWrite ?? 0,
              output: output ?? 0,
            })
          }
        }
        s.requests.push(record)
        const prevLast = state.requests.at(-1)
        s.turnRuns = (state.turnRuns ?? countTurnRuns(state.requests))
          + (prevLast === undefined
            ? (record.turn !== undefined ? 1 : 0)
            : (record.turn === prevLast.turn ? 0 : 1))
        countStep(s)
        noteTurn(s, record.turn)
        const timing = ensureTiming(s)
        timing.calls += 1
        const stepStart = state.stepStart
        if (stepStart !== undefined) {
          const streamTiming = streamTimingOf(data?.stream, event.time)
          const firstToken = stepStart.firstToken ?? streamTiming.firstToken
          if (firstToken !== undefined) {
            if (s.stepStart !== undefined && s.stepStart.firstToken === undefined) {
              s.stepStart = { ...s.stepStart, firstToken }
            }
            requestGenMs = durOf(firstToken, event.time)
            timing.ttftMs += durOf(stepStart.time, firstToken)
            timing.genMs += durOf(firstToken, event.time)
            const decodeSpans: DecodeSpan[] = []
            let opened = false
            let cursor = firstToken
            for (const block of streamTiming.spans) {
              const to = Math.min(event.time, block.end)
              if (to <= block.start || to <= firstToken) continue
              const from = opened ? Math.max(cursor, block.start) : firstToken
              if (to <= from) continue
              decodeSpans.push({ kind: block.kind, start: from, end: to })
              cursor = to
              opened = true
            }
            s.stepSpans = [
              ...(s.stepSpans ?? []),
              { kind: 'ttft', start: stepStart.time, end: firstToken },
              ...decodeSpans,
            ]
            if (output !== null) {
              timing.speedMs = (timing.speedMs ?? 0) + durOf(firstToken, event.time)
              timing.speedTokens = (timing.speedTokens ?? 0) + output
            }
            for (const span of decodeSpans) addDecodeSpan(timing, span.kind, durOf(span.start, span.end))
          }
        }
        const asstMsg = deriveEventMessage(event as never) as MessageLike | null
        const asstNode = applySurface(s, event, event.type, asstMsg, bounds, sink)
        if (asstNode.text !== undefined) s.answers = (s.answers ?? 0) + 1
        const providerReasoning = usage !== null && typeof usage === 'object' ? tokenCountOf(usage.reasoningTokens) : null
        const generated = providerReasoning === null
          ? (asstNode.reasoning ?? 0)
          : output === null ? providerReasoning : Math.min(providerReasoning, output)
        if (generated > 0) s.generatedReasoning = (s.generatedReasoning ?? 0) + generated
        const generatedAnswers = asstNode.answerTokens ?? 0
        if (generatedAnswers > 0) s.generatedAnswerTokens = (s.generatedAnswerTokens ?? 0) + generatedAnswers
        const generatedCalls = asstNode.callTokens ?? 0
        if (generatedCalls > 0) s.generatedCallTokens = (s.generatedCallTokens ?? 0) + generatedCalls
        if (sink !== undefined && full !== null) {
          const hasUsage = record.prompt !== undefined
          sink.request({
            seq: event.seq,
            time: event.time,
            turn: record.turn,
            step: record.step,
            day: dayKeyOf(initiated),
            startsTurn,
            system: full.system,
            tools: full.tools,
            user: full.user,
            inject: full.inject,
            /* v8 ignore next 1 -- full.skill is always a number at runtime */
            skill: full.skill ?? 0,
            assistant: full.assistant,
            tool: full.tool,
            total: full.total,
            model: s.model,
            provider: s.provider,
            /* v8 ignore next 1 -- client-project workers load this module without running the emit path */
            period: isDeepSeekProvider(s.provider ?? '') && !isBeijingPeak(initiated) ? 'off' : 'peak',
            usage: hasUsage ? {
              prompt: record.prompt,
              input,
              cacheRead,
              cacheWrite,
              output,
              reasoning: providerReasoning,
            } : null,
            genMs: requestGenMs,
          })
        }
        break
      }
      case 'session/end-seed': {
        if (data?.inherited !== true) break
        sink?.inheritedCut(event.seq)
        const s = ensure([])
        s.cost = {}
        delete s.generatedReasoning
        delete s.generatedAnswerTokens
        delete s.generatedCallTokens
        break
      }
      case 'plan/mode': {
        if (data && typeof data.active === 'boolean') {
          const s = ensure(['events'])
          const rec: ContextEventRecord = { seq: event.seq, time: event.time, kind: 'mode', name: data.active ? 'plan.on' : 'plan.off' }
          s.events.push(rec)
          sink?.event(rec)
          bumpDetailRev(s)
        }
        break
      }
      case 'compaction/summary':
      case 'compaction/prune': {
        const s = ensure(['events'])
        bumpDetailRev(s)
        if (data && Array.isArray(data.shadowedSeqs)) {
          s.pendingShadowedSeqs = data.shadowedSeqs.filter((x): x is number => typeof x === 'number')
          s.pendingShadowEventSeq = event.seq
        }
        countCompaction(s, event.type === 'compaction/summary' ? 'compaction' : 'prune')
        const rec: ContextEventRecord = {
          seq: event.seq,
          time: event.time,
          kind: event.type === 'compaction/summary' ? 'compaction' : 'prune',
          tokens: data && typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
          ...(event.type === 'compaction/summary' && data && Array.isArray(data.shadowedSeqs)
            ? { count: data.shadowedSeqs.length }
            : {}),
        }
        s.events.push(rec)
        sink?.event(rec)
        break
      }
      default:
        return state
    }
  } catch {
    st = undefined
  }

  if (st !== undefined) {
    trimState(st, bounds)
    return st
  }
  return state
}

export { skillNameOf }
export { createTimelineState, trimToLastTurns } from './foldState'
export type { TimelineEvent, TimelineState } from './foldState'
export { addBilledUsage, isBeijingPeak, tokenCountOf } from './foldMetering'
export type { BilledUsage, UsageLike } from './foldMetering'
export { buildTimelineDetail, buildTimelineHead, buildTimelineView } from './foldWire'
