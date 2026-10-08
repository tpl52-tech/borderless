/**
 * Verify human-QA-script generator (PRD §13 V1) — turn a Verifying ticket into the step-by-step tap-through
 * a human tester follows (like the Favorites writeup), for the SCREEN-OBSERVABLE half. The invisible backend
 * properties are auto-verified separately (V2/V3), so the prompt tells the LLM to skip them.
 *
 * The LLM is injected as a `Chat` (the subscription backend, $0 — answer-only), so this composition is
 * testable with a fake. No credentials, no backend access — V1.
 */

import type { Chat } from "./openrouter/runner.ts";
import { classifyVerification, verifyScriptPrompt, issueText } from "../shared/verify.ts";

/** Classify the ticket from its text + merged-PR paths, then ask the LLM for the human tap-through script. */
export async function buildVerifyScript(
  issue: { identifier: string; title: string; description: string | null },
  changedPaths: readonly string[],
  chat: Chat,
): Promise<string> {
  const classification = classifyVerification(issueText(issue), changedPaths);
  const res = await chat([{ role: "user", content: verifyScriptPrompt(issue, classification) }], []);
  return res.text?.trim() || "(no script generated)";
}
