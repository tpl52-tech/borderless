/**
 * Work-item monitor — PRs and tickets (design §12).
 *
 * Cadence (§12.1): tick every 15s; a session is "due" every 30s while working/needs-input/starting,
 * else every 5 min; a polling latch drops overlapping passes; skipped entirely with no repo.
 *
 * Linking (§12.2): observe each due session's branch from git -> list its PRs -> fetch + derive each ->
 * upsert -> retire covered/merged/closed items -> emit workitems.changed.
 *
 * The GitHub I/O (github.ts) is exercised only against a real repo; the pure decisions here
 * (retirementDecision, transition events) are unit-tested.
 */

import type { Store } from "../store.ts";
import type { SessionManager } from "../session-manager.ts";
import type { OperatorConfigLite } from "../../shared/config.ts";
import { selectProfile, profileIdFromRepo, DEFAULT_REVIEW_POLICY, type Profile } from "../../shared/profile.ts";
import { currentBranch } from "../worktree.ts";
import { listPrsForBranch, fetchPr, type BranchPr } from "../github.ts";
import { deriveStates, type DeriveConfig } from "../pr-derive.ts";
import type { WorkItem, WorkItemLifecycle } from "../../shared/types.ts";

export const WORKITEM_TICK_MS = 15_000;
export const DUE_ACTIVE_MS = 30_000;
export const DUE_IDLE_MS = 5 * 60_000;
export const RETIRE_GRACE_MS = 10 * 60_000;

/**
 * The next lifecycle for an item, or null to leave it (design §12.2 retirement): MERGED -> retiring
 * (any source); CLOSED -> retiring only for auto items; after a 10-min grace -> retired.
 */
export function retirementDecision(item: WorkItem, now: number, graceMs = RETIRE_GRACE_MS): WorkItemLifecycle | null {
  if (item.lifecycle === "active") {
    if (item.prState === "MERGED") return "retiring";
    if (item.prState === "CLOSED" && item.source === "auto") return "retiring";
    return null;
  }
  if (item.lifecycle === "retiring") {
    if (item.retiredAt != null && now - item.retiredAt >= graceMs) return "retired";
    return null;
  }
  return null;
}

/** Parse a manual work-item reference: a PR URL, `#N`, or a bare number (design §12.2). */
export function parsePrRef(ref: string): number | null {
  const s = ref.trim();
  const url = /\/pull\/(\d{1,7})\b/.exec(s);
  if (url) return Number(url[1]);
  const hash = /^#?(\d{1,7})$/.exec(s);
  if (hash) return Number(hash[1]);
  return null;
}

export interface WorkItemMonitor {
  stop(): void;
  /** Poll a single session now (used by workitem.refresh). */
  pollSession(sessionId: string): Promise<void>;
  /** Manually attach a PR to a session (design §12.2 manual attach). */
  addManual(sessionId: string, ref: string): Promise<void>;
}

export interface WorkItemMonitorDeps {
  store: Store;
  manager: SessionManager;
  config: OperatorConfigLite;
  emit: () => void; // fire workitems.changed
  isBusy: () => boolean; // a client is attached -> skip the PR half (§12.1)
}

