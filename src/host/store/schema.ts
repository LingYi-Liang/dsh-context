import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const STORE_APPLICATION_ID = 0x44534358

export const STORE_SCHEMA_VERSION = 1

export type StoreFailureKind = 'foreign' | 'corrupt' | 'io'

export class StoreOpenError extends Error {
  readonly kind: StoreFailureKind
  constructor(kind: StoreFailureKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export const CHILD_TABLES = [
  'steps', 'requests', 'tool_calls', 'surface_nodes', 'system_prompts', 'header_epochs',
  'header_tools', 'events', 'file_ops', 'skill_loads', 'timing_spans', 'fold_state',
] as const

export type ChildTable = (typeof CHILD_TABLES)[number]

export interface TableKeys {
  readonly pk: readonly string[]
}

export const TABLE_KEYS: Record<ChildTable | 'sessions' | 'meta', TableKeys> = {
  sessions: { pk: ['id'] },
  meta: { pk: ['key'] },
  steps: { pk: ['session_id', 'seq'] },
  requests: { pk: ['session_id', 'seq'] },
  tool_calls: { pk: ['session_id', 'seq'] },
  surface_nodes: { pk: ['session_id', 'seq'] },
  system_prompts: { pk: ['session_id', 'seq'] },
  header_epochs: { pk: ['session_id', 'seq'] },
  header_tools: { pk: ['session_id', 'epoch_seq', 'ordinal'] },
  events: { pk: ['session_id', 'seq'] },
  file_ops: { pk: ['session_id', 'seq', 'ordinal'] },
  skill_loads: { pk: ['session_id', 'seq'] },
  timing_spans: { pk: ['session_id', 'span_seq'] },
  fold_state: { pk: ['session_id'] },
}

const DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    cwd TEXT,
    parent_session TEXT,
    origin TEXT,
    is_seeded INTEGER NOT NULL DEFAULT 0,
    delegation_depth INTEGER,
    agent_preset TEXT,
    title TEXT NOT NULL DEFAULT '',
    blank INTEGER NOT NULL DEFAULT 0,
    last_prompt_at INTEGER,
    updated_at INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    workspace_title TEXT,
    running INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    provider TEXT,
    reasoning_effort TEXT,
    context_window INTEGER,
    max_output_tokens INTEGER,
    cur_total INTEGER NOT NULL DEFAULT 0,
    last_user TEXT,
    billed_tokens INTEGER NOT NULL DEFAULT 0,
    fold_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (fold_status IN ('pending','ok','failed','unsupported','folding')),
    fold_error TEXT,
    last_seq INTEGER NOT NULL DEFAULT -1,
    log_path TEXT,
    log_size INTEGER,
    log_mtime INTEGER,
    detail_rev INTEGER NOT NULL DEFAULT 0,
    folded_at INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS requests (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    time INTEGER NOT NULL,
    day TEXT,
    turn INTEGER,
    step INTEGER,
    starts_turn INTEGER NOT NULL DEFAULT 0,
    is_inherited INTEGER NOT NULL DEFAULT 0,
    system_tokens INTEGER NOT NULL DEFAULT 0,
    tools_tokens INTEGER NOT NULL DEFAULT 0,
    user_tokens INTEGER NOT NULL DEFAULT 0,
    inject_tokens INTEGER NOT NULL DEFAULT 0,
    skill_tokens INTEGER NOT NULL DEFAULT 0,
    assistant_tokens INTEGER NOT NULL DEFAULT 0,
    tool_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    provider TEXT,
    period TEXT CHECK (period IS NULL OR period IN ('peak','off')),
    prompt_tokens INTEGER,
    input_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    gen_ms INTEGER,
    active_ms INTEGER,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS steps (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    turn INTEGER,
    step INTEGER,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    day TEXT,
    request_seq INTEGER,
    wall_ms INTEGER NOT NULL DEFAULT 0,
    active_ms INTEGER NOT NULL DEFAULT 0,
    wait_ms INTEGER NOT NULL DEFAULT 0,
    idle_ms INTEGER NOT NULL DEFAULT 0,
    tool_busy_ms INTEGER NOT NULL DEFAULT 0,
    ttft_ms INTEGER,
    beats_full INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS tool_calls (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    call_id TEXT NOT NULL,
    result_seq INTEGER,
    name TEXT NOT NULL,
    plugin TEXT,
    transport INTEGER NOT NULL DEFAULT 0,
    code_mode INTEGER NOT NULL DEFAULT 0,
    parent_seq INTEGER,
    turn INTEGER,
    step INTEGER,
    day TEXT,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    duration_ms INTEGER,
    is_error INTEGER NOT NULL DEFAULT 0,
    status TEXT CHECK (status IS NULL OR status IN ('running','completed','failed','killed','background')),
    exit_code INTEGER,
    exit_inferred INTEGER,
    signal TEXT,
    timed_out INTEGER,
    stopped INTEGER,
    denied INTEGER,
    background INTEGER NOT NULL DEFAULT 0,
    timeout_ms INTEGER,
    sandbox TEXT,
    cmd TEXT,
    cmd_truncated INTEGER,
    cmd_description TEXT,
    cmd_cwd TEXT,
    program TEXT,
    derived INTEGER,
    out_chars INTEGER,
    out_truncated INTEGER,
    stderr INTEGER,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS surface_nodes (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    time INTEGER,
    cat TEXT NOT NULL CHECK (cat IN ('user','inject','skill','assistant','tool')),
    tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER,
    answer_tokens INTEGER,
    call_tokens INTEGER,
    imgs INTEGER,
    form TEXT,
    name TEXT,
    agent TEXT,
    tool TEXT,
    skill TEXT,
    is_error INTEGER NOT NULL DEFAULT 0,
    calls TEXT,
    preview TEXT,
    gone_seq INTEGER,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS system_prompts (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    time INTEGER NOT NULL,
    tokens INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS header_epochs (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    time INTEGER NOT NULL,
    tools_tokens INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS header_tools (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    epoch_seq INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    plugin TEXT,
    PRIMARY KEY (session_id, epoch_seq, ordinal)
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS events (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    time INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('inject','compaction','prune','model','mode')),
    sub TEXT,
    form TEXT,
    name TEXT,
    agent TEXT,
    detail TEXT,
    tokens INTEGER,
    gross_tokens INTEGER,
    node_count INTEGER,
    model_from TEXT,
    model_to TEXT,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS file_ops (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    time INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('read','write','search')),
    tool TEXT NOT NULL,
    path TEXT NOT NULL,
    is_error INTEGER NOT NULL DEFAULT 0,
    lines_added INTEGER NOT NULL DEFAULT 0,
    lines_removed INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    hits INTEGER,
    read_start INTEGER,
    read_count INTEGER,
    read_est INTEGER NOT NULL DEFAULT 0,
    parent_seq INTEGER,
    program TEXT,
    is_pattern INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, seq, ordinal)
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS skill_loads (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    time INTEGER NOT NULL,
    day TEXT,
    name TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('invocation','result','dispatch')),
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS timing_spans (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    span_seq INTEGER NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ttft','reasoning','text','toolarg','tools','other')),
    PRIMARY KEY (session_id, span_seq)
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS fold_state (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    last_seq INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID, STRICT`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID, STRICT`,
  'CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS sessions_archived ON sessions(archived, updated_at)',
  'CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions(workspace_title)',
  'CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_session)',
  'CREATE INDEX IF NOT EXISTS sessions_billed ON sessions(billed_tokens DESC)',
  'CREATE INDEX IF NOT EXISTS sessions_origin ON sessions(origin)',
  'CREATE INDEX IF NOT EXISTS requests_day ON requests(day, session_id)',
  'CREATE INDEX IF NOT EXISTS requests_turn ON requests(session_id, turn)',
  'CREATE INDEX IF NOT EXISTS requests_model ON requests(model)',
  'CREATE INDEX IF NOT EXISTS steps_start ON steps(session_id, start_time)',
  'CREATE INDEX IF NOT EXISTS steps_day ON steps(day)',
  'CREATE UNIQUE INDEX IF NOT EXISTS tool_calls_pair ON tool_calls(session_id, call_id)',
  'CREATE INDEX IF NOT EXISTS tool_calls_start ON tool_calls(session_id, start_time)',
  'CREATE INDEX IF NOT EXISTS tool_calls_day ON tool_calls(day, session_id)',
  'CREATE INDEX IF NOT EXISTS tool_calls_name ON tool_calls(session_id, name)',
  'CREATE INDEX IF NOT EXISTS tool_calls_name_all ON tool_calls(name)',
  'CREATE INDEX IF NOT EXISTS tool_calls_program ON tool_calls(program)',
  'CREATE INDEX IF NOT EXISTS surface_nodes_gone ON surface_nodes(session_id, gone_seq) WHERE gone_seq IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS events_kind ON events(session_id, kind)',
  'CREATE INDEX IF NOT EXISTS file_ops_path ON file_ops(session_id, path)',
  'CREATE INDEX IF NOT EXISTS skill_loads_name ON skill_loads(name, day)',
  'CREATE INDEX IF NOT EXISTS skill_loads_day ON skill_loads(day, session_id)',
  'CREATE INDEX IF NOT EXISTS skill_loads_session ON skill_loads(session_id, name)',
  'CREATE INDEX IF NOT EXISTS timing_spans_start ON timing_spans(session_id, start_time)',
]

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

function applyPragmas(db: DatabaseSync, path: string): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`PRAGMA journal_mode = ${path === ':memory:' ? 'MEMORY' : 'WAL'}`)
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA cache_size = -8000')
}

function seedMeta(db: DatabaseSync): void {
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('data_generation', '0')
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('pricing_version', '0')
}

function buildSchema(db: DatabaseSync): void {
  for (const statement of DDL) db.exec(statement)
  seedMeta(db)
  db.exec(`PRAGMA application_id = ${STORE_APPLICATION_ID}`)
  db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`)
}

function dropAll(db: DatabaseSync, tables: readonly string[]): void {
  for (const name of tables) db.exec(`DROP TABLE IF EXISTS ${quote(name)}`)
  db.exec('PRAGMA user_version = 0')
}

function createDatabaseFile(path: string): void {
  try {
    closeSync(openSync(path, 'wx', 0o600))
  } catch (error) {
    /* v8 ignore next 2 -- Windows surfaces an existing directory as EEXIST */
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new StoreOpenError('io', `cannot create "${path}": ${String(error)}`)
    }
  }
}

export interface OpenedStore {
  db: DatabaseSync
  rebuilt: boolean
}

const CORRUPT_MESSAGE = /not a database|malformed|encrypted|corrupt/i

function openFailure(actual: string, error: unknown): StoreOpenError {
  const message = String(error)
  if (CORRUPT_MESSAGE.test(message)) {
    return new StoreOpenError('corrupt', `"${actual}" is not a readable database: ${message}`)
  }
  /* v8 ignore next 1 */
  return new StoreOpenError('io', `cannot open "${actual}": ${message}`)
}

export function openStoreDb(path: string): OpenedStore {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    try {
      mkdirSync(dirname(actual), { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new StoreOpenError('io', `cannot create directory for "${actual}": ${String(error)}`)
    }
    createDatabaseFile(actual)
  }
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(actual)
  } catch (error) {
    throw openFailure(actual, error)
  }
  try {
    let applicationId = 0
    let userVersion = 0
    let tables: string[] = []
    try {
      applicationId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
      userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      tables = tableNames(db)
    } catch (error) {
      throw openFailure(actual, error)
    }
    if (applicationId !== 0 && applicationId !== STORE_APPLICATION_ID) {
      throw new StoreOpenError('foreign', `"${actual}" belongs to another application (id 0x${applicationId.toString(16)})`)
    }
    if (applicationId === 0 && tables.length > 0) {
      throw new StoreOpenError('foreign', `"${actual}" has user tables but no application id`)
    }
    // Mutating pragmas run only after the file is proven ours, so a foreign
    // database is closed without a single byte of change (journal_mode=HEADER).
    applyPragmas(db, actual)
    let rebuilt = false
    if (userVersion !== STORE_SCHEMA_VERSION) {
      dropAll(db, tables)
      buildSchema(db)
      rebuilt = tables.length > 0 || userVersion !== 0
    } else {
      buildSchema(db)
    }
    const check = (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check
    /* v8 ignore next 2 */
    if (check !== 'ok') {
      throw new StoreOpenError('corrupt', `"${actual}" failed quick_check: ${check}`)
    }
    return { db, rebuilt }
  } catch (error) {
    db.close()
    throw error
  }
}

export function removeStoreFile(path: string): void {
  rmSync(path, { force: true })
}

export { DDL }
