/**
 * Configuration model (design §4).
 *
 * Four resolution layers, highest first:
 *   1. Environment (AO_*)              — devbox config + test escape hatch
 *   2. Operator config config.json     — only facts about YOU; malformed -> throws
 *   3. Tracked org defaults.json        — team facts; malformed/missing -> silently {}
 *   4. Built-in defaults                — autonomy window + a few numeric knobs
 *
 * Blank/whitespace env values read as unset, so an empty export cannot shadow the file.
 * Nothing personal is ever defaulted — an absent identity key is a startup error naming it.
 */

import { existsSync, readFileSync } from "node:fs";
import { paths, stateHome } from "./paths.ts";
import { normalizeProfiles, type Profile } from "./profile.ts";
import { parseSettings, DEFAULT_SETTINGS, type Settings } from "./settings.ts";

/** Personal identity — required or per-feature, NEVER defaulted (design §4.2). */
export interface OperatorIdentity {
  /** branch prefix `<owner>/ENG-123`; always required. */
  branchOwner: string;
  /** ssh destination; required for remote agents. */
  devbox?: string;
  /** how the alert persona addresses you. */
  operatorName?: string;
  /** GitHub login, for detecting your own ack comments. */
  operatorLogin?: string;
  /** who autonomy-created follow-up tickets go to; unset -> unassigned. */
  linearAssignee?: string;
  /** required when alerts are on. */
  alertSlackId?: string;
}

/** Team facts — from defaults.json, overridable by operator config (design §4.2). */
export interface TeamConfig {
  repo?: string;
  defaultRemoteCwd?: string;
  /** identity a review is requested from. */
  ctoLogin?: string;
  /** identity @-mentioned to bump the reviewer queue. */
  ctoBotLogin?: string;
  /**
   * set of identities whose reviews count as the CTO's. A helper adds the suffix-less alias
   * for every `X[bot]` entry (a GitHub App's GraphQL login omits `[bot]`; REST includes it).
   */
  ctoLogins?: string[];
  ctoRepo?: string;
  ctoHostMatch?: string;
  linearWorkspace?: string;
  /** which `ABC-123` tokens are real tickets (so UTF-8 / HTTP-404 aren't mistaken for them). */
  linearTeamKeys?: string[];
}

/** Built-in defaults (design §4.2) — the ONLY layer with numeric knobs. */
export interface BuiltinDefaults {
  autonomyTimeZone: string; // "America/New_York"
  autonomyStartHour: number; // 9
  autonomyEndHour: number; // 21
  worktreeReapDays: number; // 7
  ctoReviewDelayNudgeMinutes: number; // 15
}

export const BUILTIN_DEFAULTS: BuiltinDefaults = {
  autonomyTimeZone: "America/New_York",
  autonomyStartHour: 9,
  autonomyEndHour: 21,
  worktreeReapDays: 7,
  ctoReviewDelayNudgeMinutes: 15,
};

/** The fully-resolved config the daemon runs on. */
export interface ResolvedConfig extends OperatorIdentity, TeamConfig, BuiltinDefaults {
  profiles: Profile[];
  settings: Settings;
}

/**
 * Runtime authority toggles are environment-only ON PURPOSE (design §4.2, §13.6): they grant
 * authority to act unattended, so "install the daemon" and "let it act" stay separate.
 */
export const RUNTIME_ENV_TOGGLES = [
  "AO_AUTONOMY",
  "AO_AUTONOMY_DRY_RUN",
  "AO_AUTONOMY_SESSIONS",
  "AO_AUTONOMY_LOCATIONS",
  "AO_AUTONOMY_ALWAYS",
  "AO_ALERTS",
  "AO_ALERTS_DRY_RUN",
  "AO_CI_IGNORE",
  "AO_STUCK_MINUTES",
  "AO_STUCK_QUIET_MINUTES",
] as const;

export interface ValidateOptions {
  /** an unset repo is legal and means "no PR monitoring" (design §5.1). */
  needsRepo?: boolean;
  /** required iff AO_ALERTS=1. */
  needsAlerts?: boolean;
}

/**
 * Resolve config across the four layers and validate it. Dies at boot on misconfiguration,
 * with an error naming the missing key.
 * TODO(step 1): implement the layered resolution + blank-env handling + validation.
 */
export function resolveConfig(_opts?: ValidateOptions): ResolvedConfig {
  throw new Error("config.resolveConfig: not implemented (design §4, §5.1)");
}

