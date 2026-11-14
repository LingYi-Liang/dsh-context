import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { TABLE_KEYS, type ChildTable } from './schema'

export type RowValue = string | number | null

export type RowPatch = Record<string, RowValue>

export interface RowOp {
  readonly table: ChildTable
  readonly patch: RowPatch
  readonly delete?: boolean
  readonly update?: 'call_id' | 'seq'
}

export interface SessionWrite {
  readonly sessionId: string
  readonly session?: RowPatch
  readonly ops?: readonly RowOp[]
  readonly inheritedCutSeq?: number
  readonly foldState?: { readonly lastSeq: number; readonly stateJson: string }
  readonly dropFoldState?: boolean
  readonly bumpDetailRev?: boolean
}

const RECOMPUTE_SQL = `UPDATE sessions SET
  billed_tokens = (SELECT COALESCE(SUM(
    COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0)
    + COALESCE(cache_write_tokens, 0) + COALESCE(output_tokens, 0)
  ), 0) FROM requests WHERE requests.session_id = sessions.id AND requests.is_inherited = 0),
  cur_total = (SELECT COALESCE(SUM(tokens), 0) FROM surface_nodes
      WHERE surface_nodes.session_id = sessions.id AND surface_nodes.gone_seq IS NULL)
    + COALESCE((SELECT tokens FROM system_prompts
      WHERE system_prompts.session_id = sessions.id AND system_prompts.tokens > 0
      ORDER BY seq DESC LIMIT 1), 0)
    + COALESCE((SELECT tools_tokens FROM header_epochs
      WHERE header_epochs.session_id = sessions.id ORDER BY seq DESC LIMIT 1), 0)
  WHERE sessions.id = ?`

function statementOf(db: DatabaseSync, cache: Map<string, StatementSync>, key: string, sql: string): StatementSync {
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const prepared = db.prepare(sql)
  cache.set(key, prepared)
  return prepared
}

function upsertSql(table: string, pk: readonly string[], insertColumns: readonly string[], updateColumns: readonly string[]): string {
  const quoted = insertColumns.map(c => `"${c}"`)
  const placeholders = insertColumns.map(() => '?')
  const updates = updateColumns.filter(c => !pk.includes(c)).map(c => `"${c}" = excluded."${c}"`)
  const conflict = pk.map(c => `"${c}"`).join(', ')
  /* v8 ignore next 1 */
  const updateClause = updates.length > 0 ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING'
  return `INSERT INTO "${table}" (${quoted.join(', ')}) VALUES (${placeholders.join(', ')})
    ON CONFLICT(${conflict}) ${updateClause}`
}

interface ColumnInfo {
  readonly name: string
  readonly notnull: number
  readonly dflt: string | null
  readonly type: string
}

function textDefault(type: string): RowValue {
  return type.includes('TEXT') ? '' : 0
}

function declaredDefault(info: ColumnInfo): RowValue {
  if (info.dflt === null) return textDefault(info.type)
  const numeric = Number(info.dflt)
  return Number.isFinite(numeric) ? numeric : info.dflt.slice(1, -1).replace(/''/g, "'")
}

