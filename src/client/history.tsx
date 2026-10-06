/**
 * History view (`h` / `ao history`) (design §11 history view).
 *
 * Runs on the NORMAL screen with Ink suspended (terminal owns scrollback, so scroll wheel/Cmd-F/
 * selection work); chat layout (speaker rules, 96-column prose measure, tool calls one line, results
 * previewed 3 lines); follow loop every 1.5s with a working indicator; a minimal composer that sends
 * via the same nudge path (queues when mid-turn), with `\`+Enter newline, history recall, Ctrl-B
 * prefixed commands (q queue view, t task list, i interrupt, Ctrl-B Ctrl-B exit, Ctrl-G snake).
 */

export function History(): unknown {
  throw new Error("client.History: not implemented (design §11)");
}
