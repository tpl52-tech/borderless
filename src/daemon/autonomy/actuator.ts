/**
 * Autonomy actuator — the ONLY place the system acts unasked (design §13.1, §13.5).
 *
 * An ordered gate chain, an audit row for every attempt INCLUDING suppressions, NEVER throws.
 * The gate chain (checkGates) is pure over injected predicates/counts and is unit-tested; delivery is
 * the I/O tail.
 */

import type { PolicyResult } from "./policy.ts";
import type { AutonomyConfig } from "./config.ts";
import type { Store } from "../store.ts";
import type { NudgeDelivery } from "../nudge/index.ts";
import { runWithDeadline } from "../ssh.ts";
import { commentArgs, requestReviewerArgs } from "../github.ts";
import type { WorkItem, Session, AutonomyDecision } from "../../shared/types.ts";

export const GLOBAL_RATE_LIMIT_PER_HOUR = 12;
export const PER_ITEM_LIMIT_PER_HOUR = 2;
export const PER_SESSION_NUDGES_PER_HOUR = 3;
export const COOLDOWN_MS = 20 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

/** The three review sweeps — exempt from cooldown + per-item limits (their keys are review timestamps). */
export const SWEEPS = new Set<AutonomyDecision>(["review-bot-followups", "cto-review-followups", "cto-followups"]);
/** Actions delivered by TYPING into the agent (the nudge dependency). */
export const NUDGE_TRANSPORT = new Set<AutonomyDecision>([
  "nudge-agent", "thermo-regrade", "review-bot-followups", "cto-review-followups", "cto-followups",
]);
/** Actions delivered via GitHub. */
export const GITHUB_ACTIONS = new Set<AutonomyDecision>(["request-codex", "request-cto", "cto-review-delay-nudge"]);

export type GateOutcome =
  | { outcome: "deliver" }
  | { outcome: "dry-run" }
  | { outcome: "blocked"; gate: string };

export interface GateDeps {
  now: number;
  config: AutonomyConfig;
  store: Store;
  killed: boolean;
  withinWindowNow: boolean;
  ownsSession: boolean;
  queueFull: boolean;
  stillJustified: boolean;
}

/** Run the ordered gate chain for a decision (design §13.5). Pure over its injected inputs. */
export function checkGates(result: PolicyResult, session: Session, item: WorkItem, d: GateDeps): GateOutcome {
  const a = result.decision;
  const { store, now } = d;
  const blocked = (gate: string): GateOutcome => ({ outcome: "blocked", gate });

  if (!d.config.enabled || d.killed) return blocked("disabled");                    // 1
  if (!d.config.always && !d.withinWindowNow) return blocked("outside-window");     // 2
  if (!d.ownsSession) return blocked("not-my-host");                                // 3
  if (!d.config.actions.has(a)) return blocked("not-allowed");                      // 4
  if (d.config.sessions && !d.config.sessions.has(session.id)) return blocked("session-not-allowed"); // 5
  if (session.planning) return blocked("session-planning");                         // 6
  if (store.failedAttemptCount(result.dedupeKey) >= 2) return blocked("already-attempted"); // 7
  if (store.hasTerminalAction(result.dedupeKey)) return blocked("duplicate");        // 8
  if (!SWEEPS.has(a) && store.countActed(now - COOLDOWN_MS, { action: a, externalKey: item.externalKey }) > 0) {
    return blocked("cooldown");                                                      // 9
  }
  if (store.countActed(now - HOUR_MS) >= GLOBAL_RATE_LIMIT_PER_HOUR) return blocked("rate-global"); // 10
  if (!SWEEPS.has(a) && store.countActed(now - HOUR_MS, { externalKey: item.externalKey }) >= PER_ITEM_LIMIT_PER_HOUR) {
    return blocked("rate-item");                                                     // 11
  }
  if (NUDGE_TRANSPORT.has(a) && store.countActed(now - HOUR_MS, { sessionId: session.id }) >= PER_SESSION_NUDGES_PER_HOUR) {
    return blocked("rate-session-nudges");                                           // 12
  }
  if (NUDGE_TRANSPORT.has(a) && d.queueFull) return blocked("queue-full");           // 13
  if (!d.stillJustified) return blocked("freshness");                                // 14
  if (d.config.dryRun) return { outcome: "dry-run" };                               // 15
  return { outcome: "deliver" };
}

