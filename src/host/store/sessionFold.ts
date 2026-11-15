import { applyTimeline, createTimelineState } from '../fold'
import type { FoldBounds } from '../config'
import type { TimelineEvent, TimelineState } from '../foldState'
import { timelineStateSchema, TIMELINE_STATE_VERSION } from '../timeline'
import { createSessionRowEmitter, type SessionRowEmitter } from './emitter'
import type { RowOp, RowPatch, SessionWrite, StoreWriter } from './writer'

const OPS_PER_TRANSACTION = 20_000

export interface FoldRun {
  readonly emitter: SessionRowEmitter
  state: TimelineState
  lastSeq: number
}

function isEvent(event: unknown): event is TimelineEvent {
  return event !== null && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string'
}

export function foldEventsToRows(
  sessionId: string,
  events: readonly unknown[],
  bounds: FoldBounds,
  options: { pluginOf?: (tool: string) => string | undefined; startState?: TimelineState; startSeq?: number } = {},
): FoldRun {
  const emitter = createSessionRowEmitter({ sessionId, pluginOf: options.pluginOf })
  let state = options.startState ?? createTimelineState()
  let lastSeq = options.startSeq ?? -1
  for (const raw of events) {
    if (!isEvent(raw)) continue
    state = applyTimeline(state, raw, bounds, emitter)
    lastSeq = Math.max(lastSeq, raw.seq)
  }
  return { emitter, state, lastSeq }
}

export function serializeFoldState(state: TimelineState): string {
  return JSON.stringify({ version: TIMELINE_STATE_VERSION, state })
}

export function deserializeFoldState(json: string): TimelineState | null {
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed === null || typeof parsed !== 'object') return null
    const record = parsed as { version?: unknown; state?: unknown }
    if (record.version !== TIMELINE_STATE_VERSION) return null
    return timelineStateSchema.parse(record.state)
  } catch {
    return null
  }
}

function stateToSessionPatch(state: TimelineState, lastSeq: number, now: number, foldStatus: 'ok' | 'folding'): RowPatch {
  const patch: RowPatch = {
    fold_status: foldStatus,
    last_seq: lastSeq,
    folded_at: now,
  }
  if (state.model !== undefined) patch.model = state.model
  if (state.provider !== undefined) patch.provider = state.provider
  if (state.reasoningEffort !== undefined) patch.reasoning_effort = state.reasoningEffort
  if (state.contextWindow !== undefined) patch.context_window = state.contextWindow
  if (state.maxOutputTokens !== undefined) patch.max_output_tokens = state.maxOutputTokens
  if (state.lastUser !== undefined) patch.last_user = state.lastUser
  return patch
}

export interface SessionIdentity {
  readonly path: string
  readonly size: number
  readonly mtime: number
}

export interface FlushOptions {
  readonly now?: number
  readonly identity?: SessionIdentity
  readonly foldState?: boolean
  readonly detailRevBump?: boolean
  readonly opsPerTransaction?: number
  readonly extraSession?: RowPatch
  readonly status?: 'ok' | 'folding'
}

export function flushSession(
  writer: StoreWriter,
  run: FoldRun,
  options: FlushOptions = {},
): void {
  const now = options.now ?? Date.now()
  const ops = run.emitter.takeOps()
  const inheritedCutSeq = run.emitter.takeInheritedCut() ?? undefined
  const foldState = options.foldState === false
    ? undefined
    : { lastSeq: run.lastSeq, stateJson: serializeFoldState(run.state) }
  const identityPatch: RowPatch = options.identity === undefined ? {} : {
    log_path: options.identity.path,
    log_size: options.identity.size,
    log_mtime: options.identity.mtime,
  }
  const chunkSize = options.opsPerTransaction ?? OPS_PER_TRANSACTION
  const chunks: RowOp[][] = []
  for (let start = 0; start < ops.length; start += chunkSize) {
    chunks.push(ops.slice(start, start + chunkSize))
  }
  if (chunks.length === 0) chunks.push([])
  const writes: SessionWrite[] = chunks.map((chunk, index) => {
    const last = index === chunks.length - 1
    const status = last ? options.status ?? 'ok' : 'folding'
    const session: RowPatch = index === 0
      ? { ...stateToSessionPatch(run.state, run.lastSeq, now, status), ...(options.extraSession ?? {}), ...identityPatch }
      : { ...(options.extraSession ?? {}), fold_status: status }
    return {
      sessionId: run.emitter.sessionId,
      ...(last || index === 0 ? { session } : {}),
      ops: chunk,
      ...(last ? { inheritedCutSeq, foldState } : {}),
      bumpDetailRev: options.detailRevBump !== false && last,
    }
  })
  writer.write(writes)
}
