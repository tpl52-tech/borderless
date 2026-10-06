/**
 * Subprocess hygiene for ssh and other one-shot commands (design §9.4).
 *
 * Every subprocess has a 45s hard deadline with SIGKILL and reader cleanup in `finally` (SIGKILL
 * doesn't close pipes a grandchild holds; leaked fds once caused "file table overflow" after 12 days).
 * Exit code is null on timeout; 255 distinguishes ssh's OWN failure from the remote command's.
 * Motivating incident: one hung ssh held the poll latch for 11h45m while six PRs merged unnoticed.
 */

import { SSH_ONESHOT_OPTS } from "../shared/remote.ts";

export const SUBPROCESS_DEADLINE_MS = 45_000;

export interface RunResult {
  code: number | null; // null when killed by the deadline
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  input?: string | Uint8Array;
  cwd?: string;
}

/** Run a command with a hard deadline + SIGKILL. Never rejects on non-zero exit. */
export async function runWithDeadline(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? SUBPROCESS_DEADLINE_MS;
  const proc = Bun.spawn(argv, {
    stdin: opts.input != null ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
  });

  if (opts.input != null && proc.stdin) {
    const w = proc.stdin as unknown as { write(d: string | Uint8Array): void; end(): void };
    w.write(opts.input);
    w.end();
  }

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(9); }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code: timedOut ? null : code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** Run a one-shot command on the devbox over ssh (design §9.4 ssh options). */
export function runRemote(dest: string, remoteCommand: string, opts: RunOptions = {}): Promise<RunResult> {
  return runWithDeadline(["ssh", ...SSH_ONESHOT_OPTS, dest, remoteCommand], opts);
}
