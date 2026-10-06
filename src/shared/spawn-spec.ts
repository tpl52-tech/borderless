/**
 * Per-CLI spawn spec — the ONE place that knows tool flags (design §7.2).
 *
 * claude: fresh -> --session-id <uuid we mint>; resume -> --resume <handle>. --model, --effort,
 *   --permission-mode default/acceptEdits/bypassPermissions. ONE --settings JSON (a second flag would
 *   win) carrying claudeMdExcludes + the notify hooks. --append-system-prompt on EVERY spawn (incl.
 *   resumes) with deferred-tool guidance. Seed positional last UNLESS deferred.
 * codex: no launch id; resume via an explicit isResume flag (`resume <id>` preferred, else
 *   `resume --last`). -m, -c model_reasoning_effort=. Permissions map to sandbox flags. Hook via
 *   -c notify=[...argv, "codex-event"]. Seed positional, never deferred.
 * copilot: fresh --name ao-<8hex>; resume --resume=<handle> (the = form is required). --model,
 *   --effort. Anything beyond ask -> --allow-all-tools. No hooks. Seed via -i.
 * openrouter: in-process (build step 10) — not built here.
 */

import type { Tool, Permissions, Effort } from "./types.ts";

export interface SpawnRequest {
  tool: Tool;
  sessionId: string;
  cwd: string;
  /** "" or "auto" => omit --model. */
  model: string;
  effort: Effort | null;
  permissions: Permissions;
  isResume: boolean;
  /** claude: the minted/resumed uuid; copilot: the session name; codex: discovered id (resume only). */
  resumeHandle?: string | null;
  seed?: string;
  seedIsTicket?: boolean;
  // hook wiring — local (bun runs hook-notify.ts) OR remote (sh runs hook-notify.sh with the sessionId):
  bunPath: string; // process.execPath
  hookNotifyPath: string; // abs path to hook-notify.ts
  sessionDir: string; // for env (local only)
  /** when set, the agent is remote: hooks call `sh <remoteHookPath> <sessionId> <event>` (design §9.2). */
  remoteHookPath?: string;
  // claude extras:
  appendSystemPrompt?: string;
  claudeMdExcludes?: string[];
}

export interface SpawnSpec {
  argv: string[];
  /**
   * claude gets a TICKET seed typed in LATER: true iff seedIsTicket AND tool is claude AND fresh —
   * the untrusted-folder trust gate on codex/copilot would swallow typed text as menu keystrokes.
   */
  deferSeedPrompt: boolean;
  env: Record<string, string>;
}

/**
 * The deferred-tool guidance carried on every claude spawn (design §7.2): it is a SYSTEM prompt, not
 * a seed, because seeds don't survive resume. Prevents the "made 15 calls to the wrong tool and
 * concluded the MCP server was down" incident.
 */
export const DEFERRED_TOOL_GUIDANCE =
  "When an MCP tool you need is deferred, load it with the exact deferred-tool search (select by " +
  "name). An empty search result means success, not failure — never fall back to the regex search " +
  "tool, and never conclude a server is down from an empty result.";

const CLAUDE_PERMISSION_MODE: Record<Permissions, string> = {
  ask: "default",
  "auto-edits": "acceptEdits",
  "full-access": "bypassPermissions",
};

function hookCommand(req: SpawnRequest, event: string): string {
  return req.remoteHookPath
    ? `sh ${req.remoteHookPath} ${req.sessionId} ${event}` // remote hook takes <sessionId> <event> (§9.2)
    : `${req.bunPath} ${req.hookNotifyPath} ${event}`;
}

function claudeSettings(req: SpawnRequest): string {
  const cmd = (event: string) => ({ type: "command", command: hookCommand(req, event) });
  const settings: Record<string, unknown> = {
    hooks: {
      Notification: [
        { matcher: "permission_prompt", hooks: [cmd("needs-input")] },
        { matcher: "idle_prompt", hooks: [cmd("done")] },
      ],
      Stop: [{ hooks: [cmd("done")] }],
    },
  };
  if (req.claudeMdExcludes && req.claudeMdExcludes.length) {
    settings.claudeMdExcludes = req.claudeMdExcludes;
  }
  return JSON.stringify(settings);
}

/** Build the argv + env for a spawn (design §7.2). Throws for openrouter (in-process, step 10). */
export function buildSpawnSpec(req: SpawnRequest): SpawnSpec {
  const model = req.model && req.model !== "auto" ? req.model : null;
  const env: Record<string, string> = { AO_SESSION_ID: req.sessionId, AO_SESSION_DIR: req.sessionDir };
  // Deferred seed delivery is LOCAL-only (it drives the local PTY's quiescence, §10.7); remote seed
  // typing goes over the awaited ssh nudge hop, which lands with the nudge path (build step 6).
  const deferSeedPrompt =
    !!req.seedIsTicket && req.tool === "claude" && !req.isResume && !!req.seed && !req.remoteHookPath;

  switch (req.tool) {
    case "claude": {
      const argv = ["claude"];
      if (req.isResume && req.resumeHandle) argv.push("--resume", req.resumeHandle);
      else if (req.resumeHandle) argv.push("--session-id", req.resumeHandle);
      if (model) argv.push("--model", model);
      if (req.effort) argv.push("--effort", req.effort);
      argv.push("--permission-mode", CLAUDE_PERMISSION_MODE[req.permissions]);
      argv.push("--append-system-prompt", req.appendSystemPrompt ?? DEFERRED_TOOL_GUIDANCE);
      argv.push("--settings", claudeSettings(req));
      if (req.seed && !deferSeedPrompt && !req.isResume) argv.push(req.seed);
      return { argv, deferSeedPrompt, env };
    }

    case "codex": {
      const argv = ["codex"];
      if (req.isResume) {
        argv.push("resume");
        if (req.resumeHandle) argv.push(req.resumeHandle);
        else argv.push("--last");
      }
      if (model) argv.push("-m", model);
      if (req.effort) argv.push("-c", `model_reasoning_effort=${req.effort}`);
      if (req.permissions === "auto-edits") {
        argv.push("--ask-for-approval", "on-request", "--sandbox", "workspace-write");
      } else if (req.permissions === "full-access") {
        argv.push("--dangerously-bypass-approvals-and-sandbox");
      }
      // Hook: codex appends its own JSON event as the last arg.
      argv.push("-c", req.remoteHookPath
        ? `notify=["sh","${req.remoteHookPath}","${req.sessionId}","codex-event"]`
        : `notify=["${req.bunPath}","${req.hookNotifyPath}","codex-event"]`);
      if (req.seed && !req.isResume) argv.push(req.seed);
      return { argv, deferSeedPrompt: false, env };
    }

    case "copilot": {
      const argv = ["copilot"];
      if (req.isResume && req.resumeHandle) argv.push(`--resume=${req.resumeHandle}`);
      else argv.push("--name", req.resumeHandle ?? `ao-${req.sessionId.slice(0, 8)}`);
      if (model) argv.push("--model", model);
      if (req.effort) argv.push("--effort", req.effort);
      if (req.permissions !== "ask") argv.push("--allow-all-tools");
      if (req.seed && !req.isResume) argv.push("-i", req.seed);
      return { argv, deferSeedPrompt: false, env };
    }

    case "openrouter":
      throw new Error("spawn-spec: openrouter runs in-process, not via argv (design §16, build step 10)");
  }
}
