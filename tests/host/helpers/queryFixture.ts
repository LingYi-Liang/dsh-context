import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBounds } from '../../../src/host/config'
import type { TimelineEvent } from '../../../src/host/fold'
import { flushSession, foldEventsToRows } from '../../../src/host/store/sessionFold'
import { openStore, type StoreHandle } from '../../../src/host/store/store'
import { StoreWriter } from '../../../src/host/store/writer'
import { createQueryRoutes, type QueryRoute, type QueryRoutesDeps } from '../../../src/host/store/query'
import { priceIndexOf, type ModelBook } from '../../../src/shared/pricing'
import { dayKeyOf } from '../../../src/shared/days'

const dirs: string[] = []

const handles: StoreHandle[] = []

export function disposeQueryFixtures(): void {
  for (const handle of handles) handle.close()
  handles.length = 0
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  dirs.length = 0
}

export const NOW = 1_800_000_000_000

export const T0 = 1_700_000_000_000

export const DAY_MS = 86_400_000

export const ROOT_DAY = dayKeyOf(T0 + 3_000)

export const SKILL_DAY = dayKeyOf(T0 + 5 * DAY_MS + 3_000)

export const FILES_DAY = dayKeyOf(T0 + 10 * DAY_MS + 3_000)

export const STREAM_DAY = dayKeyOf(T0 + 15 * DAY_MS + 3_000)

const text = (value: string) => [{ type: 'text', text: value }]

const PRICES = {
  deepseek: {
    'deepseek-v4': { hit: 1, miss: 2, write: 3, out: 4 },
    'deepseek-v4-flash': { hit: 0.5, miss: 1, write: 2, out: 3 },
  },
  openai: {
    'deepseek-v4': { hit: 9, miss: 9, write: 9, out: 9 },
  },
}

export const BOOK: ModelBook = {
  prices: PRICES,
  index: priceIndexOf(PRICES, {
    deepseek: { 'deepseek-v4': 'deepseek-v4' },
  }),
}

export function depsWith(overrides: Partial<QueryRoutesDeps> = {}): QueryRoutesDeps {
  return { pricing: () => BOOK, now: () => NOW, ...overrides }
}

export const ALL = { range: { start: T0, end: T0 + 22 * DAY_MS } }


export function canonicalEvents(id: number, base: number): TimelineEvent[] {
  const t = (offset: number) => base + offset
  return [
    { type: 'turn/start', seq: 1, time: t(0), data: { turn: 1 } },
    { type: 'request/header', seq: 2, time: t(0), data: { header: { tools: [{ name: 'bash', description: 'run' }], config: { model: 'deepseek-v4', provider: 'deepseek', maxTokens: 8192 } }, reason: 'initial' } },
    { type: 'system/message', seq: 3, time: t(1), data: { message: { role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: text('You are an agent.') } }, surfaceOp: 'append' },
    { type: 'request/context', seq: 4, time: t(2), data: { contextWindow: 128000 } },
    { type: 'step/start', seq: 5, time: t(3), data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 6, time: t(4), data: { content: text(`question ${id}`), source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 7, time: t(5), data: { turn: 1, step: 0, message: { content: text('reply') }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 } } },
    { type: 'tool/call', seq: 8, time: t(6), data: { callId: `c${id}`, name: 'bash', arguments: '{"command":"ls -la"}', turn: 1, step: 0 } },
    { type: 'tool/result', seq: 9, time: t(7), data: { message: { role: 'tool', toolCallId: `c${id}`, source: { kind: 'tool', callId: `c${id}` }, content: text('ok') } }, surfaceOp: 'append' },
    { type: 'step/end', seq: 10, time: t(8), data: { turn: 1, step: 0 } },
    { type: 'assistant/message', seq: 11, time: t(9), data: { turn: 1, step: 1, message: { content: text('second') }, usage: { inputTokens: 4, outputTokens: 2 } } },
    { type: 'user/message', seq: 12, time: t(10), data: { content: text(`trailing ${id}`), source: { kind: 'user' } }, surfaceOp: 'append' },
  ]
}

