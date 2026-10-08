/**
 * Rescue scan — the overdue → Rescues queue → authorize front half of the rescue sweep (PRD §5, §12).
 *
 * The eligibility decision is pure (shared/rescue.ts). Here `scanRescues` filters the synced linear_issues
 * through it — checking the cheap non-progress conditions first so the live progress check runs only for
 * otherwise-eligible tickets — and `authorizeRescue` turns a lead's per-ticket go-ahead into a rescue
 * sweep_job. Nothing auto-starts: a rescue needs explicit per-ticket authorization (PRD §5/§12). The live
 * progress check is live-only; the scan/authorize orchestration is tested with injected deps.
 */

import type { Store } from "./store.ts";
import type { LinearIssue, SweepJob } from "../shared/types.ts";
import { rescueEligibility, daysOverdue } from "../shared/rescue.ts";
import { listPrsForBranch, splitRepo } from "./github.ts";
import { prBranchCandidates } from "./worktree.ts";
import { runWithDeadline } from "./ssh.ts";

export interface RescueCandidate {
  issue: LinearIssue;
  daysOverdue: number;
}

export interface RescueScanDeps {
  now: number;
  /** Live: does the ticket already have meaningful progress (a branch or a non-draft PR)? */
  checkProgress(issue: LinearIssue): Promise<boolean>;
  /** Does the issue's assignee resolve to a roster member? */
  isRosterMember(linearId: string | null): boolean;
  /** Lead-desk project to exclude (PRD §9); defaults to "Lead Ops" when unset. */
  leadOpsProject?: string;
}

/**
 * The Rescues queue: every synced issue eligible for rescue (PRD §5), most-overdue first. The cheap
 * non-progress conditions gate first, so the live progress check only runs for otherwise-eligible tickets.
 */
export async function scanRescues(store: Store, deps: RescueScanDeps): Promise<RescueCandidate[]> {
  const candidates: RescueCandidate[] = [];
  for (const issue of store.listLinearIssues()) {
    const prelim = rescueEligibility(issue, { now: deps.now, hasProgress: false, isRosterMember: deps.isRosterMember(issue.assignee), leadOpsProject: deps.leadOpsProject });
    if (!prelim.eligible) continue; // ineligible for a non-progress reason — skip the gh call
    if (await deps.checkProgress(issue)) continue; // someone already started it
    candidates.push({ issue, daysOverdue: daysOverdue(issue.dueDate!, deps.now) });
  }
  candidates.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return candidates;
}

export interface AuthorizeResult {
  job: SweepJob;
  created: boolean; // false if an active rescue already existed for the ticket
}

/**
 * Authorize a rescue for one ticket (the lead's per-ticket go-ahead, PRD §5) → a rescue sweep_job. Accepts
 * a ticket id or its identifier (e.g. COR-42). The late assignee is kept on the job for context; the work
 * is attributed to the lead via the agent + the post-merge comment (PRD §5/§6). Idempotent: an existing
 * active rescue for the ticket is returned rather than duplicated.
 */
export function authorizeRescue(store: Store, ticket: string): AuthorizeResult {
  const issue = store.getLinearIssue(ticket) ?? store.getLinearIssueByIdentifier(ticket);
  if (!issue) throw new Error(`rescue: unknown ticket ${ticket}`);
  const active = store.listSweepJobs({ kind: "rescue" }).find(
    (j) => j.ticketId === issue.id && j.state !== "merged" && j.state !== "failed",
  );
  if (active) return { job: active, created: false };
  const job = store.createSweepJob({ kind: "rescue", ticketId: issue.id, ticketKey: issue.identifier, assignee: issue.assignee });
  return { job, created: true };
}

/**
 * Live progress check (PRD §5 "no branch, no commits, no non-draft PR"): a ticket counts as started if any
 * of its candidate branches (Linear's suggested branch, then the canonical one) has a non-draft PR or
 * exists on the remote. Live-only.
 */
export function liveProgressCheck(repo: string, branchOwner: string): (issue: LinearIssue) => Promise<boolean> {
  const { owner, name } = splitRepo(repo);
  return async (issue) => {
    for (const branch of prBranchCandidates(issue.identifier, branchOwner, issue.gitBranchName)) {
      if ((await listPrsForBranch(repo, branch)).some((pr) => !pr.isDraft)) return true;
      const r = await runWithDeadline(["gh", "api", `repos/${owner}/${name}/branches/${branch}`, "--silent"]);
      if (r.code === 0) return true; // the branch exists on the remote
    }
    return false;
  };
}
