/**
 * Persistence — SQLite, the single source of truth (design §6).
 *
 * Exactly ONE writer per file (design invariant). Pragmas: WAL, foreign_keys=ON (real FKs).
 * Migrations are an ordered, APPEND-ONLY array; `PRAGMA user_version` = count run; each step +
 * bump in one transaction. NEVER edit or reorder a shipped step (an earlier build spliced steps
 * and databases past that index skipped them forever). Step 0 is all `IF NOT EXISTS`. A
 * `healMissingColumns` pass on every open re-adds a handful of columns as a backstop.
 *
 * The audit log (autonomy_actions) is the source of truth for what autonomy has done; dedupe is
 * a UNIQUE key; rate limits are SQL counts so a restart cannot reset them.
 *
 * All timestamps are epoch ms; money is integer micros.
 */

import { Database } from "bun:sqlite";
import type {
  Task, TaskStatus, Session, Tool, Location, Permissions, Effort,
  WorkItem, WorkItemKind, WorkItemLifecycle, WorkItemSource,
  AutonomyAction, AutonomyDecision, AutonomyStatus,
  Alert, AlertKind, AlertSeverity,
  SweepJob, SweepEvent, SweepKind, SweepState, SweepEventKind, LinearIssue,
} from "../shared/types.ts";

export const PRAGMAS = ["PRAGMA journal_mode = WAL", "PRAGMA foreign_keys = ON"];

/**
 * Append-only migration steps. Step 0 creates the whole schema with IF NOT EXISTS.
 * To evolve the schema, PUSH a new string; never edit an existing one.
 */