export function skillEvents(base: number): TimelineEvent[] {
  const t = (offset: number) => base + offset
  return [
    { type: 'turn/start', seq: 1, time: t(0), data: { turn: 1 } },
    { type: 'request/header', seq: 2, time: t(0), data: { header: { config: { model: 'deepseek-v4-flash', provider: 'deepseek' } }, reason: 'initial' } },
    { type: 'step/start', seq: 3, time: t(1), data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 4, time: t(2), data: { content: text('skill body'), source: { kind: 'skill-invocation', name: 'code-review' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 5, time: t(3), data: { turn: 1, step: 0, message: { content: text('reply') }, usage: { inputTokens: 7, outputTokens: 3 } } },
    { type: 'compaction/summary', seq: 6, time: t(4), data: { shadowedTokenCount: 12, shadowedSeqs: [4] } },
    { type: 'plan/mode', seq: 7, time: t(5), data: { active: true } },
    { type: 'user/message', seq: 8, time: t(6), data: { content: text('follow-up'), source: { kind: 'user' } }, surfaceOp: 'append' },
  ]
}

export function fileEvents(base: number): TimelineEvent[] {
  const t = (offset: number) => base + offset
  return [
    { type: 'turn/start', seq: 1, time: t(0), data: { turn: 1 } },
    { type: 'request/header', seq: 2, time: t(0), data: { header: { config: { model: 'deepseek-v4', provider: 'deepseek' } }, reason: 'initial' } },
    { type: 'step/start', seq: 3, time: t(1), data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 4, time: t(2), data: { content: text('q'), source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 5, time: t(3), data: { turn: 1, step: 0, message: { content: text('reply') }, usage: { inputTokens: 2, outputTokens: 1 } } },
    { type: 'tool/call', seq: 6, time: t(4), data: { callId: 'fa', name: 'read', arguments: '{"file_path":"/repo/a.ts"}', turn: 1, step: 0 } },
    { type: 'tool/result', seq: 7, time: t(5), data: { message: { role: 'tool', toolCallId: 'fa', source: { kind: 'tool', callId: 'fa' }, content: text('lines') } }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 8, time: t(6), data: { callId: 'fb', name: 'write', arguments: '{"file_path":"/repo/b.ts","content":"one\\ntwo\\n"}', turn: 1, step: 0 } },
    { type: 'tool/result', seq: 9, time: t(7), data: { message: { role: 'tool', toolCallId: 'fb', source: { kind: 'tool', callId: 'fb' }, content: text('written') } }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 10, time: t(8), data: { callId: 'fc', name: 'bash', arguments: '{"command":"boom"}', turn: 1, step: 0 } },
    { type: 'tool/result', seq: 11, time: t(9), data: { message: { role: 'tool', toolCallId: 'fc', source: { kind: 'tool', callId: 'fc' }, content: text('failed'), isError: true } }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 12, time: t(10), data: { callId: 'fd', name: 'ask_user_question', arguments: '{"question":"go on?"}', turn: 1, step: 0 } },
    { type: 'tool/result', seq: 13, time: t(11), data: { message: { role: 'tool', toolCallId: 'fd', source: { kind: 'tool', callId: 'fd' }, content: text('an answer') } }, surfaceOp: 'append' },
    { type: 'step/end', seq: 14, time: t(12), data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 15, time: t(13), data: { content: text('trailing'), source: { kind: 'user' } }, surfaceOp: 'append' },
  ]
}

function streamEvents(base: number): TimelineEvent[] {
  const t = (offset: number) => base + offset
  const stream = [
    { type: 'chunk', time: t(2_500), chunk: { type: 'block-start', blockType: 'reasoning' } },
    { type: 'chunk', time: t(3_000), chunk: { type: 'reasoning-delta', text: 'x' } },
    { type: 'chunk', time: t(4_000), chunk: { type: 'block-start', blockType: 'text' } },
    { type: 'chunk', time: t(4_500), chunk: { type: 'text-delta', text: 'y' } },
    { type: 'chunk', time: t(5_500), chunk: { type: 'block-start', blockType: 'tool-call' } },
    { type: 'chunk', time: t(5_600), chunk: { type: 'tool-call-delta', argumentsDelta: '{"a":1}' } },
  ]
  return [
    { type: 'turn/start', seq: 1, time: t(0), data: { turn: 1 } },
    { type: 'request/header', seq: 2, time: t(0), data: { header: { config: { model: 'deepseek-v4', provider: 'deepseek' } }, reason: 'initial' } },
    { type: 'step/start', seq: 3, time: t(0), data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 4, time: t(1_000), data: { content: text('stream q'), source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 5, time: t(6_000), data: { turn: 1, step: 0, message: { content: [{ type: 'reasoning', reasoning: 'x' }, { type: 'text', text: 'y' }] }, stream, usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 2 } } },
    { type: 'step/end', seq: 6, time: t(7_000), data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 7, time: t(8_000), data: { content: text('trailing'), source: { kind: 'user' } }, surfaceOp: 'append' },
  ]
}

interface SeedSpec {
  readonly id: string
  readonly events: TimelineEvent[]
  readonly session: Record<string, unknown>
}

const SEEDS: SeedSpec[] = [
  {
    id: 'root',
    events: canonicalEvents(1, T0),
    session: { created_at: T0, cwd: '/repo/root', title: 'root', workspace_title: 'Root Project', running: 1 },
  },
  {
    id: 'sub',
    events: canonicalEvents(2, T0),
    session: { created_at: T0 + 500, cwd: '/repo/root', parent_session: 'root', origin: 'subagent', title: 'root' },
  },
  {
    id: 'skill',
    events: skillEvents(T0 + 5 * DAY_MS),
    session: { created_at: T0 + 5 * DAY_MS, cwd: '/repo/skill', title: 'skill', workspace_title: 'Skill Project' },
  },
  {
    id: 'files',
    events: fileEvents(T0 + 10 * DAY_MS),
    session: { created_at: T0 + 10 * DAY_MS, cwd: '/repo/files', title: 'files' },
  },
  {
    id: 'stream',
    events: streamEvents(T0 + 15 * DAY_MS),
    session: { created_at: T0 + 15 * DAY_MS, cwd: '/repo/stream', title: 'stream' },
  },
  { id: 'blank', events: [], session: { created_at: T0 + 20 * DAY_MS, cwd: '/repo/blank', title: 'blank' } },
]

export function seedStore(handle: StoreHandle): void {
  const writer = new StoreWriter(handle.db, () => handle.bumpGeneration())
  for (const spec of SEEDS) {
    writer.write({ sessionId: spec.id, session: { ...spec.session, fold_status: 'pending' } })
    if (spec.events.length > 0) {
      const run = foldEventsToRows(spec.id, spec.events, resolveBounds(undefined))
      flushSession(writer, run, {
        now: NOW + 1,
        extraSession: { blank: (run.state.totals?.turns ?? 0) > 0 ? 0 : 1 },
      })
    }
  }
  writer.write({ sessionId: 'unfolded', session: { created_at: T0 + 21 * DAY_MS, cwd: '/repo/unfolded', title: 'unfolded' } })
}

export interface QueryFixture {
  handle: StoreHandle
  routes: QueryRoute[]
  post(route: string, body?: unknown): Promise<Record<string, unknown>>
  rawPost(route: string, body: string): Promise<Record<string, unknown>>
}

export function openQueryFixture(deps: QueryRoutesDeps = depsWith()): QueryFixture {
  const handle = openStore({ path: join(mkdtempSync(join(tmpdir(), 'dsh-ctx-query-')), 'index.sqlite') })
  dirs.push(handle.path.replace(/[/\\]storages.*$/, ''))
  handles.push(handle)
  const routes = createQueryRoutes(handle, deps)
  const byPath = new Map(routes.map(route => [route.path.replace('/api/dsh-context/query/', ''), route]))
  const post = async (route: string, body: unknown = {}): Promise<Record<string, unknown>> => {
    const entry = byPath.get(route)
    if (entry === undefined) throw new Error(`route not found: ${route}`)
    const response = await entry.fetch(new Request(`http://x/api/dsh-context/query/${route}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }))
    return response.json() as Promise<Record<string, unknown>>
  }
  const rawPost = async (route: string, body: string): Promise<Record<string, unknown>> => {
    const entry = byPath.get(route)
    if (entry === undefined) throw new Error(`route not found: ${route}`)
    const response = await entry.fetch(new Request(`http://x/api/dsh-context/query/${route}`, {
      method: 'POST',
      body,
    }))
    return response.json() as Promise<Record<string, unknown>>
  }
  return { handle, routes, post, rawPost }
}

export function seededFixture(deps: QueryRoutesDeps = depsWith()): QueryFixture {
  const fixture = openQueryFixture(deps)
  seedStore(fixture.handle)
  return fixture
}

export function idsOf(out: { rows: ReadonlyArray<{ id?: unknown }> }): string[] {
  return out.rows.map(row => String(row.id))
}

export { priceIndexOf }
export type { ModelBook }