export interface Actuator {
  act(result: PolicyResult, ctx: ActCtx): Promise<void>;
}

export interface ActCtx {
  item: WorkItem;
  session: Session;
  repo?: string;
  ctoLogin?: string;
  ctoBotLogin?: string;
  ownsSession: boolean;
  killed: boolean;
  withinWindowNow: boolean;
  queueFull: boolean;
  stillJustified: boolean;
}

export interface ActuatorDeps {
  config: AutonomyConfig;
  store: Store;
  nudge: NudgeDelivery;
  now?: () => number;
}

interface Base { action: AutonomyDecision; dedupeKey: string; reason: string | null; workItemId: string; sessionId: string; }

export function createActuator(deps: ActuatorDeps): Actuator {
  const now = deps.now ?? Date.now;

  const deliverGithub = async (result: PolicyResult, ctx: ActCtx, base: Base): Promise<void> => {
    if (!ctx.repo || ctx.item.number == null) throw new Error("github action: missing repo/number");
    const n = ctx.item.number;
    let args: string[];
    if (result.decision === "request-codex") args = commentArgs(ctx.repo, n, "@codex review");
    else if (result.decision === "request-cto") {
      if (!ctx.ctoLogin) throw new Error("request-cto: ctoLogin not configured");
      args = requestReviewerArgs(ctx.repo, n, ctx.ctoLogin);
    } else if (result.decision === "cto-review-delay-nudge") {
      if (!ctx.ctoBotLogin) throw new Error("cto-review-delay-nudge: ctoBotLogin not configured");
      args = commentArgs(ctx.repo, n, `@${ctx.ctoBotLogin} re-flagging so it isn't lost to the sweep`);
    } else throw new Error(`unknown github action ${result.decision}`);
    const r = await runWithDeadline(["gh", ...args]);
    if (r.code !== 0) throw new Error(`gh failed (code ${r.code}): ${r.stderr}`);
    deps.store.recordAction({ ...base, status: "performed", payload: { headSha: ctx.item.headSha } });
  };

  return {
    async act(result, ctx) {
      // none / alert-human never reach the gate chain (alerts are the dispatcher's job, step 8).
      if (result.decision === "none" || result.decision === "alert-human") return;

      const gate = checkGates(result, ctx.session, ctx.item, {
        now: now(), config: deps.config, store: deps.store, killed: ctx.killed,
        withinWindowNow: ctx.withinWindowNow, ownsSession: ctx.ownsSession,
        queueFull: ctx.queueFull, stillJustified: ctx.stillJustified,
      });

      const base: Base = { action: result.decision, dedupeKey: result.dedupeKey, reason: result.reason,
        workItemId: ctx.item.id, sessionId: ctx.session.id };

      if (gate.outcome === "blocked") { deps.store.recordAction({ ...base, status: "suppressed", gate: gate.gate }); return; }
      if (gate.outcome === "dry-run") { deps.store.recordAction({ ...base, status: "dry-run" }); return; }

      try {
        if (NUDGE_TRANSPORT.has(result.decision)) {
          deps.nudge.enqueue({ sessionId: ctx.session.id, body: result.message ?? "", key: result.dedupeKey, settleKeys: [result.dedupeKey], manual: false });
          deps.store.recordAction({ ...base, status: "queued" });
        } else {
          await deliverGithub(result, ctx, base);
        }
      } catch (err) {
        deps.store.recordAction({ ...base, status: "failed", reason: `${result.reason} | ${err instanceof Error ? err.message : err}` });
      }
    },
  };
}