export class StoreWriter {
  private readonly statements = new Map<string, StatementSync>()
  private readonly columns = new Map<string, ColumnInfo[]>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly bumpGeneration: () => number,
  ) {}

  private prepare(key: string, sql: string): StatementSync {
    return statementOf(this.db, this.statements, key, sql)
  }

  private columnsOf(table: string): ColumnInfo[] {
    const cached = this.columns.get(table)
    if (cached !== undefined) return cached
    const info = this.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
      name: string
      notnull: number
      dflt_value: string | null
      type: string
    }>
    const mapped = info.map(row => ({ name: row.name, notnull: row.notnull, dflt: row.dflt_value, type: row.type }))
    this.columns.set(table, mapped)
    return mapped
  }

  private putRow(table: 'sessions' | ChildTable, patch: RowPatch): void {
    const keys = TABLE_KEYS[table].pk
    const columns = Object.keys(patch)
    for (const key of keys) {
      if (!Object.hasOwn(patch, key)) {
        throw new Error(`"${table}" upsert is missing primary key column "${key}"`)
      }
    }
    // NOT NULL columns absent from the patch are filled with their declared
    // defaults on the INSERT side only: an existing row's DO UPDATE never
    // touches them, so patch-merges stay idempotent across replays.
    const fill: Array<[string, RowValue]> = []
    for (const info of this.columnsOf(table)) {
      if (info.notnull === 1 && !Object.hasOwn(patch, info.name)) {
        fill.push([info.name, declaredDefault(info)])
      }
    }
    const insertColumns = [...columns, ...fill.map(([name]) => name)]
    const values = [...columns.map(column => patch[column]), ...fill.map(([, value]) => value)]
    this.prepare(`${table}:${insertColumns.join(',')}`, upsertSql(table, keys, insertColumns, columns)).run(...values)
  }

  private updateRow(table: ChildTable, patch: RowPatch, key: string): void {
    if (!Object.hasOwn(patch, key)) {
      throw new Error(`"${table}" update is missing key column "${key}"`)
    }
    const columns = Object.keys(patch).filter(column => column !== 'session_id' && column !== key)
    if (columns.length === 0) return
    const sets = columns.map(column => `"${column}" = ?`).join(', ')
    const sql = `UPDATE "${table}" SET ${sets} WHERE "session_id" = ? AND "${key}" = ?`
    this.prepare(`${table}:upd:${key}:${columns.join(',')}`, sql).run(
      ...columns.map(column => patch[column]),
      patch.session_id,
      patch[key],
    )
  }

  private deleteRow(table: ChildTable, patch: RowPatch): void {
    const keys = TABLE_KEYS[table].pk
    const where = keys.map(key => `"${key}" = ?`).join(' AND ')
    this.prepare(`${table}:del:${keys.join(',')}`, `DELETE FROM "${table}" WHERE ${where}`).run(
      ...keys.map((key) => {
        if (!Object.hasOwn(patch, key)) {
          throw new Error(`"${table}" delete is missing primary key column "${key}"`)
        }
        return patch[key]
      }),
    )
  }

  private writeOne(input: SessionWrite): void {
    const hasSession = input.session !== undefined && Object.keys(input.session).length > 0
    const hasOps = input.ops !== undefined && input.ops.length > 0
    const hasCut = input.inheritedCutSeq !== undefined
    if (hasSession) this.putRow('sessions', { id: input.sessionId, ...input.session })
    if (hasOps) {
      for (const op of input.ops) {
        if (op.delete === true) this.deleteRow(op.table, op.patch)
        else if (op.update !== undefined) this.updateRow(op.table, op.patch, op.update)
        else this.putRow(op.table, op.patch)
      }
    }
    if (hasCut) {
      this.prepare('requests:inherited', 'UPDATE requests SET is_inherited = 1 WHERE session_id = ? AND seq <= ?')
        .run(input.sessionId, input.inheritedCutSeq)
    }
    if (input.foldState !== undefined) {
      this.putRow('fold_state', {
        session_id: input.sessionId,
        last_seq: input.foldState.lastSeq,
        state_json: input.foldState.stateJson,
        updated_at: Date.now(),
      })
    } else if (input.dropFoldState === true) {
      this.deleteRow('fold_state', { session_id: input.sessionId })
    }
    if (input.bumpDetailRev === true) {
      this.prepare('sessions:detailRev', 'UPDATE sessions SET detail_rev = detail_rev + 1 WHERE id = ?')
        .run(input.sessionId)
    }
    if (hasSession || hasOps || hasCut) {
      this.prepare('sessions:recompute', RECOMPUTE_SQL).run(input.sessionId)
    }
    this.bumpGeneration()
  }

  write(input: SessionWrite | readonly SessionWrite[]): void {
    const writes: readonly SessionWrite[] = Array.isArray(input) ? input : [input]
    const pending = writes.filter(write => this.hasWork(write))
    if (pending.length === 0) return
    let began = false
    try {
      this.db.exec('BEGIN IMMEDIATE')
      began = true
      for (const write of pending) this.writeOne(write)
      this.db.exec('COMMIT')
    } catch (error) {
      if (began) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // The original error stays actionable.
        }
      }
      throw error
    }
  }

  private hasWork(input: SessionWrite): boolean {
    if (input.session !== undefined && Object.keys(input.session).length > 0) return true
    if (input.ops !== undefined && input.ops.length > 0) return true
    if (input.foldState !== undefined || input.dropFoldState === true) return true
    return input.inheritedCutSeq !== undefined
  }

  deleteSession(sessionId: string): boolean {
    const row = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)
    if (row === undefined) return false
    let began = false
    try {
      this.db.exec('BEGIN IMMEDIATE')
      began = true
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
      this.bumpGeneration()
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      if (began) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // The original error stays actionable.
        }
      }
      throw error
    }
  }
}
