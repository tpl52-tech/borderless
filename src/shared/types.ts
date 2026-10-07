/**
 * Domain types — the vocabulary of the whole system (design §2, §6).
 *
 * Two levels: a Task is a workstream; a Session is one agent CLI process working on it.
 * Everything else (WorkItem, Alert, AutonomyAction, usage) hangs off those two.
 *
 * All timestamps are epoch milliseconds. All money is integer micros.
 */

export type EpochMs = number;
export type Micros = number;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** The four agent-CLI kinds a session can run. */
export type Tool = "claude" | "codex" | "copilot" | "openrouter";

/** Where a session runs. `devbox` = a Linux box reached over ssh + tmux. */
export type Location = "local" | "devbox";

/** Permission level handed to the agent CLI. */
export type Permissions = "ask" | "auto-edits" | "full-access";

/** Reasoning effort. Not every tool supports every value. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The seven-state runtime session status (design §10.1). Runtime-only; never stored.
 * A stored session reads `exited` until proven live.
 */
export type SessionStatus =
  | "starting"
  | "working"
  | "done"
  | "needs-input"
  | "stuck"
  | "exited"
  | "error";

export type TaskStatus = "open" | "closed";

export type TicketProvider = "linear" | "github";

// ---------------------------------------------------------------------------
// Task & Session
// ---------------------------------------------------------------------------

/** A workstream. Human-assigned order in a queue (design §6 `tasks`). */
export interface Task {
  id: string; // UUID
  name: string;
  description: string;
  status: TaskStatus;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  /** max+1 on create; the list orders by (status ASC, orderIdx ASC) — the human order. */
  orderIdx: number;
}

/**
 * One agent CLI process working on a task (design §6 `sessions`).
 * `cwd` is load-bearing: resume is cwd-scoped for every CLI.
 */
export interface Session {
  id: string;
  taskId: string;
  title: string;
  tool: Tool;
  location: Location;
  cwd: string;
  usesWorktree: boolean;
  worktreePath: string | null;
  model: string;
  permissions: Permissions;
  effort: Effort | null;
  /** claude = a forced UUID; copilot = a name; openrouter = a session id; codex = always null. */
  resumeHandle: string | null;
  /** `flotilla-<first 8 chars of id>` historically; `ao-<id8>` here. */
  tmuxSession: string | null;
  closed: boolean;
  createdAt: EpochMs;
  /** COALESCE on re-close so a redundant close can't push the reaper deadline. */
  closedAt: EpochMs | null;
  /** persisted at provision, later overwritten with the observed branch. */
  worktreeBranch: string | null;
  profileId: string; // default "legacy"
  codexTranscriptPath: string | null;
  codexSessionId: string | null;
  /** operator hand-drives; excluded from autonomy. */
  planning: boolean;
  draftMayBeStranded: boolean;

  // Runtime-only (never stored):
  status?: SessionStatus;
  lastActivityAt?: EpochMs;
  statusSince?: EpochMs;
  stuckConfident?: boolean;
  activity?: string | null;
}

// ---------------------------------------------------------------------------
// Work items (PRs & tickets)
// ---------------------------------------------------------------------------

export type WorkItemKind = "pr" | "ticket";
export type WorkItemLifecycle = "active" | "retiring" | "retired";
export type WorkItemSource = "auto" | "manual" | "transfer";

export type CiState = "success" | "pending" | "failure";
export type GreenlightState = "absent" | "converged" | "failing";
export type CodexReviewState = "none" | "requested" | "approved" | "reviewed";
export type ReviewBotState = "none" | "reviewed" | "approved";
export type ThermoGrade = "A" | "B" | "C" | "D" | "F";
export type CtoState =
  | "none"
  | "requested"
  | "approved"
  | "stale-approval"
  | "changes-requested"
  | "commented-after-approval"
  | "reviewed";

/**
 * A PR or ticket a session carries (design §6 `work_items`).
 * UNIQUE(sessionId, externalKey): the same PR gets one row per session that touched it.
 */
export interface WorkItem {
  id: string;
  sessionId: string;
  kind: WorkItemKind;
  /** `owner/repo#123` or `HOS-1989`. */
  externalKey: string;
  repo: string | null;
  number: number | null;
  url: string | null;
  title: string | null;
  branch: string | null;
  lifecycle: WorkItemLifecycle;

  prState: string | null;
  isDraft: boolean;
  ciState: CiState | null;
  failedChecks: string[]; // JSON; only non-ignored failures
  reviewState: string | null;
  mergeable: string | null; // GitHub's MERGEABLE | CONFLICTING | UNKNOWN

  headSha: string | null;
  headCommittedAt: EpochMs | null;
  /** first time WE saw this head — anchors the delayed CTO nudge. */
  headObservedAt: EpochMs | null;

  codexState: CodexReviewState | null;
  codexReviewedSha: string | null;
  ctoState: CtoState | null;
  ctoReviewedAt: EpochMs | null;
  ctoReviewedSha: string | null;
  reviewBotState: ReviewBotState | null;
  reviewBotAt: EpochMs | null;