export const MIGRATIONS: string[] = [
  // --- step 0: initial schema -------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'open',      -- open | closed
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    order_idx     INTEGER NOT NULL                   -- max+1 on create; human-assigned order
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id                    TEXT PRIMARY KEY,
    task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title                 TEXT NOT NULL DEFAULT '',
    tool                  TEXT NOT NULL,             -- claude | codex | copilot | openrouter
    location              TEXT NOT NULL,             -- local | devbox
    cwd                   TEXT NOT NULL,             -- load-bearing: resume is cwd-scoped
    uses_worktree         INTEGER NOT NULL DEFAULT 0,
    worktree_path         TEXT,
    model                 TEXT NOT NULL DEFAULT 'auto',
    permissions           TEXT NOT NULL DEFAULT 'ask',
    effort                TEXT,
    resume_handle         TEXT,                      -- claude uuid | copilot name | openrouter id | codex NULL
    tmux_session          TEXT,                      -- ao-<id8>
    closed                INTEGER NOT NULL DEFAULT 0,
    created_at            INTEGER NOT NULL,
    closed_at             INTEGER,                   -- COALESCE on re-close
    worktree_branch       TEXT,
    profile_id            TEXT NOT NULL DEFAULT 'legacy',
    codex_transcript_path TEXT,
    codex_session_id      TEXT,
    planning              INTEGER NOT NULL DEFAULT 0,
    draft_may_be_stranded INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS work_items (
    id                       TEXT PRIMARY KEY,
    session_id               TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind                     TEXT NOT NULL,          -- pr | ticket
    external_key             TEXT NOT NULL,          -- owner/repo#123 | HOS-1989
    repo                     TEXT,
    number                   INTEGER,
    url                      TEXT,
    title                    TEXT,
    branch                   TEXT,
    lifecycle                TEXT NOT NULL DEFAULT 'active', -- active | retiring | retired
    pr_state                 TEXT,
    is_draft                 INTEGER NOT NULL DEFAULT 0,
    ci_state                 TEXT,
    failed_checks            TEXT NOT NULL DEFAULT '[]',
    review_state             TEXT,
    mergeable                TEXT,
    head_sha                 TEXT,
    head_committed_at        INTEGER,
    head_observed_at         INTEGER,                -- first time WE saw this head
    codex_state              TEXT,
    codex_reviewed_sha       TEXT,
    cto_state                TEXT,
    cto_reviewed_at          INTEGER,
    cto_reviewed_sha         TEXT,
    review_bot_state         TEXT,
    review_bot_at            INTEGER,
    thermo_grade             TEXT,                   -- NULL = never graded = blocker
    thermo_cycles            INTEGER NOT NULL DEFAULT 0,
    greenlight_state         TEXT NOT NULL DEFAULT 'absent',
    unresolved_comments      INTEGER NOT NULL DEFAULT 0,
    operator_acked_at        INTEGER,
    outstanding_reviewer_tags TEXT NOT NULL DEFAULT '[]',
    tickets                  TEXT NOT NULL DEFAULT '[]',
    source                   TEXT NOT NULL DEFAULT 'auto', -- auto | manual | transfer
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER NOT NULL,       -- poll timestamp — rewritten every poll
    remote_updated_at        INTEGER,               -- GitHub's own clock
    retired_at               INTEGER,
    last_polled_at           INTEGER,
    UNIQUE(session_id, external_key)
  );

  CREATE TABLE IF NOT EXISTS work_item_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id  TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    at            INTEGER NOT NULL,
    field         TEXT NOT NULL,
    "from"        TEXT,
    "to"          TEXT
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id            TEXT PRIMARY KEY,
    session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    work_item_id  TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    kind          TEXT NOT NULL,
    severity      TEXT NOT NULL DEFAULT 'attention', -- info | attention
    dedupe_key    TEXT NOT NULL UNIQUE,              -- MUST encode the transition
    summary       TEXT NOT NULL DEFAULT '',
    payload_json  TEXT NOT NULL DEFAULT '{}',
    attempts      INTEGER NOT NULL DEFAULT 0,        -- max 5
    created_at    INTEGER NOT NULL,
    notified_at   INTEGER,
    delivered_at  INTEGER,
    suppressed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS autonomy_actions (
    id            TEXT PRIMARY KEY,
    work_item_id  TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    dedupe_key    TEXT NOT NULL UNIQUE,              -- encodes the event identity, never the row
    status        TEXT NOT NULL,                     -- performed|queued|dry-run|suppressed|failed|undelivered|cancelled
    gate          TEXT,
    reason        TEXT,
    payload_json  TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS session_usage (
    session_id           TEXT NOT NULL,
    model                TEXT NOT NULL,
    input_tokens         INTEGER NOT NULL DEFAULT 0,
    output_tokens        INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens   INTEGER NOT NULL DEFAULT 0,
    reported_cost_micros INTEGER,
    PRIMARY KEY (session_id, model)
  );

  CREATE TABLE IF NOT EXISTS session_usage_progress (
    session_id  TEXT NOT NULL,
    path        TEXT NOT NULL,
    byte_mark   INTEGER NOT NULL DEFAULT 0,          -- high-water mark
    PRIMARY KEY (session_id, path)
  );

  CREATE TABLE IF NOT EXISTS session_usage_sample (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    at          INTEGER NOT NULL,                    -- 14-day retention
    payload_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS session_usage_series (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    model       TEXT NOT NULL,
    at          INTEGER NOT NULL,                    -- 14-day retention; cumulative points
    cost_micros INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS session_usage_daily (
    session_id  TEXT NOT NULL,
    day         TEXT NOT NULL,                       -- local-midnight day; kept forever
    model       TEXT NOT NULL,
    cost_micros INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, day, model)
  );

  CREATE TABLE IF NOT EXISTS linear_projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    url        TEXT,
    state      TEXT,
    team_keys  TEXT NOT NULL DEFAULT '[]',
    hidden     INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER,
    synced_at  INTEGER,
    seen_at    INTEGER
  );

  CREATE TABLE IF NOT EXISTS linear_issues (
    id             TEXT PRIMARY KEY,
    identifier     TEXT NOT NULL,
    project_id     TEXT,
    team_key       TEXT,
    title          TEXT NOT NULL DEFAULT '',
    url            TEXT,
    state_name     TEXT,
    state_type     TEXT,
    assignee       TEXT,
    priority       INTEGER,
    blocked_by     TEXT NOT NULL DEFAULT '[]',
    sort_order     INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER,
    synced_at      INTEGER,
    seen_at        INTEGER,
    assigned_to_me INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS game_scores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    score      INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // --- step 1: AO Lead Console sweep jobs (lead-console PRD §4-§5) -------------
  `
  CREATE TABLE IF NOT EXISTS sweep_job (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,                      -- 'in_review' | 'rescue'
    ticket_id   TEXT NOT NULL,
    ticket_key  TEXT NOT NULL,
    assignee    TEXT,
    pr_number   INTEGER,
    head_sha    TEXT,
    state       TEXT NOT NULL DEFAULT 'queued',
    cycles      INTEGER NOT NULL DEFAULT 0,
    gate        TEXT,                               -- JSON { ac, ci, findings, grade }
    reason      TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- idempotency: in-review re-runs only on a new commit
  CREATE UNIQUE INDEX IF NOT EXISTS uq_sweep_review ON sweep_job(ticket_id, head_sha)
    WHERE kind = 'in_review';
  -- idempotency: at most ONE active rescue per ticket
  CREATE UNIQUE INDEX IF NOT EXISTS uq_sweep_rescue_active ON sweep_job(ticket_id)
    WHERE kind = 'rescue' AND state NOT IN ('merged', 'failed');

  CREATE TABLE IF NOT EXISTS sweep_event (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  TEXT NOT NULL REFERENCES sweep_job(id) ON DELETE CASCADE,
    at      INTEGER NOT NULL,
    event   TEXT NOT NULL,
    detail  TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_sweep_event_job ON sweep_event(job_id, at);
  `,
  // --- step 2: link a sweep job to the agent session driving it (PRD §4; the TUI attaches via it) ---
  // Nullable: a job is queued before any agent exists, and the link is set when the fixer/implementer
  // is spawned. ON DELETE SET NULL keeps the durable job row if its session is later reaped.
  `
  ALTER TABLE sweep_job ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
  `,
  // --- step 3: rescue-sweep eligibility data on linear_issues (PRD §5: overdue + not lead-level) -----
  `
  ALTER TABLE linear_issues ADD COLUMN due_date INTEGER;
  ALTER TABLE linear_issues ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
  `,
];

/**
 * Columns re-added on every open as a backstop against a spliced/rolled-back migration history
 * (design §6 healMissingColumns). Each entry is [table, column, DDL fragment] where the fragment is
 * what follows `ALTER TABLE <table> ADD COLUMN <column> ...`. Register every column added after step 0.
 * NOTE: the apply pass in migrate() is still a TODO, so these entries are a forward-looking register —
 * nothing consumes them yet; wiring the heal pass is a later slice.
 */
export const HEAL_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ["sweep_job", "session_id", "TEXT REFERENCES sessions(id) ON DELETE SET NULL"], // step 2
  ["linear_issues", "due_date", "INTEGER"], // step 3
  ["linear_issues", "labels", "TEXT NOT NULL DEFAULT '[]'"], // step 3
];

/**
 * Run the append-only migrations under `PRAGMA user_version`, each step in one transaction, then
 * the heal pass. This is the schema skeleton — data-access methods below are stubs.
 */
export function migrate(db: Database): void {
  for (const p of PRAGMAS) db.run(p);
  const current = (db.query("PRAGMA user_version").get() as { user_version: number } | null)?.user_version ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    const step = MIGRATIONS[i]!;
    db.transaction(() => {
      db.run(step);
      db.run(`PRAGMA user_version = ${i + 1}`);
    })();
  }
  // TODO: apply HEAL_COLUMNS with IF-NOT-EXISTS semantics (ALTER TABLE ADD COLUMN, ignore dup).
}

