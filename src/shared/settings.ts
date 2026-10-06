/**
 * Settings — preferences, distinct from identity (design §4.4).
 *
 * Stored in a `settings` block of the config file. Every one has a working default; unset is normal;
 * resolution is file -> default, deliberately NOT env. Only values that DIFFER from the shipped
 * default are written (restating a default would pin it). Malformed settings -> defaults, NEVER throw
 * (a spawn form with stock defaults beats a dashboard that won't start).
 */

import type { Tool, Location, Permissions, Effort } from "./types.ts";

export interface SpawnDefaults {
  tool: Tool;
  model: string; // "auto"
  effort: Effort;
  location: Location;
  usesWorktree: boolean;
  permissions: Permissions;
}

export interface FocusThresholds {
  agentSilenceMs: number; // 10 min
  prSilenceMs: number; // 20 min
}

export interface Settings {
  spawnDefaults: SpawnDefaults;
  /** {TICKET} is replaced everywhere with the uppercased ticket id. */
  ticketPrompt: string; // legacy shared (claude)
  ticketPromptCodex: string;
  ticketPromptCopilot: string;
  ticketPromptOpenRouter: string;
  focus: FocusThresholds;
}

export const DEFAULT_SETTINGS: Settings = {
  spawnDefaults: {
    tool: "claude",
    model: "auto",
    effort: "medium",
    location: "local",
    usesWorktree: true,
    permissions: "full-access",
  },
  ticketPrompt: "",
  ticketPromptCodex: "",
  ticketPromptCopilot: "",
  ticketPromptOpenRouter: "",
  focus: {
    agentSilenceMs: 10 * 60 * 1000,
    prSilenceMs: 20 * 60 * 1000,
  },
};

const TOOLS: Tool[] = ["claude", "codex", "copilot", "openrouter"];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const PERMS: Permissions[] = ["ask", "auto-edits", "full-access"];

const oneOf = <T>(set: T[], v: unknown, fallback: T): T => (set.includes(v as T) ? (v as T) : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Parse a raw settings block, falling back to defaults field-by-field. Never throws. */
export function parseSettings(raw: unknown): Settings {
  try {
    if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_SETTINGS);
    const r = raw as Record<string, any>;
    const sd = (r.spawnDefaults ?? {}) as Record<string, any>;
    const f = (r.focus ?? {}) as Record<string, any>;
    const D = DEFAULT_SETTINGS;
    return {
      spawnDefaults: {
        tool: oneOf(TOOLS, sd.tool, D.spawnDefaults.tool),
        model: str(sd.model, D.spawnDefaults.model),
        effort: oneOf(EFFORTS, sd.effort, D.spawnDefaults.effort),
        location: sd.location === "devbox" || sd.location === "local" ? sd.location : D.spawnDefaults.location,
        usesWorktree: bool(sd.usesWorktree, D.spawnDefaults.usesWorktree),
        permissions: oneOf(PERMS, sd.permissions, D.spawnDefaults.permissions),
      },
      ticketPrompt: str(r.ticketPrompt, D.ticketPrompt),
      ticketPromptCodex: str(r.ticketPromptCodex, D.ticketPromptCodex),
      ticketPromptCopilot: str(r.ticketPromptCopilot, D.ticketPromptCopilot),
      ticketPromptOpenRouter: str(r.ticketPromptOpenRouter, D.ticketPromptOpenRouter),
      focus: {
        agentSilenceMs: num(f.agentSilenceMs, D.focus.agentSilenceMs),
        prSilenceMs: num(f.prSilenceMs, D.focus.prSilenceMs),
      },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/**
 * Produce the minimal object to persist: only values that DIFFER from the shipped default (design
 * §4.4). Restating a default would pin it, so those are omitted.
 */
export function diffSettings(settings: Settings): Record<string, unknown> {
  const D = DEFAULT_SETTINGS;
  const out: Record<string, unknown> = {};

  const sd: Record<string, unknown> = {};
  for (const k of Object.keys(D.spawnDefaults) as (keyof SpawnDefaults)[]) {
    if (settings.spawnDefaults[k] !== D.spawnDefaults[k]) sd[k] = settings.spawnDefaults[k];
  }
  if (Object.keys(sd).length) out.spawnDefaults = sd;

  for (const k of ["ticketPrompt", "ticketPromptCodex", "ticketPromptCopilot", "ticketPromptOpenRouter"] as const) {
    if (settings[k] !== D[k]) out[k] = settings[k];
  }

  const focus: Record<string, unknown> = {};
  for (const k of Object.keys(D.focus) as (keyof FocusThresholds)[]) {
    if (settings.focus[k] !== D.focus[k]) focus[k] = settings.focus[k];
  }
  if (Object.keys(focus).length) out.focus = focus;

  return out;
}

/** Replace the {TICKET} placeholder everywhere with the uppercased ticket id (design §4.4). */
export function applyTicketPlaceholder(prompt: string, ticket: string): string {
  return prompt.replaceAll("{TICKET}", ticket.toUpperCase());
}
