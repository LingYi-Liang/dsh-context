import type { SurfaceNode } from '../shared/types'
import type { Category } from '../shared/types'
import type { FoldBounds } from './config'
import type { MessageSource } from './pricing'
import {
  estimateAnswerTokens,
  estimateCallTokens,
  estimateMessage,
  estimateReasoningTokens,
  firstText,
  imageCountOf,
  isInjection,
  toolCallNames,
} from './pricing'
import { replaceRangeOf } from './logShapes'
import { durOf, ensureTiming, bumpToolTotals } from './foldMetering'
import { slimSurfaceNode } from './foldState'
import type { TimelineState } from './foldState'
import type { MessageLike } from './foldInjections'
import type { RowSink } from './store/emitter'

const ASK_USER_TOOL = 'ask_user_question'

export function categoryOf(type: string, message: { source?: MessageSource } | undefined): Category {
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  if (type === 'developer/message') return 'inject'
  const kind = message?.source?.kind
  if (kind === 'skill-invocation' || kind === 'skill-catalog') return 'skill'
  if (isInjection(message?.source)) return 'inject'
  return 'user'
}

function applyLiveSubsets(st: TimelineState, node: SurfaceNode, sign: 1 | -1): void {
  if (node.reasoning !== undefined) st.assistantReasoning += sign * node.reasoning
  if (node.answerTokens !== undefined) st.assistantAnswerTokens += sign * node.answerTokens
  if (node.callTokens !== undefined) st.assistantCallTokens += sign * node.callTokens
}

function surfaceNodeOf(node: SurfaceNode, bounds: FoldBounds): SurfaceNode {
  return bounds.headOnly === true ? slimSurfaceNode(node) : node
}

function archiveRemoved(st: TimelineState, removed: SurfaceNode[], goneSeq: number, bounds: FoldBounds, sink?: RowSink): void {
  if (bounds.headOnly === true) return
  for (const n of removed) {
    st.archived.push({ ...n, gone: goneSeq })
    sink?.surfaceGone(n.seq, goneSeq)
  }
}

export function removeSurfaceSeqs(
  st: TimelineState,
  claimed: ReadonlySet<number>,
  goneSeq: number,
  bounds: FoldBounds,
  sink?: RowSink,
): { removed: SurfaceNode[]; insertAt: number } {
  if (claimed.size === 0) return { removed: [], insertAt: st.surface.length }
  const kept: SurfaceNode[] = []
  const removed: SurfaceNode[] = []
  let insertAt = -1
  for (const n of st.surface) {
    if (claimed.has(n.seq)) {
      if (insertAt < 0) insertAt = kept.length
      st.sums[n.cat] -= n.tokens
      applyLiveSubsets(st, n, -1)
      removed.push(n)
    } else {
      kept.push(n)
    }
  }
  archiveRemoved(st, removed, goneSeq, bounds, sink)
  st.surface = kept
  return { removed, insertAt: insertAt < 0 ? kept.length : insertAt }
}

type SurfaceEventLike = { seq: number; time: number; surfaceOp?: unknown }

