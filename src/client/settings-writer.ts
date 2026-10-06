/**
 * Settings writer (design §4.4, §19 Settings view).
 *
 * Writes the `settings` block of the operator config file. Only values that DIFFER from the shipped
 * default are written (restating a default would pin it). Prompts are edited in $EDITOR seeded with
 * the text in effect; an empty save reverts to the default.
 */

import type { Settings } from "../shared/settings.ts";

/** Persist the settings block, writing only non-default values (design §4.4). TODO(step 3). */
export function writeSettings(_settings: Partial<Settings>): void {
  throw new Error("settings-writer.writeSettings: not implemented (design §4.4)");
}