/** Read a AO_* env value, treating blank/whitespace as unset (design §4.1). */
export function envOrUnset(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * A partial config the spawn sequence needs: settings + profiles + a few identity/team keys. This is
 * the TOLERANT loader used from build step 3 onward; the strict four-layer {@link resolveConfig} (which
 * throws on missing identity) is a later milestone. TODO: merge tracked defaults.json under the user
 * file (design §4.1).
 */
export interface OperatorConfigLite {
  settings: Settings;
  profiles: Profile[];
  branchOwner?: string;
  devbox?: string;
  linearWorkspace?: string;
  linearTeamKeys?: string[];
  /** Linear personal API key for the issue sync (secret; lives only in the 0600 operator config). */
  linearApiKey?: string;
  ctoLogin?: string;
  ctoBotLogin?: string;
  operatorLogin?: string;
  alertSlackId?: string;
  defaultProfileId?: string;
  repo?: string;
  /** Linear project whose issues are the lead desk (PRD §9) — excluded from both sweeps; default "Lead Ops". */
  leadOpsProject?: string;
  /** Slack bot token for lead-desk delegation DMs (secret; operator config only). Absent → no DM sent. */
  slackBotToken?: string;
  /** Ask Borderless chat backend (PRD §10/§12): "subscription" runs the local `claude` CLI ($0, answer-only),
   *  "openrouter" uses the OpenRouter API (needs openRouterApiKey, supports the action tools). Default: subscription. */
  askBackend?: "subscription" | "openrouter";
  /** Model for the subscription backend, passed to `claude --model` (optional; else the CLI's default). */
  askModel?: string;
  /** OpenRouter API key for the openrouter backend (secret; operator config only). Absent → that backend is off. */
  openRouterApiKey?: string;
  /** OpenRouter model id for the openrouter backend; defaults to DEFAULT_OPENROUTER_MODEL. */
  openRouterModel?: string;
  /** Localhost port for the web console (PRD §11 browser mirror); defaults to DEFAULT_WEB_PORT. */
  webPort?: number;
  /** Topbar label on the web console (e.g. "ReUse · Fall 2026"); cosmetic, defaults to "Borderless". */
  projectLabel?: string;
}

/** Default Ask Borderless model (overridable via `openRouterModel`). */
export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4";

/** Default localhost port for the web console (overridable via `webPort`). */
export const DEFAULT_WEB_PORT = 7420;

export function loadOperatorConfig(home = stateHome()): OperatorConfigLite {
  const file = paths(home).config;
  let raw: Record<string, any> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    } catch (err) {
      // The strict loader (resolveConfig) will throw on this later; here we degrade so the daemon boots.
      console.error(`config: ignoring malformed ${file}:`, err instanceof Error ? err.message : err);
      raw = {};
    }
  }
  let profiles: Profile[] = [];
  try {
    profiles = normalizeProfiles(raw.profiles);
  } catch (err) {
    console.error("config: ignoring invalid profiles:", err instanceof Error ? err.message : err);
  }
  return {
    settings: parseSettings(raw.settings),
    profiles,
    branchOwner: typeof raw.branchOwner === "string" ? raw.branchOwner : undefined,
    devbox: typeof raw.devbox === "string" ? raw.devbox : undefined,
    linearWorkspace: typeof raw.linearWorkspace === "string" ? raw.linearWorkspace : undefined,
    linearTeamKeys: Array.isArray(raw.linearTeamKeys) ? raw.linearTeamKeys : undefined,
    linearApiKey: typeof raw.linearApiKey === "string" ? raw.linearApiKey : undefined,
    ctoLogin: typeof raw.ctoLogin === "string" ? raw.ctoLogin : undefined,
    ctoBotLogin: typeof raw.ctoBotLogin === "string" ? raw.ctoBotLogin : undefined,
    operatorLogin: typeof raw.operatorLogin === "string" ? raw.operatorLogin : undefined,
    alertSlackId: typeof raw.alertSlackId === "string" ? raw.alertSlackId : undefined,
    defaultProfileId: typeof raw.defaultProfileId === "string" ? raw.defaultProfileId : undefined,
    repo: typeof raw.repo === "string" ? raw.repo : undefined,
    leadOpsProject: typeof raw.leadOpsProject === "string" && raw.leadOpsProject.trim() ? raw.leadOpsProject.trim() : undefined,
    slackBotToken: typeof raw.slackBotToken === "string" && raw.slackBotToken.trim() ? raw.slackBotToken.trim() : undefined,
    askBackend: raw.askBackend === "openrouter" ? "openrouter" : raw.askBackend === "subscription" ? "subscription" : undefined,
    askModel: typeof raw.askModel === "string" && raw.askModel.trim() ? raw.askModel.trim() : undefined,
    openRouterApiKey: typeof raw.openRouterApiKey === "string" && raw.openRouterApiKey.trim() ? raw.openRouterApiKey.trim() : undefined,
    openRouterModel: typeof raw.openRouterModel === "string" && raw.openRouterModel.trim() ? raw.openRouterModel.trim() : undefined,
    webPort: Number.isInteger(raw.webPort) && raw.webPort >= 1 && raw.webPort <= 65535 ? raw.webPort : undefined,
    projectLabel: typeof raw.projectLabel === "string" && raw.projectLabel.trim() ? raw.projectLabel.trim() : undefined,
  };
}

/** The default lite config (no config file present). */
export function defaultOperatorConfig(): OperatorConfigLite {
  return { settings: DEFAULT_SETTINGS, profiles: [] };
}