type Row = Record<string, any>;

const b = (v: unknown): boolean => v === 1 || v === true;
const i = (v: boolean): number => (v ? 1 : 0);

export interface CreateTaskParams {
  name: string;
  description?: string;
}

export interface CreateSessionParams {
  taskId: string;
  title?: string;
  tool: Tool;
  location: Location;
  cwd: string;
  usesWorktree?: boolean;
  worktreePath?: string | null;
  model?: string;
  permissions?: Permissions;
  effort?: Effort | null;
  resumeHandle?: string | null;
  tmuxSession?: string | null;
  worktreeBranch?: string | null;
  profileId?: string;
}

/** Fields of a session that may be updated after creation. */
export type SessionPatch = Partial<Pick<Session,
  | "title" | "cwd" | "usesWorktree" | "model" | "permissions" | "effort" | "resumeHandle"
  | "tmuxSession" | "worktreePath" | "worktreeBranch" | "planning" | "draftMayBeStranded"
  | "codexTranscriptPath" | "codexSessionId">>;

/**
 * The typed data-access layer over the SQLite file (design §6). The daemon holds exactly one of
 * these; the Mac reads the box DB only through a one-shot read-only process. Methods are added per
 * build step — Milestone 1 covers tasks and sessions.
 */
function rowToLinearIssue(r: Row): LinearIssue {
  return {
    id: r.id, identifier: r.identifier, title: r.title ?? "",
    stateName: r.state_name ?? null, stateType: r.state_type ?? null, assignee: r.assignee ?? null,
    projectId: r.project_id ?? null, teamKey: r.team_key ?? null, url: r.url ?? null,
    priority: r.priority ?? null, blockedBy: r.blocked_by ? JSON.parse(r.blocked_by) : [],
    dueDate: r.due_date ?? null, labels: r.labels ? JSON.parse(r.labels) : [],
    updatedAt: r.updated_at ?? null,
  };
}