  /** nullable; null = never graded = blocker. */
  thermoGrade: ThermoGrade | null;
  thermoCycles: number;
  greenlightState: GreenlightState;
  unresolvedComments: number;
  operatorAckedAt: EpochMs | null;
  outstandingReviewerTags: string[];
  tickets: string[]; // JSON

  source: WorkItemSource;
  createdAt: EpochMs;
  updatedAt: EpochMs; // poll timestamp — rewritten every poll
  remoteUpdatedAt: EpochMs | null; // GitHub's own clock
  retiredAt: EpochMs | null;
  lastPolledAt: EpochMs | null;
}

/** Append-only field transition (design §6 `work_item_events`). */
export interface WorkItemEvent {
  workItemId: string;
  at: EpochMs;
  field: string;
  from: string | null;
  to: string | null;
}

// ---------------------------------------------------------------------------
// Alerts & autonomy audit
// ---------------------------------------------------------------------------

export type AlertKind =
  | "needs-input"
  | "agent-dead"
  | "ci-failed"
  | "ready-to-merge"
  | "stalled"
  | "autonomy-blocked";

export type AlertSeverity = "info" | "attention";

/** A deterministic "a human should see this" record (design §6 `alerts`, §15.1). */
export interface Alert {
  id: string;
  sessionId: string | null;
  workItemId: string | null;
  kind: AlertKind;
  severity: AlertSeverity;
  /** UNIQUE — must encode the transition, not just the subject. */
  dedupeKey: string;
  summary: string;
  payloadJson: string;
  attempts: number; // max 5
  createdAt: EpochMs;
  notifiedAt: EpochMs | null;
  deliveredAt: EpochMs | null;
  suppressedAt: EpochMs | null;
}

/** One decision the policy engine can emit (design §13.1). Exactly one per item per tick. */
export type AutonomyDecision =
  | "none"
  | "nudge-agent"
  | "request-codex"
  | "request-cto"
  | "cto-review-delay-nudge"
  | "cto-followups"
  | "thermo-regrade"
  | "review-bot-followups"
  | "cto-review-followups"
  | "alert-human";

/**
 * Audit statuses (design §13.5). Rows supersede
 * dry-run/failed/undelivered/suppressed; never performed/queued/cancelled.
 */
export type AutonomyStatus =
  | "performed"
  | "queued"
  | "dry-run"
  | "suppressed"
  | "failed"
  | "undelivered"
  | "cancelled";

/** Audit log + rate-limit ledger + dedupe gate (design §6 `autonomy_actions`, §13.5). */
export interface AutonomyAction {
  id: string;
  workItemId: string | null;
  sessionId: string | null;
  action: AutonomyDecision;
  /** UNIQUE — encodes the event's identity (review timestamp, head sha, state tuple), never the row. */
  dedupeKey: string;
  status: AutonomyStatus;
  gate: string | null; // which gate blocked it, if any
  reason: string | null;
  payloadJson: string;
  createdAt: EpochMs;
  attempts: number;
}


// --- AO Lead Console sweeps (lead-console PRD §4-§5) ---

export type SweepKind = "in_review" | "rescue";

export type SweepState =
  | "queued" | "implementing" | "fixing" | "reviewing" | "ci"
  | "ready" | "needs_human" | "merged" | "failed";

/** A sweep attempt on one ticket: in-review (drive a PR) or rescue (build from scratch). */
export interface SweepJob {
  id: string;
  kind: SweepKind;
  ticketId: string;        // Linear issue id
  ticketKey: string;       // e.g. COR-42
  assignee: string | null;
  prNumber: number | null;
  headSha: string | null;  // in_review: PR head; rescue: null until a PR opens
  sessionId: string | null; // the agent session driving this job; null while queued, set on spawn
  state: SweepState;
  cycles: number;          // fix/implement -> review loop; cap 8
  gate: unknown | null;    // { ac, ci, findings, grade }
  reason: string | null;   // why needs_human / failed
  createdAt: number;
  updatedAt: number;
}

export type SweepEventKind =
  | "state_change" | "spawn" | "gate_eval" | "pr_open"
  | "merge" | "comment" | "slack" | "error";

/** Append-only audit entry for a sweep job. */
export interface SweepEvent {
  id: number;
  jobId: string;
  at: number;
  event: SweepEventKind;
  detail: unknown | null;
}

/** The Linear label that keeps a ticket off the automation — excluded from BOTH sweeps (PRD §2, §5). */
export const LEAD_LEVEL = "lead-level";

/** A Linear issue synced into the orchestrator (feeds the in-review sweep). */
export interface LinearIssue {
  id: string;
  identifier: string;        // e.g. COR-42
  title: string;
  stateName: string | null;  // e.g. "In Review"
  stateType: string | null;  // e.g. "started"
  assignee: string | null;   // Linear user id
  projectId: string | null;
  teamKey: string | null;
  url: string | null;
  priority: number | null;
  blockedBy: string[];       // issue ids this one is blocked by
  dueDate: number | null;    // epoch ms; feeds the rescue overdue check (PRD §5)
  labels: string[];          // label names; `lead-level` excludes a ticket from rescue
  updatedAt: number | null;
}
