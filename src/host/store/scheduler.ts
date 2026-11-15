import { statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { FoldBounds } from '../config'
import { resolveBounds } from '../config'
import type { ColdReadGate } from '../coldRead'
import { makeColdReadGate } from '../coldRead'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyTimeline } from '../fold'
import { createTimelineState, type TimelineEvent, type TimelineState } from '../foldState'
import { createSessionRowEmitter } from './emitter'
import { flushSession, deserializeFoldState, type FoldRun, type SessionIdentity } from './sessionFold'
import { openStore, type StoreHandle } from './store'
import { StoreWriter, type RowPatch } from './writer'

const LIVE_FOLDERS_MAX = 32

const LIVE_FLUSH_EVENTS = 200

const LIVE_FLUSH_DEBOUNCE_MS = 2_000

const LIVE_BUFFER_MAX = 512

const REST_MS = 25

const WORK_BUDGET_MS = 8_000

const PAUSE_MS = 2_000

const SLICE_EVENTS = 2_000

const MIN_SLICE_EVENTS = 128

const SLICE_BUDGET_MS = 150

const FAIL_RETRY_BASE_MS = 1_000

const FAIL_RETRY_MAX_MS = 60_000

const FOLD_STATE_CAP_BYTES = 64 * 1024 * 1024

export interface StoreCoverage {
  readonly total: number
  readonly covered: number
  readonly pending: number
  readonly failed: number
  readonly unsupported: number
  readonly running: boolean
}

export interface StoreListRecord {
  readonly header: {
    id: unknown
    createdAt?: unknown
    cwd?: unknown
    parentSession?: unknown
    origin?: unknown
    isSeeded?: unknown
    delegationDepth?: unknown
    agentPreset?: unknown
  }
}

export interface StorePersistenceLike {
  open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<{
    header: Record<string, unknown>
    read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
    close(): Promise<void>
  }>
  stat?(id: string): Promise<{ location?: { path?: string }; sizeBytes?: number }>
}

export interface StoreWorkspaceMirror {
  readonly archived?: ReadonlySet<string>
  readonly titles?: ReadonlyMap<string, string>
}

export interface StoreSchedulerOptions {
  readonly path?: string
  readonly bounds?: FoldBounds
  readonly pluginOf?: (tool: string) => string | undefined
  readonly clock?: () => number
  readonly restMs?: number
  readonly workBudgetMs?: number
  readonly pauseMs?: number
  readonly sliceBudgetMs?: number
  readonly foldStateCapBytes?: number
  readonly coldReads?: ColdReadGate
}

export interface StoreScheduler {
  readonly handle: StoreHandle
  readonly writer: StoreWriter
  reconcile(
    records: readonly StoreListRecord[],
    liveIds: ReadonlySet<string>,
    workspace?: StoreWorkspaceMirror,
  ): { changed: boolean; total: number }
  backfillPass(signal: AbortSignal): Promise<void>
  coverage(): StoreCoverage
  absorb(sessionId: string, raw: unknown): void
  flushLive(sessionId: string): void
  disposeLive(sessionId: string): void
  dispose(): void
}

interface LiveFolder {
  run: FoldRun
  pendingEvents: number
  timer: ReturnType<typeof setTimeout> | null
  touched: number
  dirty: boolean
  checkpointDirty: boolean
  rowCreated: boolean
  firstEventTime: number | null
  buffered: TimelineEvent[] | null
}

function admitted(record: StoreListRecord, liveIds: ReadonlySet<string>): boolean {
  const id = record.header.id
  if (typeof id !== 'string' || id === '') return false
  if (liveIds.has(id)) return true
  const cwd = record.header.cwd
  return typeof cwd === 'string' && cwd !== ''
}

export function recordTitle(cwd: string | undefined): string {
  if (cwd === undefined) return ''
  return workspaceTitleOf(cwd)
}