function rowToSweepJob(r: Row): SweepJob {
  return {
    id: r.id, kind: r.kind as SweepKind, ticketId: r.ticket_id, ticketKey: r.ticket_key,
    assignee: r.assignee ?? null, prNumber: r.pr_number ?? null, headSha: r.head_sha ?? null,
    sessionId: r.session_id ?? null,
    state: r.state as SweepState, cycles: r.cycles,
    gate: r.gate == null ? null : JSON.parse(r.gate), reason: r.reason ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function rowToSweepEvent(r: Row): SweepEvent {
  return {
    id: r.id, jobId: r.job_id, at: r.at, event: r.event as SweepEventKind,
    detail: r.detail == null ? null : JSON.parse(r.detail),
  };
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  // --- tasks ---------------------------------------------------------------

  createTask(params: CreateTaskParams): Task {
    const now = Date.now();
    const id = crypto.randomUUID();
    const nextIdx =
      (this.db.query("SELECT COALESCE(MAX(order_idx), 0) + 1 AS n FROM tasks").get() as Row).n as number;
    this.db.run(
      `INSERT INTO tasks (id, name, description, status, created_at, updated_at, order_idx)
       VALUES (?, ?, ?, 'open', ?, ?, ?)`,
      [id, params.name, params.description ?? "", now, now, nextIdx],
    );
    return this.getTask(id)!;
  }

  getTask(id: string): Task | null {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Row | null;
    return row ? rowToTask(row) : null;
  }

  /** Human-assigned order: open tasks first, then by order_idx (design §6). */
  listTasks(includeClosed = true): Task[] {
    const sql = includeClosed
      ? "SELECT * FROM tasks ORDER BY (status = 'closed') ASC, order_idx ASC"
      : "SELECT * FROM tasks WHERE status = 'open' ORDER BY order_idx ASC";
    return (this.db.query(sql).all() as Row[]).map(rowToTask);
  }

  updateTask(id: string, patch: { name?: string; description?: string }): Task | null {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); vals.push(patch.name); }
    if (patch.description !== undefined) { sets.push("description = ?"); vals.push(patch.description); }
    if (sets.length === 0) return this.getTask(id);
    sets.push("updated_at = ?"); vals.push(Date.now());
    vals.push(id);
    this.db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, vals as any);
    return this.getTask(id);
  }

  closeTask(id: string): void {
    this.db.run("UPDATE tasks SET status = 'closed', updated_at = ? WHERE id = ?", [Date.now(), id]);
  }

  reopenTask(id: string): void {
    this.db.run("UPDATE tasks SET status = 'open', updated_at = ? WHERE id = ?", [Date.now(), id]);
  }

  // --- sessions ------------------------------------------------------------

  createSession(params: CreateSessionParams): Session {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO sessions (
         id, task_id, title, tool, location, cwd, uses_worktree, worktree_path, model,
         permissions, effort, resume_handle, tmux_session, closed, created_at, closed_at,
         worktree_branch, profile_id, codex_transcript_path, codex_session_id, planning,
         draft_may_be_stranded
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, NULL, NULL, 0, 0)`,
      [
        id, params.taskId, params.title ?? "", params.tool, params.location, params.cwd,
        i(params.usesWorktree ?? false), params.worktreePath ?? null, params.model ?? "auto",
        params.permissions ?? "ask", params.effort ?? null, params.resumeHandle ?? null,
        params.tmuxSession ?? null, now, params.worktreeBranch ?? null, params.profileId ?? "legacy",
      ],
    );
    return this.getSession(id)!;
  }

  getSession(id: string): Session | null {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as Row | null;
    return row ? rowToSession(row) : null;
  }

  listSessions(opts: { taskId?: string; includeClosed?: boolean } = {}): Session[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (opts.taskId) { where.push("task_id = ?"); vals.push(opts.taskId); }
    if (!opts.includeClosed) where.push("closed = 0");
    const sql =
      "SELECT * FROM sessions" + (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY created_at ASC";
    return (this.db.query(sql).all(...(vals as any[])) as Row[]).map(rowToSession);
  }

  updateSession(id: string, patch: SessionPatch): Session | null {
    const map: Record<keyof SessionPatch, string> = {
      title: "title", cwd: "cwd", usesWorktree: "uses_worktree", model: "model",
      permissions: "permissions", effort: "effort", resumeHandle: "resume_handle",
      tmuxSession: "tmux_session", worktreePath: "worktree_path", worktreeBranch: "worktree_branch",
      planning: "planning", draftMayBeStranded: "draft_may_be_stranded",
      codexTranscriptPath: "codex_transcript_path", codexSessionId: "codex_session_id",
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, col] of Object.entries(map) as [keyof SessionPatch, string][]) {
      const v = patch[key];
      if (v === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(typeof v === "boolean" ? i(v) : v);
    }
    if (sets.length === 0) return this.getSession(id);
    vals.push(id);
    this.db.run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, vals as any);
    return this.getSession(id);
  }

  /** Close a session; COALESCE closed_at so a redundant close can't push the reaper deadline (§6). */
  closeSession(id: string): void {
    const now = Date.now();
    this.db.run(
      "UPDATE sessions SET closed = 1, closed_at = COALESCE(closed_at, ?) WHERE id = ?",
      [now, id],
    );
  }

  removeSession(id: string): void {
    this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
  }

  // --- work items ----------------------------------------------------------

  getWorkItem(sessionId: string, externalKey: string): WorkItem | null {
    const row = this.db.query("SELECT * FROM work_items WHERE session_id = ? AND external_key = ?")
      .get(sessionId, externalKey) as Row | null;
    return row ? rowToWorkItem(row) : null;
  }

  getWorkItemById(id: string): WorkItem | null {
    const row = this.db.query("SELECT * FROM work_items WHERE id = ?").get(id) as Row | null;
    return row ? rowToWorkItem(row) : null;
  }

  listWorkItemsBySession(sessionId: string, includeRetired = false): WorkItem[] {
    const sql = includeRetired
      ? "SELECT * FROM work_items WHERE session_id = ? ORDER BY created_at ASC"
      : "SELECT * FROM work_items WHERE session_id = ? AND lifecycle != 'retired' ORDER BY created_at ASC";
    return (this.db.query(sql).all(sessionId) as Row[]).map(rowToWorkItem);
  }

  listActiveWorkItems(): WorkItem[] {
    return (this.db.query("SELECT * FROM work_items WHERE lifecycle != 'retired' ORDER BY created_at ASC")
      .all() as Row[]).map(rowToWorkItem);
  }

  /** All rows sharing an external_key (design §6: lookups widen to "all siblings"). */
  siblingsOf(externalKey: string): WorkItem[] {
    return (this.db.query("SELECT * FROM work_items WHERE external_key = ?").all(externalKey) as Row[])
      .map(rowToWorkItem);
  }

  /**
   * Insert or update a work item, keyed by UNIQUE(session_id, external_key). Sets head_observed_at the
   * first time a new head_sha is seen (anchors the delayed CTO nudge, §6). Returns the row.
   */
  upsertWorkItem(input: { sessionId: string; kind: WorkItemKind; externalKey: string } & Partial<WorkItem>): WorkItem {
    const now = Date.now();
    const existing = this.getWorkItem(input.sessionId, input.externalKey);

    let headObservedAt = existing?.headObservedAt ?? null;
    if (input.headSha !== undefined && (!existing || existing.headSha !== input.headSha)) {
      headObservedAt = now;
    }

    if (!existing) {
      this.db.run(
        `INSERT INTO work_items
           (id, session_id, kind, external_key, lifecycle, source, failed_checks,
            outstanding_reviewer_tags, tickets, is_draft, thermo_cycles, greenlight_state,
            unresolved_comments, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, '[]', '[]', '[]', 0, 0, 'absent', 0, ?, ?)`,
        [crypto.randomUUID(), input.sessionId, input.kind, input.externalKey, input.source ?? "auto", now, now],
      );
    }

    const id = (existing?.id) ?? (this.getWorkItem(input.sessionId, input.externalKey)!.id);
    this.applyWorkItemUpdate(id, input, headObservedAt, now);
    return this.getWorkItemById(id)!;
  }

  private applyWorkItemUpdate(id: string, input: Partial<WorkItem>, headObservedAt: number | null, now: number): void {
    const sets: string[] = ["updated_at = ?", "last_polled_at = ?", "head_observed_at = ?"];
    const vals: unknown[] = [now, now, headObservedAt];
    for (const [key, spec] of Object.entries(WI_MAP)) {
      const v = (input as Record<string, unknown>)[key];
      if (v === undefined) continue;
      sets.push(`${spec.col} = ?`);
      vals.push(spec.json ? JSON.stringify(v) : spec.bool ? (v ? 1 : 0) : (v as unknown));
    }
    vals.push(id);
    this.db.run(`UPDATE work_items SET ${sets.join(", ")} WHERE id = ?`, vals as any);
  }

  setWorkItemLifecycle(id: string, lifecycle: WorkItemLifecycle, retiredAt: number | null = null): void {
    this.db.run("UPDATE work_items SET lifecycle = ?, retired_at = ?, updated_at = ? WHERE id = ?",
      [lifecycle, retiredAt, Date.now(), id]);
  }

  removeWorkItem(id: string): void {
    this.db.run("DELETE FROM work_items WHERE id = ?", [id]);
  }

  /** Append a field transition (design §6 work_item_events). */
  appendWorkItemEvent(workItemId: string, field: string, from: string | null, to: string | null): void {
    this.db.run(`INSERT INTO work_item_events (work_item_id, at, field, "from", "to") VALUES (?, ?, ?, ?, ?)`,
      [workItemId, Date.now(), field, from, to]);
  }

  // --- autonomy audit log (design §6, §13.5) -------------------------------

  getAction(dedupeKey: string): AutonomyAction | null {
    const row = this.db.query("SELECT * FROM autonomy_actions WHERE dedupe_key = ?").get(dedupeKey) as Row | null;
    return row ? rowToAction(row) : null;
  }

  /**
   * Record an autonomy attempt (design §13.5). The dedupe_key is UNIQUE: a new row SUPERSEDES an
   * existing dry-run/failed/undelivered/suppressed row, but NEVER a terminal performed/queued/cancelled
   * one. `failed` increments attempts; `undelivered` carries attempts unchanged. Returns the row.
   */
  recordAction(input: {
    action: AutonomyDecision; dedupeKey: string; status: AutonomyStatus;
    workItemId?: string | null; sessionId?: string | null; gate?: string | null;
    reason?: string | null; payload?: unknown;
  }): AutonomyAction {
    const now = Date.now();
    const existing = this.getAction(input.dedupeKey);
    const TERMINAL = new Set<AutonomyStatus>(["performed", "queued", "cancelled"]);
    if (existing && TERMINAL.has(existing.status)) return existing; // never overwrite a terminal row

    const attempts = input.status === "failed" ? (existing?.attempts ?? 0) + 1 : (existing?.attempts ?? 0);
    const payloadJson = JSON.stringify(input.payload ?? {});
    if (existing) {
      this.db.run(
        `UPDATE autonomy_actions SET action=?, status=?, gate=?, reason=?, payload_json=?, attempts=?, created_at=?
           WHERE dedupe_key=?`,
        [input.action, input.status, input.gate ?? null, input.reason ?? null, payloadJson, attempts, now, input.dedupeKey],
      );
    } else {
      this.db.run(
        `INSERT INTO autonomy_actions
           (id, work_item_id, session_id, action, dedupe_key, status, gate, reason, payload_json, created_at, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), input.workItemId ?? null, input.sessionId ?? null, input.action,
         input.dedupeKey, input.status, input.gate ?? null, input.reason ?? null, payloadJson, now, attempts],
      );
    }
    return this.getAction(input.dedupeKey)!;
  }

  /** True iff a terminal row (performed/queued/cancelled) exists for this key (gate 8, §13.5). */
  hasTerminalAction(dedupeKey: string): boolean {
    const a = this.getAction(dedupeKey);
    return !!a && (a.status === "performed" || a.status === "queued" || a.status === "cancelled");
  }

  /** Failed-attempt count for a key (gate 7: >= 2 => already-attempted, §13.5). */
  failedAttemptCount(dedupeKey: string): number {
    const a = this.getAction(dedupeKey);
    return a && a.status === "failed" ? a.attempts : 0;
  }

  /**
   * Count "acted" rows (performed/queued/dry-run) in a trailing window, for the rate limits (§13.5).
   * Excludes manual settlement rows (their keys contain ":" segments starting with manual — we key
   * manual rows as `<action>:<uuid>` / `manual:*`, so filter those out by prefix).
   */
  countActed(sinceMs: number, filter: { sessionId?: string; externalKey?: string; action?: string } = {}): number {
    const where = ["status IN ('performed','queued','dry-run')", "created_at >= ?", "dedupe_key NOT LIKE 'manual%'"];
    const vals: unknown[] = [sinceMs];
    if (filter.sessionId) { where.push("session_id = ?"); vals.push(filter.sessionId); }
    if (filter.externalKey) { where.push("dedupe_key LIKE ?"); vals.push(`%:${filter.externalKey}:%`); }
    if (filter.action) { where.push("action = ?"); vals.push(filter.action); }
    const row = this.db.query(`SELECT COUNT(*) AS n FROM autonomy_actions WHERE ${where.join(" AND ")}`)
      .get(...(vals as any[])) as Row;
    return row.n as number;
  }

  /** Recent audit rows for the activity log (design §19 `A`). */
  listActions(limit = 40): AutonomyAction[] {
    return (this.db.query("SELECT * FROM autonomy_actions ORDER BY created_at DESC LIMIT ?").all(limit) as Row[])
      .map(rowToAction);
  }

  // --- alerts (design §6, §15.1) -------------------------------------------

  /** Record an alert (dedupe_key UNIQUE — a second occurrence of the same transition is a no-op). */
  recordAlert(input: {
    kind: AlertKind; dedupeKey: string; severity?: AlertSeverity; summary?: string;
    sessionId?: string | null; workItemId?: string | null; payload?: unknown;
  }): Alert {
    const existing = this.db.query("SELECT * FROM alerts WHERE dedupe_key = ?").get(input.dedupeKey) as Row | null;
    if (existing) return rowToAlert(existing);
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO alerts (id, session_id, work_item_id, kind, severity, dedupe_key, summary, payload_json, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [id, input.sessionId ?? null, input.workItemId ?? null, input.kind, input.severity ?? "attention",
       input.dedupeKey, input.summary ?? "", JSON.stringify(input.payload ?? {}), Date.now()],
    );
    return this.getAlert(id)!;
  }

  getAlert(id: string): Alert | null {
    const row = this.db.query("SELECT * FROM alerts WHERE id = ?").get(id) as Row | null;
    return row ? rowToAlert(row) : null;
  }

  /** Undelivered, un-suppressed alerts still within the attempt budget (design §15.1). */
  pendingAlerts(maxAttempts = 5): Alert[] {
    return (this.db.query(
      `SELECT * FROM alerts WHERE delivered_at IS NULL AND suppressed_at IS NULL AND attempts < ?
         ORDER BY created_at ASC`).all(maxAttempts) as Row[]).map(rowToAlert);
  }

  /** Mark notified + increment attempts BEFORE invoking the narrator (a crash must not replay, §15.1). */
  markAlertNotified(id: string): void {
    this.db.run("UPDATE alerts SET notified_at = ?, attempts = attempts + 1 WHERE id = ?", [Date.now(), id]);
  }

  markAlertDelivered(id: string): void {
    this.db.run("UPDATE alerts SET delivered_at = ? WHERE id = ?", [Date.now(), id]);
  }

  markAlertSuppressed(id: string): void {
    this.db.run("UPDATE alerts SET suppressed_at = ? WHERE id = ?", [Date.now(), id]);
  }

  listAlerts(limit = 50): Alert[] {
    return (this.db.query("SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(rowToAlert);
  }

  // --- usage (design §15.2) ------------------------------------------------

  /** Accumulate lifetime token totals + cost for a (session, model). */
  accumulateUsage(sessionId: string, model: string, add: {
    input: number; output: number; cacheRead: number; cacheWrite: number; costMicros?: number | null;
  }): void {
    this.db.run(
      `INSERT INTO session_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reported_cost_micros)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, model) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         reported_cost_micros = COALESCE(reported_cost_micros, 0) + COALESCE(excluded.reported_cost_micros, 0)`,
      [sessionId, model, add.input, add.output, add.cacheRead, add.cacheWrite, add.costMicros ?? null],
    );
  }

  usageProgress(sessionId: string, path: string): number {
    const row = this.db.query("SELECT byte_mark FROM session_usage_progress WHERE session_id = ? AND path = ?")
      .get(sessionId, path) as Row | null;
    return (row?.byte_mark as number) ?? 0;
  }

  setUsageProgress(sessionId: string, path: string, byteMark: number): void {
    this.db.run(
      `INSERT INTO session_usage_progress (session_id, path, byte_mark) VALUES (?, ?, ?)
       ON CONFLICT(session_id, path) DO UPDATE SET byte_mark = excluded.byte_mark`,
      [sessionId, path, byteMark]);
  }

  usageTotals(): Array<{ sessionId: string; model: string; input: number; output: number; costMicros: number | null }> {
    return (this.db.query("SELECT * FROM session_usage").all() as Row[]).map((r) => ({
      sessionId: r.session_id, model: r.model, input: r.input_tokens, output: r.output_tokens,
      costMicros: r.reported_cost_micros,
    }));
  }

  // ---- AO Lead Console sweeps (lead-console PRD §4-§5) ----

  createSweepJob(p: {
    kind: SweepKind; ticketId: string; ticketKey: string;
    assignee?: string | null; prNumber?: number | null; headSha?: string | null;
  }): SweepJob {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO sweep_job (id, kind, ticket_id, ticket_key, assignee, pr_number, head_sha, state, cycles, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
      [id, p.kind, p.ticketId, p.ticketKey, p.assignee ?? null, p.prNumber ?? null, p.headSha ?? null, now, now],
    );
    return this.getSweepJob(id)!;
  }

  getSweepJob(id: string): SweepJob | null {
    const row = this.db.query("SELECT * FROM sweep_job WHERE id = ?").get(id) as Row | null;
    return row ? rowToSweepJob(row) : null;
  }

  listSweepJobs(filter: { kind?: SweepKind; state?: SweepState } = {}): SweepJob[] {
    const where: string[] = [];
    const vals: any[] = [];
    if (filter.kind) { where.push("kind = ?"); vals.push(filter.kind); }
    if (filter.state) { where.push("state = ?"); vals.push(filter.state); }
    const sql = `SELECT * FROM sweep_job ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at ASC`;
    return (this.db.query(sql).all(...vals) as Row[]).map(rowToSweepJob);
  }

  /** Patch a job's mutable fields (state, cycles, pr, head, session, gate, reason); bumps updated_at. */
  transitionSweepJob(id: string, patch: {
    state?: SweepState; cycles?: number; prNumber?: number | null;
    headSha?: string | null; sessionId?: string | null; gate?: unknown; reason?: string | null;
  }): SweepJob {
    const sets: string[] = ["updated_at = ?"];
    const vals: any[] = [Date.now()];
    if (patch.state !== undefined)     { sets.push("state = ?");      vals.push(patch.state); }
    if (patch.cycles !== undefined)    { sets.push("cycles = ?");     vals.push(patch.cycles); }
    if (patch.prNumber !== undefined)  { sets.push("pr_number = ?");  vals.push(patch.prNumber); }
    if (patch.headSha !== undefined)   { sets.push("head_sha = ?");   vals.push(patch.headSha); }
    if (patch.sessionId !== undefined) { sets.push("session_id = ?"); vals.push(patch.sessionId); }
    if (patch.gate !== undefined)      { sets.push("gate = ?");       vals.push(patch.gate === null ? null : JSON.stringify(patch.gate)); }
    if (patch.reason !== undefined)    { sets.push("reason = ?");     vals.push(patch.reason); }
    this.db.run(`UPDATE sweep_job SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
    return this.getSweepJob(id)!;
  }

  recordSweepEvent(jobId: string, event: SweepEventKind, detail?: unknown): SweepEvent {
    this.db.run(
      "INSERT INTO sweep_event (job_id, at, event, detail) VALUES (?, ?, ?, ?)",
      [jobId, Date.now(), event, detail === undefined ? null : JSON.stringify(detail)],
    );
    return rowToSweepEvent(this.db.query("SELECT * FROM sweep_event WHERE rowid = last_insert_rowid()").get() as Row);
  }

  listSweepEvents(jobId: string): SweepEvent[] {
    return (this.db.query("SELECT * FROM sweep_event WHERE job_id = ? ORDER BY at ASC, id ASC").all(jobId) as Row[]).map(rowToSweepEvent);
  }

  // ---- Linear issue sync + in-review enqueue (first live slice, PRD §4) ----

  upsertLinearIssue(i: {
    id: string; identifier: string; title?: string;
    stateName?: string | null; stateType?: string | null; assignee?: string | null;
    projectId?: string | null; teamKey?: string | null; url?: string | null;
    priority?: number | null; blockedBy?: string[]; dueDate?: number | null; labels?: string[];
    updatedAt?: number | null;
  }): void {
    this.db.run(
      `INSERT INTO linear_issues (id, identifier, project_id, team_key, title, url, state_name, state_type, assignee, priority, blocked_by, due_date, labels, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         identifier = excluded.identifier, project_id = excluded.project_id, team_key = excluded.team_key,
         title = excluded.title, url = excluded.url, state_name = excluded.state_name,
         state_type = excluded.state_type, assignee = excluded.assignee, priority = excluded.priority,
         blocked_by = excluded.blocked_by, due_date = excluded.due_date, labels = excluded.labels,
         updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
      [i.id, i.identifier, i.projectId ?? null, i.teamKey ?? null, i.title ?? "", i.url ?? null,
       i.stateName ?? null, i.stateType ?? null, i.assignee ?? null, i.priority ?? null,
       JSON.stringify(i.blockedBy ?? []), i.dueDate ?? null, JSON.stringify(i.labels ?? []), i.updatedAt ?? null, Date.now()],
    );
  }

  listLinearIssues(stateName?: string): LinearIssue[] {
    const sql = `SELECT * FROM linear_issues ${stateName ? "WHERE state_name = ?" : ""} ORDER BY sort_order ASC, identifier ASC`;
    const rows = (stateName ? this.db.query(sql).all(stateName) : this.db.query(sql).all()) as Row[];
    return rows.map(rowToLinearIssue);
  }

  getLinearIssue(id: string): LinearIssue | null {
    const row = this.db.query("SELECT * FROM linear_issues WHERE id = ?").get(id) as Row | null;
    return row ? rowToLinearIssue(row) : null;
  }

  /**
   * Enqueue an in-review sweep job for every Linear issue in `stateName` that does not
   * already have an active in-review job. The first live slice: linear_issues -> sweep_job.
   * Idempotent — safe to run on every sweep trigger. Returns the jobs it created.
   */
  enqueueInReviewSweeps(stateName = "In Review"): SweepJob[] {
    const created: SweepJob[] = [];
    for (const iss of this.listLinearIssues(stateName)) {
      const active = this.db.query(
        `SELECT 1 FROM sweep_job WHERE kind = 'in_review' AND ticket_id = ? AND state NOT IN ('merged', 'failed') LIMIT 1`,
      ).get(iss.id);
      if (active) continue;
      created.push(this.createSweepJob({
        kind: "in_review", ticketId: iss.id, ticketKey: iss.identifier, assignee: iss.assignee,
      }));
    }
    return created;
  }
}

function rowToAlert(r: Row): Alert {
  return {
    id: r.id, sessionId: r.session_id, workItemId: r.work_item_id, kind: r.kind as AlertKind,
    severity: r.severity as AlertSeverity, dedupeKey: r.dedupe_key, summary: r.summary,
    payloadJson: r.payload_json, attempts: r.attempts, createdAt: r.created_at,
    notifiedAt: r.notified_at, deliveredAt: r.delivered_at, suppressedAt: r.suppressed_at,
  };
}

function rowToAction(r: Row): AutonomyAction {
  return {
    id: r.id, workItemId: r.work_item_id, sessionId: r.session_id, action: r.action as AutonomyDecision,
    dedupeKey: r.dedupe_key, status: r.status as AutonomyStatus, gate: r.gate, reason: r.reason,
    payloadJson: r.payload_json, createdAt: r.created_at, attempts: r.attempts,
  };
}

/** camelCase WorkItem field -> column, with JSON / boolean coercion, for updatable columns. */
const WI_MAP: Record<string, { col: string; json?: boolean; bool?: boolean }> = {
  repo: { col: "repo" }, number: { col: "number" }, url: { col: "url" }, title: { col: "title" },
  branch: { col: "branch" }, lifecycle: { col: "lifecycle" }, prState: { col: "pr_state" },
  isDraft: { col: "is_draft", bool: true }, ciState: { col: "ci_state" },
  failedChecks: { col: "failed_checks", json: true }, reviewState: { col: "review_state" },
  mergeable: { col: "mergeable" }, headSha: { col: "head_sha" }, headCommittedAt: { col: "head_committed_at" },
  codexState: { col: "codex_state" }, codexReviewedSha: { col: "codex_reviewed_sha" },
  ctoState: { col: "cto_state" }, ctoReviewedAt: { col: "cto_reviewed_at" }, ctoReviewedSha: { col: "cto_reviewed_sha" },
  reviewBotState: { col: "review_bot_state" }, reviewBotAt: { col: "review_bot_at" },
  thermoGrade: { col: "thermo_grade" }, thermoCycles: { col: "thermo_cycles" },
  greenlightState: { col: "greenlight_state" }, unresolvedComments: { col: "unresolved_comments" },
  operatorAckedAt: { col: "operator_acked_at" },
  outstandingReviewerTags: { col: "outstanding_reviewer_tags", json: true },
  tickets: { col: "tickets", json: true }, source: { col: "source" },
  remoteUpdatedAt: { col: "remote_updated_at" }, retiredAt: { col: "retired_at" },
};

const parseJsonArr = (v: unknown): string[] => {
  try { const a = JSON.parse(String(v ?? "[]")); return Array.isArray(a) ? a : []; } catch { return []; }
};

function rowToWorkItem(r: Row): WorkItem {
  return {
    id: r.id, sessionId: r.session_id, kind: r.kind as WorkItemKind, externalKey: r.external_key,
    repo: r.repo, number: r.number, url: r.url, title: r.title, branch: r.branch,
    lifecycle: r.lifecycle as WorkItemLifecycle, prState: r.pr_state, isDraft: b(r.is_draft),
    ciState: r.ci_state, failedChecks: parseJsonArr(r.failed_checks), reviewState: r.review_state,
    mergeable: r.mergeable, headSha: r.head_sha, headCommittedAt: r.head_committed_at,
    headObservedAt: r.head_observed_at, codexState: r.codex_state, codexReviewedSha: r.codex_reviewed_sha,
    ctoState: r.cto_state, ctoReviewedAt: r.cto_reviewed_at, ctoReviewedSha: r.cto_reviewed_sha,
    reviewBotState: r.review_bot_state, reviewBotAt: r.review_bot_at, thermoGrade: r.thermo_grade,
    thermoCycles: r.thermo_cycles, greenlightState: r.greenlight_state,
    unresolvedComments: r.unresolved_comments, operatorAckedAt: r.operator_acked_at,
    outstandingReviewerTags: parseJsonArr(r.outstanding_reviewer_tags), tickets: parseJsonArr(r.tickets),
    source: r.source as WorkItemSource, createdAt: r.created_at, updatedAt: r.updated_at,
    remoteUpdatedAt: r.remote_updated_at, retiredAt: r.retired_at, lastPolledAt: r.last_polled_at,
  };
}

function rowToTask(r: Row): Task {
  return {
    id: r.id, name: r.name, description: r.description, status: r.status as TaskStatus,
    createdAt: r.created_at, updatedAt: r.updated_at, orderIdx: r.order_idx,
  };
}

function rowToSession(r: Row): Session {
  return {
    id: r.id, taskId: r.task_id, title: r.title, tool: r.tool as Tool,
    location: r.location as Location, cwd: r.cwd, usesWorktree: b(r.uses_worktree),
    worktreePath: r.worktree_path, model: r.model, permissions: r.permissions as Permissions,
    effort: (r.effort as Effort | null) ?? null, resumeHandle: r.resume_handle,
    tmuxSession: r.tmux_session, closed: b(r.closed), createdAt: r.created_at,
    closedAt: r.closed_at, worktreeBranch: r.worktree_branch, profileId: r.profile_id,
    codexTranscriptPath: r.codex_transcript_path, codexSessionId: r.codex_session_id,
    planning: b(r.planning), draftMayBeStranded: b(r.draft_may_be_stranded),
  };
}