export function applySurface(
  st: TimelineState,
  ev: SurfaceEventLike,
  type: string,
  message: MessageLike | null | undefined,
  bounds: FoldBounds,
  sink?: RowSink,
): SurfaceNode {
  const cat = categoryOf(type, message ?? undefined)
  const node: SurfaceNode = {
    seq: ev.seq,
    time: ev.time,
    cat,
    tokens: estimateMessage(message, type === 'assistant/message' || type === 'developer/message'),
  }
  if (cat === 'assistant') {
    const reasoning = estimateReasoningTokens(message?.content)
    if (reasoning > 0) node.reasoning = reasoning
    const answers = estimateAnswerTokens(message?.content)
    if (answers > 0) node.answerTokens = answers
    const calls = estimateCallTokens(message?.content)
    if (calls > 0) node.callTokens = calls
  }
  const imgs = imageCountOf(message?.content)
  if (imgs > 0) node.imgs = imgs
  const source = message?.source
  const form = source?.form
  if (typeof form === 'string') node.form = form
  if (type === 'assistant/message') {
    const text = firstText(message?.content)
    if (text !== '') node.text = text
    else {
      const names = toolCallNames(message?.content)
      if (names.length > 0) node.calls = names.slice(0, 3)
    }
  } else if (type === 'tool/result') {
    const srcId = (source as { callId?: unknown } | undefined)?.callId
    const toolEntry = typeof srcId === 'string' && Object.hasOwn(st.callNames, srcId) ? st.callNames[srcId] : undefined
    if (toolEntry !== undefined) {
      node.tool = toolEntry.name
      if (toolEntry.transport !== true) {
        const timing = ensureTiming(st)
        const dur = durOf(toolEntry.start, ev.time)
        timing.toolsMs += dur
        timing.toolCalls += 1
        bumpToolTotals(timing, toolEntry.name, dur)
      }
      if (st.stepStart !== undefined) {
        st.stepSpans = [...(st.stepSpans ?? []), { kind: 'tools', start: toolEntry.start, end: ev.time }]
      }
    }
    if (typeof srcId === 'string') {
      const kept: Record<string, { name: string; start: number; argsRaw?: string; transport?: true }> = {}
      for (const k in st.callNames) {
        if (k !== srcId) kept[k] = st.callNames[k]
      }
      st.callNames = kept
    }
    if (message?.isError === true) node.err = true
  } else if (source?.kind === 'skill-invocation') {
    node.skill = typeof source.name === 'string' ? source.name : '?'
  } else if (source?.kind === 'plugin') {
    if (source.form === 'notice' && typeof source.summary === 'string') node.text = source.summary
    else if (source.form === 'snapshot' && Array.isArray(source.sections)) {
      node.text = source.sections.map(s => s?.name).filter(Boolean).join(', ').slice(0, 80)
    } else {
      const ptext = firstText(message?.content)
      if (ptext !== '') node.text = ptext
    }
  } else {
    const utext = firstText(message?.content)
    if (utext !== '') node.text = utext
  }

  const shadowedSeqs = st.pendingShadowedSeqs
  const shadowEventSeq = st.pendingShadowEventSeq
  delete st.pendingShadowedSeqs
  delete st.pendingShadowEventSeq

  const op = replaceRangeOf(ev.surfaceOp)
  if (op !== null) {
    if (Array.isArray(shadowedSeqs) && shadowedSeqs.length > 0) {
      const { removed, insertAt } = removeSurfaceSeqs(st, new Set(shadowedSeqs), ev.seq, bounds, sink)
      st.sums[cat] += node.tokens
      applyLiveSubsets(st, node, 1)
      st.surface.splice(insertAt, 0, surfaceNodeOf(node, bounds))
      if (shadowEventSeq !== undefined) {
        const removedSum = removed.reduce((sum, n) => sum + n.tokens, 0)
        const i = st.events.findIndex(e => e.seq === shadowEventSeq)
        if (i >= 0) {
          const net = Math.max(0, removedSum - node.tokens)
          const gross = st.events[i].kind === 'compaction' ? removedSum : null
          st.events[i] = {
            ...st.events[i],
            tokens: net,
            ...(gross !== null ? { grossTokens: removedSum } : {}),
          }
          sink?.eventShadowUpdate(shadowEventSeq, net, gross)
        }
      }
      sink?.surface(node)
      return node
    }
    let si = -1
    let ei = -1
    for (let i = 0; i < st.surface.length; i++) {
      if (si < 0 && st.surface[i].seq === op.start) si = i
      if (st.surface[i].seq === op.end) { ei = i; break }
    }
    if (si >= 0 && ei >= si) {
      const removed = st.surface.splice(si, ei - si + 1, surfaceNodeOf(node, bounds))
      archiveRemoved(st, removed, ev.seq, bounds, sink)
      for (const r of removed) {
        st.sums[r.cat] -= r.tokens
        applyLiveSubsets(st, r, -1)
      }
      st.sums[cat] += node.tokens
      applyLiveSubsets(st, node, 1)
      sink?.surface(node)
      return node
    }
  }
  st.surface.push(surfaceNodeOf(node, bounds))
  st.sums[cat] += node.tokens
  applyLiveSubsets(st, node, 1)
  sink?.surface(node)
  return node
}

export { ASK_USER_TOOL }