function cwdOf(record: StoreListRecord): string | undefined {
  const cwd = record.header.cwd
  /* v8 ignore next 1 */
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

function isEventShape(event: unknown): event is TimelineEvent {
  return event !== null && typeof event === 'object'
    && typeof (event as { type?: unknown }).type === 'string'
    && typeof (event as { seq?: unknown }).seq === 'number'
}

function hasTurns(state: TimelineState): boolean {
  return state.totals !== undefined && state.totals.turns > 0
}

function durableIdentity(stat: { location?: { path?: string }; sizeBytes?: number }): SessionIdentity | undefined {
  const path = stat.location?.path
  if (typeof path !== 'string' || path === '' || typeof stat.sizeBytes !== 'number') return undefined
  return { path, size: stat.sizeBytes, mtime: Math.round(statSync(path).mtimeMs) }
}

export function nextSliceSize(size: number, costMs: number, budgetMs: number): number {
  if (costMs <= 0) return Math.min(SLICE_EVENTS, size * 2)
  if (costMs > budgetMs) return Math.max(MIN_SLICE_EVENTS, Math.floor(size * budgetMs / costMs))
  if (costMs * 4 < budgetMs) return Math.min(SLICE_EVENTS, size * 2)
  return size
}

export function createStoreScheduler(
  ctx: Context,
  persistence: StorePersistenceLike,
  options: StoreSchedulerOptions = {},
): StoreScheduler {
  const bounds = options.bounds ?? resolveBounds(undefined)
  const restMs = options.restMs ?? REST_MS
  const workBudgetMs = options.workBudgetMs ?? WORK_BUDGET_MS
  const pauseMs = options.pauseMs ?? PAUSE_MS
  const sliceBudgetMs = options.sliceBudgetMs ?? SLICE_BUDGET_MS
  const foldStateCapBytes = options.foldStateCapBytes ?? FOLD_STATE_CAP_BYTES
  const coldReads = options.coldReads ?? makeColdReadGate()
  /* v8 ignore next */
  const wallClock: () => number = options.clock !== undefined ? options.clock : Date.now
  const handle = openStore(options.path === undefined ? {} : { path: options.path })
  const writer = new StoreWriter(handle.db, () => handle.bumpGeneration())
  const liveFolders = new Map<string, LiveFolder>()
  let liveTick = 0
  let running = false
  let disposed = false
  const abort = new AbortController()
  const shouldStop = (): boolean => disposed || abort.signal.aborted
  ctx.effect(() => () => {
    scheduler.dispose()
  }, 'dsh-context: store scheduler')

  function readIdentity(id: string): SessionIdentity | undefined {
    const row = handle.db.prepare('SELECT log_path, log_size, log_mtime FROM sessions WHERE id = ?').get(id) as { log_path: string | null; log_size: number | null; log_mtime: number | null } | undefined
    if (row === undefined || row.log_path === null || row.log_size === null || row.log_mtime === null) return undefined
    return { path: row.log_path, size: row.log_size, mtime: row.log_mtime }
  }

  function storedCheckpoint(sessionId: string): { state: TimelineState | null; lastSeq: number } | undefined {
    const row = handle.db.prepare('SELECT state_json, last_seq FROM fold_state WHERE session_id = ?').get(sessionId) as { state_json: string; last_seq: number } | undefined
    if (row === undefined) return undefined
    return { state: deserializeFoldState(row.state_json), lastSeq: row.last_seq }
  }

  function storedCheckpointSeq(sessionId: string): number | null {
    const row = handle.db.prepare('SELECT last_seq FROM fold_state WHERE session_id = ?').get(sessionId) as { last_seq: number } | undefined
    return row === undefined ? null : row.last_seq
  }

  function hasRowsWithoutCheckpoint(sessionId: string): boolean {
    return handle.db.prepare(
      "SELECT 1 AS x FROM sessions WHERE id = ? AND fold_status IN ('ok','pending','failed') LIMIT 1",
    ).get(sessionId) !== undefined
  }

  function freshEmitter(sessionId: string) {
    return createSessionRowEmitter({ sessionId, pluginOf: options.pluginOf })
  }

  function newFolder(sessionId: string): LiveFolder {
    const checkpoint = storedCheckpoint(sessionId)
    const startState = checkpoint?.state ?? null
    const startSeq = checkpoint !== undefined && checkpoint.state !== null ? checkpoint.lastSeq : -1
    return {
      run: { state: startState ?? createTimelineState(), lastSeq: startSeq, emitter: freshEmitter(sessionId) },
      pendingEvents: 0,
      timer: null,
      touched: ++liveTick,
      dirty: false,
      checkpointDirty: false,
      rowCreated: handle.db.prepare('SELECT 1 AS x FROM sessions WHERE id = ?').get(sessionId) !== undefined,
      firstEventTime: null,
      buffered: startState === null && hasRowsWithoutCheckpoint(sessionId) ? [] : null,
    }
  }

  function adoptRun(sessionId: string, folder: LiveFolder, state: TimelineState, lastSeq: number): void {
    folder.run = { state, lastSeq, emitter: freshEmitter(sessionId) }
    folder.pendingEvents = 0
    folder.dirty = false
  }

  function adoptDeeperCheckpoint(sessionId: string, folder: LiveFolder): boolean {
    const lastSeq = storedCheckpointSeq(sessionId)
    if (lastSeq === null || lastSeq <= folder.run.lastSeq) return false
    const checkpoint = storedCheckpoint(sessionId)
    if (checkpoint === undefined || checkpoint.state === null) return false
    adoptRun(sessionId, folder, checkpoint.state, checkpoint.lastSeq)
    return true
  }

  function evictOldest(): void {
    let oldestId = ''
    let oldestTick = Number.POSITIVE_INFINITY
    for (const [id, folder] of liveFolders) {
      if (folder.touched < oldestTick) {
        oldestId = id
        oldestTick = folder.touched
      }
    }
    disposeLive(oldestId)
  }

  function adoptBuffered(sessionId: string, folder: LiveFolder): void {
    if (folder.buffered === null) return
    const lastSeq = storedCheckpointSeq(sessionId)
    if (lastSeq === null || lastSeq <= folder.run.lastSeq) return
    const checkpoint = storedCheckpoint(sessionId)
    if (checkpoint === undefined || checkpoint.state === null) return
    const bufferedEvents = folder.buffered
    adoptRun(sessionId, folder, checkpoint.state, checkpoint.lastSeq)
    folder.checkpointDirty = false
    folder.buffered = null
    for (const bufferedEvent of bufferedEvents) {
      absorbEvent(sessionId, bufferedEvent)
    }
    flushLive(sessionId)
  }

  function absorbEvent(sessionId: string, raw: unknown): void {
    if (disposed || !isEventShape(raw)) return
    const event = raw
    if (!Number.isFinite(event.seq) || event.seq < 0) return
    let folder = liveFolders.get(sessionId)
    if (folder === undefined) {
      if (liveFolders.size >= LIVE_FOLDERS_MAX) evictOldest()
      folder = newFolder(sessionId)
      liveFolders.set(sessionId, folder)
    }
    adoptDeeperCheckpoint(sessionId, folder)
    folder.touched = ++liveTick
    if (folder.buffered !== null) {
      if (folder.buffered.length >= LIVE_BUFFER_MAX) {
        disposeLive(sessionId)
        return
      }
      folder.buffered.push(event)
      adoptBuffered(sessionId, folder)
      return
    }
    if (event.seq <= folder.run.lastSeq) return
    if (folder.run.lastSeq >= 0 && event.seq > folder.run.lastSeq + 1) {
      flushLive(sessionId)
      folder.checkpointDirty = false
      folder.buffered = [event]
      return
    }
    folder.run.state = applyTimeline(folder.run.state, event, bounds, folder.run.emitter)
    folder.run.lastSeq = event.seq
    if (folder.firstEventTime === null && Number.isFinite(event.time)) folder.firstEventTime = event.time
    folder.pendingEvents += 1
    folder.dirty = true
    if (event.type === 'turn/end') folder.checkpointDirty = true
    const immediate = event.type === 'step/end' || event.type === 'turn/end'
    if (immediate || folder.pendingEvents >= LIVE_FLUSH_EVENTS) {
      flushLive(sessionId)
      return
    }
    if (folder.timer === null) {
      folder.timer = setTimeout(() => {
        folder.timer = null
        flushLive(sessionId)
      }, LIVE_FLUSH_DEBOUNCE_MS)
      ;(folder.timer as { unref?: () => void }).unref?.()
    }
  }

  function flushLive(sessionId: string, final = false): void {
    const folder = liveFolders.get(sessionId)
    if (folder === undefined) return
    adoptBuffered(sessionId, folder)
    if (!folder.dirty || folder.buffered !== null) return
    if (folder.timer !== null) {
      clearTimeout(folder.timer)
      folder.timer = null
    }
    const patch: RowPatch = { blank: hasTurns(folder.run.state) ? 0 : 1 }
    if (!folder.rowCreated) {
      folder.rowCreated = true
      if (handle.db.prepare('SELECT 1 AS x FROM sessions WHERE id = ?').get(sessionId) === undefined) {
        patch.created_at = folder.firstEventTime ?? 0
        patch.fold_status = 'pending'
      }
    }
    flushSession(writer, folder.run, {
      now: wallClock(),
      identity: readIdentity(sessionId),
      extraSession: patch,
      detailRevBump: true,
      foldState: final || folder.checkpointDirty,
    })
    folder.checkpointDirty = false
    folder.pendingEvents = 0
    folder.dirty = false
  }

  function disposeLive(sessionId: string): void {
    const folder = liveFolders.get(sessionId)
    if (folder === undefined) return
    flushLive(sessionId, true)
    liveFolders.delete(sessionId)
  }

  function retryDue(row: { fail_at: number | null; fail_count: number }, now: number): boolean {
    const backoff = Math.min(FAIL_RETRY_BASE_MS * 2 ** Math.max(row.fail_count - 1, 0), FAIL_RETRY_MAX_MS)
    return row.fail_at === null || now >= row.fail_at + backoff
  }

  function trimFoldState(): void {
    const row = handle.db.prepare('SELECT COALESCE(SUM(LENGTH(state_json)), 0) AS bytes FROM fold_state').get() as { bytes: number }
    if (row.bytes <= foldStateCapBytes) return
    const victims = handle.db.prepare('SELECT session_id, LENGTH(state_json) AS bytes FROM fold_state ORDER BY updated_at ASC').all() as Array<{ session_id: string; bytes: number }>
    let total = row.bytes
    const doomed: string[] = []
    for (const victim of victims) {
      doomed.push(victim.session_id)
      total -= victim.bytes
      if (total <= foldStateCapBytes) break
    }
    writer.write(doomed.map(id => ({ sessionId: id, dropFoldState: true })))
  }

  const scheduler: StoreScheduler = {
    handle,
    writer,

    reconcile(records, liveIds, workspace): { changed: boolean; total: number } {
      if (disposed) return { changed: false, total: 0 }
      const listed = new Set<string>()
      const upserts: Array<{ sessionId: string; patch: RowPatch }> = []
      const existsStmt = handle.db.prepare(
        'SELECT created_at, cwd, parent_session, origin, is_seeded, delegation_depth, agent_preset, title, archived, workspace_title, running, vanished_at, updated_at FROM sessions WHERE id = ?',
      )
      for (const record of records) {
        if (!admitted(record, liveIds)) continue
        const id = record.header.id as string
        listed.add(id)
        const cwd = cwdOf(record)
        const patch: RowPatch = {
          created_at: typeof record.header.createdAt === 'number' ? record.header.createdAt : 0,
          cwd: cwd ?? null,
          parent_session: typeof record.header.parentSession === 'string' ? record.header.parentSession : null,
          origin: record.header.origin === 'subagent' ? 'subagent' : null,
          is_seeded: record.header.isSeeded === true ? 1 : 0,
          delegation_depth: typeof record.header.delegationDepth === 'number' ? record.header.delegationDepth : null,
          agent_preset: typeof record.header.agentPreset === 'string' ? record.header.agentPreset : null,
          title: recordTitle(cwd),
          archived: workspace?.archived?.has(id) === true ? 1 : 0,
          workspace_title: cwd !== undefined ? workspace?.titles?.get(id) ?? null : null,
          running: liveIds.has(id) ? 1 : 0,
        }
        const existing = existsStmt.get(id) as Record<string, unknown> | undefined
        if (existing !== undefined) {
          patch.updated_at = existing.updated_at as number
          if (existing.vanished_at !== null) patch.vanished_at = null
          let changed = false
          for (const key of Object.keys(patch)) {
            if ((existing[key] ?? null) !== (patch[key] ?? null)) changed = true
          }
          if (!changed) continue
        } else {
          patch.updated_at = patch.created_at
          patch.fold_status = 'pending'
        }
        upserts.push({ sessionId: id, patch })
      }
      let changed = false
      if (upserts.length > 0) {
        writer.write(upserts.map(write => ({ sessionId: write.sessionId, session: write.patch })))
        changed = true
      }
      const stored = handle.db.prepare('SELECT id, vanished_at FROM sessions').all() as Array<{ id: string; vanished_at: number | null }>
      const vanished: Array<{ sessionId: string; patch: RowPatch }> = []
      const doomed: string[] = []
      for (const row of stored) {
        if (listed.has(row.id) || liveIds.has(row.id)) continue
        if (row.vanished_at === null) vanished.push({ sessionId: row.id, patch: { vanished_at: wallClock() } })
        else doomed.push(row.id)
      }
      if (vanished.length > 0) {
        writer.write(vanished.map(write => ({ sessionId: write.sessionId, session: write.patch })))
        changed = true
      }
      for (const id of doomed) writer.deleteSession(id)
      if (doomed.length > 0) changed = true
      return { changed, total: listed.size }
    },

    async backfillPass(signal: AbortSignal): Promise<void> {
      if (disposed || running) return
      running = true
      try {
        const skip = new Set<string>()
        for (const [id, folder] of liveFolders) {
          if (folder.buffered === null) skip.add(id)
        }
        const exclusions = skip.size > 0 ? ` AND id NOT IN (${[...skip].map(() => '?').join(', ')})` : ''
        const rows = handle.db.prepare(
          `SELECT id, fold_status, fail_at, fail_count, updated_at FROM sessions WHERE fold_status IN ('pending','folding','ok','failed')${exclusions} ORDER BY updated_at DESC`,
        ).all(...skip) as Array<{ id: string; fold_status: string; fail_at: number | null; fail_count: number; updated_at: number }>
        let work = 0
        for (const row of rows) {
          /* v8 ignore start */
          if (shouldStop()) return
          /* v8 ignore stop */
          if (row.fold_status === 'failed' && !retryDue(row, wallClock())) continue
          const started = wallClock()
          await foldCold(row, signal)
          work += wallClock() - started
          if (work >= workBudgetMs) {
            work = 0
            await pause(signal, pauseMs)
          } else {
            await pause(signal, restMs)
          }
        }
        trimFoldState()
      } finally {
        running = false
      }
    },

    coverage(): StoreCoverage {
      if (disposed) return { total: 0, covered: 0, pending: 0, failed: 0, unsupported: 0, running: false }
      const row = handle.db.prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN fold_status = 'ok' THEN 1 ELSE 0 END) AS covered, SUM(CASE WHEN fold_status IN ('pending','folding') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN fold_status = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN fold_status = 'unsupported' THEN 1 ELSE 0 END) AS unsupported FROM sessions",
      ).get() as { total: number; covered: number | null; pending: number | null; failed: number | null; unsupported: number | null }
      return {
        total: row.total,
        covered: row.covered ?? 0,
        pending: row.pending ?? 0,
        failed: row.failed ?? 0,
        unsupported: row.unsupported ?? 0,
        running,
      }
    },

    absorb(sessionId: string, raw: unknown): void {
      absorbEvent(sessionId, raw)
    },

    flushLive,
    disposeLive,

    dispose(): void {
      if (disposed) return
      disposed = true
      abort.abort()
      for (const id of [...liveFolders.keys()]) disposeLive(id)
      handle.close()
    },
  }

  function pause(signal: AbortSignal, ms: number): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  async function foldCold(row: { id: string; fold_status: string; fail_count: number }, signal: AbortSignal): Promise<void> {
    const { id, fold_status: status } = row
    const checkpoint = storedCheckpoint(id)
    const startState = checkpoint?.state ?? null
    const startSeq = checkpoint !== undefined && checkpoint.state !== null ? checkpoint.lastSeq : -1
    let identity: SessionIdentity | undefined
    if (persistence.stat !== undefined) {
      try {
        identity = durableIdentity(await persistence.stat(id))
      } catch {
        // identity stays unset: live-only mode
      }
    }
    if (status === 'ok' && startState !== null && identity !== undefined) {
      const stored = readIdentity(id)
      if (stored !== undefined && stored.size === identity.size && stored.mtime === identity.mtime) return
    }
    if (startState === null && status !== 'pending') writer.clearSessionChildren(id)
    const outcome = await coldReads.admit(async (): Promise<'done' | 'unsupported' | { kind: 'failed'; error: unknown }> => {
      try {
        await foldFromLog(id, startState, startSeq, identity, signal)
        return 'done'
      } catch (error) {
        const name = String((error as { name?: unknown }).name)
        return name.startsWith('SessionFormatUnsupported') ? 'unsupported' : { kind: 'failed', error }
      }
    })
    if (outcome === undefined) return
    if (outcome === 'unsupported') {
      writer.write({ sessionId: id, session: { fold_status: 'unsupported' } })
      return
    }
    if (outcome !== 'done') {
      writer.write({
        sessionId: id,
        session: {
          fold_status: 'failed',
          fold_error: String(outcome.error).slice(0, 200),
          fail_count: row.fail_count + 1,
          fail_at: wallClock(),
        },
      })
      return
    }
    const folder = liveFolders.get(id)
    if (folder !== undefined && folder.buffered !== null) {
      adoptBuffered(id, folder)
    }
  }

  async function foldFromLog(
    id: string,
    startState: TimelineState | null,
    startSeq: number,
    identity: SessionIdentity | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const opened = await persistence.open(id, 'read', { signal })
    try {
      const run: FoldRun = { state: startState ?? createTimelineState(), lastSeq: startSeq, emitter: freshEmitter(id) }
      let offset = startSeq + 1
      let size = SLICE_EVENTS
      for (;;) {
        const requested = size
        const started = wallClock()
        const page = await opened.read(offset, requested)
        const events = page.events
        for (const raw of events) {
          if (!isEventShape(raw)) continue
          run.state = applyTimeline(run.state, raw, bounds, run.emitter)
          run.lastSeq = Math.max(run.lastSeq, raw.seq)
        }
        offset = run.lastSeq + 1
        const sliceCost = wallClock() - started
        const last = events.length < requested
        flushSession(writer, run, {
          now: wallClock(),
          identity,
          opsPerTransaction: Number.MAX_SAFE_INTEGER,
          extraSession: {
            blank: hasTurns(run.state) ? 0 : 1,
            ...(last ? { fail_count: 0, fail_at: null } : {}),
          },
          status: last ? 'ok' : 'folding',
          foldState: last,
          detailRevBump: last,
        })
        if (last) return
        size = nextSliceSize(size, sliceCost, sliceBudgetMs)
        await pause(signal, Math.max(restMs, sliceCost))
        if (signal.aborted || disposed) return
      }
    } finally {
      await opened.close()
    }
  }

  return scheduler
}
