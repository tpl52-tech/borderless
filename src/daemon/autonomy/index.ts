/**
 * Autonomy — the policy engine + actuator control loop (design §13).
 *
 * Two layers with one guarantee: policy decides (pure, §13.4), the actuator acts (gated, audited, never
 * throws, §13.5). This module runs them over every active work item on a tick, computing the transition
 * clocks and handover stamps the policy needs, and reading the acting window + kill switch LIVE.
 *
 * MILESTONE 7 scope: the full gate chain + audit log + window/kill-switch/extension + dry-run + the rule
 * table. Agent ACTIVITY is derived from the status tracker (working->busy, needs-input->waiting,
 * done/exited->idle); the richer introspection probe (§10.4, fidelity authoritative, endedWithQuestion)
 * is a later gap, so rule 5 (blocked-question) stays dormant until it lands.
 */

import { existsSync, readFileSync } from "node:fs";
import { decide, type PolicyInputs, type FieldChanges, type AgentActivity } from "./policy.ts";
import { createActuator, type Actuator } from "./actuator.ts";
import { dedupeKey } from "./keys.ts";
import { type AutonomyConfig } from "./config.ts";
import type { Store } from "../store.ts";
import type { StatusTracker } from "../monitors/status.ts";
import type { NudgeDelivery } from "../nudge/index.ts";
import { paths } from "../../shared/paths.ts";
import { BUILTIN_DEFAULTS, type OperatorConfigLite } from "../../shared/config.ts";
import { actingAllowed, parseExtensionDeadline, type WindowConfig } from "../../shared/autonomy-window.ts";
import { selectProfile, DEFAULT_REVIEW_POLICY, type ReviewPolicy } from "../../shared/profile.ts";
import { badStanding } from "../../shared/focus.ts";
import type { WorkItem, SessionStatus, AutonomyDecision, AlertKind } from "../../shared/types.ts";

/** Derive the alert kind from an alert-human dedupe-key prefix (design §15.1). */
function alertKind(dedupeKey: string): AlertKind {
  const prefix = dedupeKey.split(":")[0];
  if (prefix === "agent-dead" || prefix === "stalled" || prefix === "needs-input" || prefix === "ready-to-merge") {
    return prefix;
  }
  return "ci-failed";
}

export * from "./config.ts";
export * from "./policy.ts";
export * from "./actuator.ts";
export * from "./keys.ts";

export const AUTONOMY_TICK_MS = 30_000;

export interface AutonomyEngine {
  stop(): void;
  tickNow(): Promise<void>;
}

export interface AutonomyDeps {
  store: Store;
  tracker: StatusTracker;
  nudge: NudgeDelivery;
  config: AutonomyConfig;
  operatorConfig: OperatorConfigLite;
  home: string;
  emit: () => void; // autonomy.acted
  now?: () => number;
}

interface PrevState { ci: string | null; cto: string | null; unresolved: number; mergeable: string | null; ctoReviewedAt: number | null; badStateSince: number | null; }

