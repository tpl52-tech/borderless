/**
 * Sweep job + event persistence (lead-console PRD §4-§5) — the CRUD the sweep engine, supervisor, and scans
 * run on. Split out of store.ts (which had grown past 1k lines) into a focused base class: `Store extends
 * SweepJobStore`, so every caller keeps using `store.createSweepJob(...)` unchanged while the sweep-job schema
 * accessors live in one cohesive place. The owning Store builds the Database, migrates it, and hands it up via
 * super(db); everything here reads/writes only that one handle.
 */

import type { Database } from "bun:sqlite";
import type { SweepJob, SweepEvent, SweepKind, SweepState, SweepEventKind } from "../shared/types.ts";

/** A raw sqlite row (snake_case columns); mapped to a domain type by the rowToX helpers. */
type Row = Record<string, any>;

export class SweepJobStore {
  constructor(public readonly db: Database) {}

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