export function startWorkItemMonitor(deps: WorkItemMonitorDeps): WorkItemMonitor {
  const { store, manager, config, emit } = deps;
  const lastPolled = new Map<string, number>();
  let running = false;
  let stopped = false;

  const profileFor = (profileId: string): Profile => {
    const p = selectProfile(config.profiles, { explicitId: profileId });
    if (p) return p;
    const repo = config.repo ?? "";
    return {
      id: repo ? profileIdFromRepo(repo) : "legacy", repo, defaultBranch: "main",
      ticketProvider: "linear", ctoLogin: config.ctoLogin, ctoBotLogin: config.ctoBotLogin,
      linearTeamKeys: config.linearTeamKeys, reviewPolicy: { ...DEFAULT_REVIEW_POLICY },
    };
  };

  const deriveConfigFor = (profile: Profile): DeriveConfig => ({
    ctoLogins: profile.ctoLogins ?? (profile.ctoLogin ? [profile.ctoLogin] : []),
    codexBotLogin: "codex", // §22 parametrize
    reviewBotLogin: "github-actions",
    greenlightSubstring: "greenlight",
    ciIgnore: [],
    operatorLogin: config.operatorLogin,
  });

  const pollSession = async (sessionId: string): Promise<void> => {
    const session = store.getSession(sessionId);
    if (!session || session.closed) return;
    const profile = profileFor(session.profileId);
    const repo = profile.repo || config.repo;
    if (!repo) return; // no repo -> no PR monitoring

    const derive = deriveConfigFor(profile);
    let changed = false;
    const fetched = new Set<number>(); // avoid double-fetching a PR seen via both branch + tracked

    const fetchInto = async (number: number): Promise<void> => {
      if (fetched.has(number)) return;
      fetched.add(number);
      try {
        const d = deriveStates(await fetchPr(repo, number), derive);
        store.upsertWorkItem({ sessionId, kind: "pr", externalKey: `${repo}#${number}`, repo, number, ...d });
        changed = true;
      } catch { /* keep last-known state on a lookup failure (§12.3) */ }
    };

    // (1) Observe the branch and link its PRs (local only in M5; devbox branch-over-ssh is a follow-up).
    let branch = session.worktreeBranch;
    if (session.location === "local") branch = currentBranch(session.cwd) ?? branch;
    if (branch) {
      let prs: BranchPr[] = [];
      try { prs = await listPrsForBranch(repo, branch); } catch { prs = []; } // failure != "no PRs" for tracked items
      for (const pr of prs) await fetchInto(pr.number);
    }

    // (5) Refresh every other tracked PR by number (design §12.2) — this is how a manually-attached PR,
    // or an auto-linked one whose branch is unchanged, keeps its derived state fresh.
    for (const item of store.listWorkItemsBySession(sessionId)) {
      if (item.kind === "pr" && item.number != null) await fetchInto(item.number);
    }

    // Retire merged/closed items after the grace (re-read for the fresh pr_state).
    const now = Date.now();
    for (const item of store.listWorkItemsBySession(sessionId)) {
      const next = retirementDecision(item, now);
      if (next && next !== item.lifecycle) {
        store.setWorkItemLifecycle(item.id, next, next === "retiring" ? now : item.retiredAt);
        changed = true;
      }
    }
    if (changed) emit();
  };

  const dueInterval = (sessionId: string): number => {
    const status = manager.status(sessionId);
    return status === "working" || status === "needs-input" || status === "starting" ? DUE_ACTIVE_MS : DUE_IDLE_MS;
  };

  const tick = async (): Promise<void> => {
    if (running || stopped) return; // polling latch (§12.1)
    if (deps.isBusy()) return; // skip the PR half while a client is attached
    running = true;
    try {
      const now = Date.now();
      for (const session of store.listSessions({ includeClosed: false })) {
        const last = lastPolled.get(session.id) ?? 0;
        if (now - last < dueInterval(session.id)) continue;
        lastPolled.set(session.id, now);
        await pollSession(session.id).catch(() => {});
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), WORKITEM_TICK_MS);

  const addManual = async (sessionId: string, ref: string): Promise<void> => {
    const session = store.getSession(sessionId);
    if (!session) throw new Error(`workitem.add: unknown session ${sessionId}`);
    const profile = profileFor(session.profileId);
    const repo = profile.repo || config.repo;
    if (!repo) throw new Error("workitem.add: no repo configured for this session");
    const number = parsePrRef(ref);
    if (number == null) throw new Error(`workitem.add: could not parse a PR reference from '${ref}'`);
    // Manual source so polls can't auto-retire it (design §12.2).
    store.upsertWorkItem({ sessionId, kind: "pr", externalKey: `${repo}#${number}`, repo, number, source: "manual" });
    await pollSession(sessionId);
    emit();
  };

  return {
    stop() { stopped = true; clearInterval(timer); },
    pollSession,
    addManual,
  };
}
