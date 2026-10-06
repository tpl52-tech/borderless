/**
 * Remote command builders (design §9.1, §9.2, §9.4). PURE and unit-tested — the ssh/tmux execution
 * lives in src/daemon/ssh.ts and the session manager.
 *
 * Local PTY runs:
 *   ssh -tt -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 <dest> "<remote cmd>"
 *
 * Remote command: export TERM/LANG/LC_ALL, prepend $HOME/.local/bin:$HOME/.bun/bin to PATH (BatchMode
 * shells source no rc files); cd '<cwd>'; exec tmux -u new-session -A -D -s 'ao-<id8>' '<agent cmd>'
 * followed by session options. The agent is wrapped `env -u TMUX TERM=xterm-256color ...` so it does
 * not detect tmux and downgrade its render. Everything is POSIX single-quoted.
 */

/** ssh options for the long-lived mirror PTY (design §9.1). */
export const SSH_SPAWN_OPTS = [
  "-tt", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
];

/** ssh options for one-shot commands (design §9.4). */
export const SSH_ONESHOT_OPTS = [
  "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3",
];

export const REMOTE_STATE_DIR = "~/.agent-orchestrator-remote"; // literal ~ expanded by the remote sh
export const REMOTE_HOOK_PATH = "$HOME/.agent-orchestrator-remote/hook-notify.sh";

/** POSIX single-quote a token (design §9.1: "everything is POSIX single-quoted"). */
export function shellQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** The ssh user from a destination (`user@host` -> user; bare host -> default `ubuntu`, §7.2). */
export function sshUserFromDest(dest: string): string {
  const at = dest.indexOf("@");
  return at > 0 ? dest.slice(0, at) : "ubuntu";
}

/** Remote home from the ssh user: /root for root, else /home/<user> (design §7.2). */
export function remoteHome(sshUser: string): string {
  return sshUser === "root" ? "/root" : `/home/${sshUser}`;
}

export interface RemoteSpawnArgs {
  dest: string;
  cwd: string;
  tmuxSession: string; // ao-<id8>
  agentCmd: string[]; // the CLI argv to run inside tmux
}

/** The agent command wrapped so tmux isn't detected (design §9.1). */
export function wrapAgentCommand(agentCmd: string[]): string {
  const inner = ["env", "-u", "TMUX", "TERM=xterm-256color", ...agentCmd].map(shellQuote).join(" ");
  return inner;
}

const TMUX_OPTIONS: Array<[string, string]> = [
  ["status", "off"],
  ["allow-passthrough", "on"],
  ["window-size", "latest"], // fixes reattach wrap corruption
  ["history-limit", "100000"],
  ["aggressive-resize", "off"],
  ["automatic-rename", "off"],
];

/** Build the remote command string (design §9.1). */
export function buildRemoteCommand(args: RemoteSpawnArgs): string {
  const name = shellQuote(args.tmuxSession);
  const agent = shellQuote(wrapAgentCommand(args.agentCmd)); // outer quote for the remote sh
  const opts = TMUX_OPTIONS
    .map(([k, v]) => ` \\; set-option -t ${name} ${k} ${v}`)
    .join("");
  return [
    "export TERM=xterm-256color;",
    "export LANG=C.UTF-8; export LC_ALL=C.UTF-8;",
    'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH";',
    `cd ${shellQuote(args.cwd)};`,
    `exec tmux -u new-session -A -D -s ${name} ${agent}${opts}`,
  ].join(" ");
}

/** Build the full ssh argv for a remote spawn (the mirror PTY runs this) (design §9.1). */
export function buildRemoteSpawnArgv(args: RemoteSpawnArgs): string[] {
  return ["ssh", ...SSH_SPAWN_OPTS, args.dest, buildRemoteCommand(args)];
}

/** Remote command: does the tmux session exist? (liveness, design §9.2). */
export function tmuxHasSessionCommand(tmuxSession: string): string {
  return `tmux has-session -t ${shellQuote(tmuxSession)}`;
}

/** Remote command: capture the pane for a repaint-on-attach (design §8.4, §10.5). Keeps SGR. */
export function tmuxCapturePaneCommand(tmuxSession: string): string {
  return `tmux capture-pane -p -e -t ${shellQuote(tmuxSession)}`;
}

/** Remote command: follow a session's events.log for status (design §9.2). */
export function tailEventsCommand(sessionId: string): string {
  return `tail -n +1 -F ${REMOTE_STATE_DIR}/${shellQuote(sessionId)}/events.log`;
}

// --- box-local tmux argv (the box runs tmux locally; text via argv, never a shell string, §10.5) ---

/** `tmux send-keys -t <s> -l -- <text>` as argv (literal text, no shell interpretation). */
export function tmuxSendLiteralArgv(tmuxSession: string, text: string): string[] {
  return ["tmux", "send-keys", "-t", tmuxSession, "-l", "--", text];
}
/** `tmux send-keys -t <s> Enter` — Enter as its OWN invocation (design §10.5). */
export function tmuxSendEnterArgv(tmuxSession: string): string[] {
  return ["tmux", "send-keys", "-t", tmuxSession, "Enter"];
}
/** `tmux send-keys -t <s> Escape` — clear a typed body (design §10.5). */
export function tmuxSendEscapeArgv(tmuxSession: string): string[] {
  return ["tmux", "send-keys", "-t", tmuxSession, "Escape"];
}
/** `tmux capture-pane -p -e -t <s>` as argv (box-local). */
export function tmuxCapturePaneArgv(tmuxSession: string): string[] {
  return ["tmux", "capture-pane", "-p", "-e", "-t", tmuxSession];
}
/** `tmux kill-session -t <s>` as argv. */
export function tmuxKillSessionArgv(tmuxSession: string): string[] {
  return ["tmux", "kill-session", "-t", tmuxSession];
}

/**
 * Deploy the hook script: piped over ssh stdin, chmod +x (design §9.2). Returns the remote command;
 * the caller pipes the script body to it on stdin.
 */
export function deployHookScriptCommand(): string {
  return `mkdir -p ${REMOTE_STATE_DIR} && cat > ${REMOTE_HOOK_PATH} && chmod +x ${REMOTE_HOOK_PATH}`;
}

export type Liveness = "alive" | "no-answer" | "error";

/**
 * Classify a `tmux has-session` exit code (design §9.2): 0 -> alive; 255 (ssh failed) or null
 * (timeout) -> "no answer", NEVER dead; any other non-zero -> error.
 */
export function classifyLiveness(exitCode: number | null): Liveness {
  if (exitCode === 0) return "alive";
  if (exitCode === 255 || exitCode === null) return "no-answer";
  return "error";
}

/**
 * Detect a Tailscale re-auth prompt in streamed output (design §9.3). Requires BOTH the marker phrase
 * AND a complete login URL — the token must be followed by a non-alphanumeric character, so a prefix
 * truncated mid-stream does not open a dead link. Returns the URL, or null.
 */
export function detectTailscaleAuth(text: string): string | null {
  if (!/To authenticate, visit/i.test(text)) return null;
  const m = /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+(?=[^A-Za-z0-9])/.exec(text);
  return m ? m[0] : null;
}
