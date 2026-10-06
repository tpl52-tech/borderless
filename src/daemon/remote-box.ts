/**
 * Remote-agent plumbing for devbox sessions (design §9). Owns the ssh-adjacent resources that hang off
 * a remote agent's mirror PTY: deploying the hook script once per daemon run, following each session's
 * events.log over ssh (status), the 60s liveness tick, capture-pane repaint on attach, and Tailscale
 * re-auth scanning of spawn output.
 *
 * NOTE: this code drives a real ssh+tmux devbox and is exercised end-to-end only against one. The
 * command strings it uses come from the unit-tested builders in src/shared/remote.ts.
 */

import { readFileSync } from "node:fs";
import {
  buildRemoteSpawnArgv, tmuxHasSessionCommand, tmuxCapturePaneCommand, tailEventsCommand,
  deployHookScriptCommand, classifyLiveness, detectTailscaleAuth, remoteHome, sshUserFromDest,
  REMOTE_HOOK_PATH, SSH_SPAWN_OPTS, type RemoteSpawnArgs,
} from "../shared/remote.ts";
import { runRemote } from "./ssh.ts";
import type { StatusTracker } from "./monitors/status.ts";
import type { PtySession } from "./pty.ts";

const LIVENESS_TICK_MS = 60_000;
const TAILSCALE_SCAN_MS = 30_000;
const TAILSCALE_TAIL_CHARS = 200;

const HOOK_SCRIPT_PATH = new URL("../../deploy/box/hook-notify.sh", import.meta.url);

export interface RemoteAgentsOptions {
  dest: string;
  tracker: StatusTracker;
  onOpenUrl: (sessionId: string, url: string) => void;
}

interface RemoteSession {
  tmuxSession: string;
  tail: ReturnType<typeof Bun.spawn> | null;
  liveness: ReturnType<typeof setInterval> | null;
}

export class RemoteAgents {
  private readonly dest: string;
  private readonly tracker: StatusTracker;
  private readonly onOpenUrl: (sessionId: string, url: string) => void;
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly seenAuthUrls = new Set<string>(); // dedupe per daemon run (design §9.3)
  private hookDeploy: Promise<void> | null = null;

  constructor(opts: RemoteAgentsOptions) {
    this.dest = opts.dest;
    this.tracker = opts.tracker;
    this.onOpenUrl = opts.onOpenUrl;
  }

  /** Build the ssh mirror-PTY argv for a remote spawn (design §9.1). */
  buildSpawnArgv(args: Omit<RemoteSpawnArgs, "dest">): string[] {
    return buildRemoteSpawnArgv({ dest: this.dest, ...args });
  }

  remoteHookPath(): string {
    return REMOTE_HOOK_PATH.replace("$HOME", remoteHome(sshUserFromDest(this.dest)));
  }

  /** Deploy the hook script once per daemon run (design §9.2). Idempotent + memoized. */
  ensureHookDeployed(): Promise<void> {
    if (!this.hookDeploy) {
      const body = readFileSync(HOOK_SCRIPT_PATH, "utf8");
      this.hookDeploy = runRemote(this.dest, deployHookScriptCommand(), { input: body })
        .then((r) => {
          if (r.code !== 0) throw new Error(`remote hook deploy failed (code ${r.code}): ${r.stderr}`);
        })
        .catch((err) => { this.hookDeploy = null; throw err; }); // allow retry on next spawn
    }
    return this.hookDeploy;
  }

  /** Begin following status + liveness for a remote session (design §9.2). */
  startSession(sessionId: string, tmuxSession: string): void {
    if (this.sessions.has(sessionId)) return;
    const entry: RemoteSession = { tmuxSession, tail: null, liveness: null };
    this.sessions.set(sessionId, entry);
    this.startTail(sessionId, entry);
    entry.liveness = setInterval(() => void this.tickLiveness(sessionId, entry), LIVENESS_TICK_MS);
  }

  private startTail(sessionId: string, entry: RemoteSession): void {
    const proc = Bun.spawn(["ssh", ...SSH_SPAWN_OPTS, this.dest, tailEventsCommand(sessionId)], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    entry.tail = proc;
    void this.consumeTail(sessionId, proc.stdout as ReadableStream<Uint8Array>);
  }

  private async consumeTail(sessionId: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const nl = buf.lastIndexOf("\n");
        if (nl < 0) continue;
        for (const line of buf.slice(0, nl).split("\n")) {
          const token = line.trim().split(/\s+/)[1]; // "<epoch> <event>"
          if (token === "needs-input" || token === "done") this.tracker.feedHook(sessionId, token);
        }
        buf = buf.slice(nl + 1);
      }
    } catch { /* stream closed on shutdown */ } finally {
      reader.releaseLock();
    }
  }

  private async tickLiveness(sessionId: string, entry: RemoteSession): Promise<void> {
    const r = await runRemote(this.dest, tmuxHasSessionCommand(entry.tmuxSession), { timeoutMs: 20_000 });
    // 255/timeout => "no answer", NEVER dead (design §9.2). Only a clean non-zero-non-255 => error.
    if (classifyLiveness(r.code) === "error") this.tracker.onExit(sessionId, "error");
  }

  /** Repaint bytes for attach: capture the tmux pane (design §8.4 — never replay recorded bytes). */
  async captureRepaint(tmuxSession: string): Promise<Uint8Array> {
    const r = await runRemote(this.dest, tmuxCapturePaneCommand(tmuxSession), { timeoutMs: 20_000 });
    // CRLF-convert so the client terminal lays the captured body out correctly.
    return new TextEncoder().encode(r.stdout.replace(/\r?\n/g, "\r\n"));
  }

  /**
   * Scan a remote spawn's mirror-PTY output for a Tailscale re-auth prompt (design §9.3): within 30s
   * of spawn, over a 200-char rolling tail, ending at the first ESC (tmux's paint proves ssh got past
   * auth). Dedupe per URL per daemon run.
   */
  scanTailscale(sessionId: string, pty: PtySession): void {
    let tail = "";
    let stopped = false;
    const decoder = new TextDecoder();
    const off = pty.addOutputListener((bytes) => {
      if (stopped) return;
      if (bytes.includes(0x1b)) { stop(); return; } // first ESC => past auth
      tail = (tail + decoder.decode(bytes, { stream: true })).slice(-TAILSCALE_TAIL_CHARS);
      const url = detectTailscaleAuth(tail);
      if (url && !this.seenAuthUrls.has(url)) {
        this.seenAuthUrls.add(url);
        this.onOpenUrl(sessionId, url);
      }
    });
    const stop = () => { if (!stopped) { stopped = true; off(); } };
    setTimeout(stop, TAILSCALE_SCAN_MS);
  }

  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.liveness) clearInterval(entry.liveness);
    entry.tail?.kill();
    this.sessions.delete(sessionId);
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.stopSession(id);
  }
}
