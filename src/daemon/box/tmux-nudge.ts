/**
 * Box tmux nudge transport (design §10.5, §17).
 *
 * On the box, nudges go to tmux DIRECTLY (no ssh hop, no mirror PTY): `send-keys -l --` for text via
 * argv (never a shell string), Enter as its OWN invocation (120ms settle; tmux's assume-paste-time is
 * 1ms), Escape to clear, `capture-pane -p -e` to read (keeps SGR). Shares the pure pane guards + dispatch
 * order in src/daemon/nudge. On a FAILED pane capture the box PROCEEDS (the Mac holds) — §10.5 asymmetry.
 *
 * `deliverTmux` takes an injected command runner so the dispatch is unit-tested; the live loop is a box-
 * only skeleton.
 */

import {
  tmuxSendLiteralArgv, tmuxSendEnterArgv, tmuxSendEscapeArgv, tmuxCapturePaneArgv,
} from "../../shared/remote.ts";
import { normalizeBody, BODY_SETTLE_MS_TMUX } from "../nudge/framing.ts";
import { analyzePane, isStranded } from "../nudge/pane-guards.ts";
import { dispatchDecision, onFailedCapture, type NudgeDecision } from "../nudge/dispatch.ts";
import type { Tool } from "../../shared/types.ts";

export type TmuxRunner = (argv: string[]) => Promise<{ code: number; stdout: string }>;
export type TmuxDeliverResult = "typed" | "entered" | "held" | "dropped";

export interface DeliverTmuxOptions {
  tmuxSession: string;
  body: string;
  tool: Tool;
  run: TmuxRunner;
  settleMs?: number;
  cancelled?: () => boolean;
}

/** Deliver a nudge into a tmux pane with the pane guards + dispatch order (design §10.5). */
export async function deliverTmux(opts: DeliverTmuxOptions): Promise<TmuxDeliverResult> {
  const cap = await opts.run(tmuxCapturePaneArgv(opts.tmuxSession));

  let decision: NudgeDecision;
  if (cap.code !== 0) {
    decision = onFailedCapture("box"); // box proceeds on a failed capture
  } else {
    decision = dispatchDecision(analyzePane(cap.stdout), isStranded(cap.stdout, opts.body));
  }

  switch (decision) {
    case "drop-menu":
      return "dropped";
    case "hold":
      return "held";
    case "press-enter-only":
      await opts.run(tmuxSendEnterArgv(opts.tmuxSession));
      return "entered";
    case "type": {
      await opts.run(tmuxSendLiteralArgv(opts.tmuxSession, normalizeBody(opts.body, opts.tool)));
      await Bun.sleep(opts.settleMs ?? BODY_SETTLE_MS_TMUX);
      if (opts.cancelled?.()) { await opts.run(tmuxSendEscapeArgv(opts.tmuxSession)); return "held"; }
      await opts.run(tmuxSendEnterArgv(opts.tmuxSession));
      return "typed";
    }
  }
}

export function createTmuxNudge(): { stop(): void } {
  throw new Error("box.tmux-nudge.createTmuxNudge: live-only (design §17) — use deliverTmux (testable)");
}