export function startAutonomy(deps: AutonomyDeps): AutonomyEngine {
  const now = deps.now ?? Date.now;
  const actuator = createActuator({ config: deps.config, store: deps.store, nudge: deps.nudge, now });
  const prev = new Map<string, PrevState>();
  const p = paths(deps.home);
  const windowCfg: WindowConfig = {
    timeZone: BUILTIN_DEFAULTS.autonomyTimeZone,
    startHour: BUILTIN_DEFAULTS.autonomyStartHour,
    endHour: BUILTIN_DEFAULTS.autonomyEndHour,
  };

  const killed = (): boolean => !deps.config.enabled || existsSync(p.autonomyOff);
  const extension = (): number | null => {
    try { return existsSync(p.autonomyUntil) ? parseExtensionDeadline(readFileSync(p.autonomyUntil, "utf8"), now()) : null; }
    catch { return null; }
  };

  const activityFor = (sessionId: string, tool: string): AgentActivity => {
    const status: SessionStatus = deps.tracker.status(sessionId);
    const state = status === "working" || status === "starting" || status === "stuck" ? "busy"
      : status === "needs-input" ? "waiting"
      : status === "done" || status === "exited" ? "idle" : "unknown";
    return {
      fidelity: tool === "claude" ? "inferred" : "none", // authoritative needs the introspection probe (§10.4)
      state,
      endedWithQuestion: false,
      statusSince: now(),
      handlingThisPr: state === "busy", // simplified §13.3 predicate
    };
  };

  const reviewPolicyFor = (profileId: string): ReviewPolicy =>
    selectProfile(deps.operatorConfig.profiles, { explicitId: profileId })?.reviewPolicy ?? DEFAULT_REVIEW_POLICY;

  const isBad = (item: WorkItem): boolean =>
    (item.ciState === "failure" && item.failedChecks.length > 0) ||
    item.ctoState === "changes-requested" || item.ctoState === "commented-after-approval" ||
    item.mergeable === "CONFLICTING" || item.unresolvedComments > 0;

  const changesFor = (item: WorkItem, before: PrevState | undefined): FieldChanges => ({
    ciToFailure: item.ciState === "failure" && before?.ci !== "failure",
    ctoToChanges: item.ctoState === "changes-requested" && before?.cto !== "changes-requested",
    ctoToCommentedAfterApproval: item.ctoState === "commented-after-approval" && before?.cto !== "commented-after-approval",
    newCtoReviewTimestamp: item.ctoReviewedAt != null && item.ctoReviewedAt !== (before?.ctoReviewedAt ?? null) &&
      (item.ctoState === "reviewed" || item.ctoState === "changes-requested"),
    unresolvedRising: item.unresolvedComments > (before?.unresolved ?? 0),
    mergeableToConflicting: item.mergeable === "CONFLICTING" && before?.mergeable !== "CONFLICTING",
  });

  const handedOver = (action: AutonomyDecision, item: WorkItem): boolean => {
    const a = deps.store.getAction(dedupeKey(action, item));
    return !!a && (a.status === "performed" || a.status === "queued");
  };
  const attemptedRecently = (item: WorkItem) => (action: AutonomyDecision): boolean =>
    deps.store.countActed(now() - 20 * 60_000, { action, externalKey: item.externalKey }) > 0;

  const runItem = async (item: WorkItem): Promise<void> => {
    const session = deps.store.getSession(item.sessionId);
    if (!session || session.closed) return;

    const before = prev.get(item.externalKey);
    const bad = isBad(item);
    const badStateSince = bad ? (before?.badStateSince ?? now()) : null;
    prev.set(item.externalKey, {
      ci: item.ciState, cto: item.ctoState, unresolved: item.unresolvedComments,
      mergeable: item.mergeable, ctoReviewedAt: item.ctoReviewedAt, badStateSince,
    });

    const inputs: PolicyInputs = {
      now: now(), item, session, reviewPolicy: reviewPolicyFor(session.profileId),
      activity: activityFor(session.id, session.tool),
      changes: changesFor(item, before),
      handover: {
        reviewBotHandedOver: handedOver("review-bot-followups", item),
        ctoReviewHandedOver: handedOver("cto-review-followups", item),
        ctoFollowupSwept: handedOver("cto-followups", item),
        attemptedRecently: attemptedRecently(item),
      },
      ctoLogin: deps.operatorConfig.ctoLogin,
      ctoReviewDelayNudgeMinutes: BUILTIN_DEFAULTS.ctoReviewDelayNudgeMinutes,
      badStateSince,
    };

    const result = decide(inputs);
    if (result.decision === "alert-human") {
      // Detection is deterministic; record the alert (the dispatcher narrates it, §15.1).
      deps.store.recordAlert({
        kind: alertKind(result.dedupeKey), dedupeKey: result.dedupeKey, summary: result.reason,
        sessionId: session.id, workItemId: item.id,
      });
      deps.emit();
      return;
    }
    if (result.decision === "none") return;

    const repo = selectProfile(deps.operatorConfig.profiles, { explicitId: session.profileId })?.repo
      ?? deps.operatorConfig.repo ?? item.repo ?? undefined;
    await actuator.act(result, {
      item, session, repo: repo ?? undefined,
      ctoLogin: deps.operatorConfig.ctoLogin, ctoBotLogin: deps.operatorConfig.ctoBotLogin,
      ownsSession: !deps.config.locations || deps.config.locations.has(session.location),
      killed: killed(),
      withinWindowNow: actingAllowed(now(), windowCfg, extension()),
      queueFull: false, // the nudge queue's own rejected-full also guards this (M7)
      stillJustified: result.decision === "nudge-agent" ? badStanding(item) : true,
    });
    deps.emit();
  };

  const tickNow = async (): Promise<void> => {
    for (const item of deps.store.listActiveWorkItems()) {
      await runItem(item).catch(() => {}); // never throw out of the loop (§13.1)
    }
  };

  const timer = setInterval(() => void tickNow(), AUTONOMY_TICK_MS);
  return { stop() { clearInterval(timer); }, tickNow };
}
