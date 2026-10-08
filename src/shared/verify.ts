/**
 * Verify-sweep classifier (PRD §13) — the pure "can a human QA confirm this by looking at the screen, or
 * does it need backend verification?" brain.
 *
 * From a ticket's acceptance criteria/description + its merged PR's changed paths, it decides which parts
 * are screen-observable (→ a human tap-through, like the Favorites ticket) and which are the invisible
 * properties a human can't see (RLS isolation, DB triggers, schema, Worker server-logic, data integrity,
 * Storage writes) — the QA blind spot the verify sweep automates.
 *
 * No I/O: the scan passes the text + the changed paths; this returns the classification that drives the
 * human-script generation (V1) and the auto-verification (V2/V3). Precision-biased toward flagging a
 * backend property: a false "needs a backend check" costs a human glance; a missed one ships broken.
 */

/** Overall verifiability of a Verifying ticket. */
export type Verifiability = "ui" | "backend" | "mixed";

/** An invisible property class that a human QA cannot confirm from the app UI. */
export type BackendProperty = "rls" | "trigger" | "schema" | "server-logic" | "data-integrity" | "storage";

export interface VerifyClassification {
  verifiability: Verifiability;
  /** Which invisible properties the ticket carries (empty ⇒ fully screen-observable). */
  backendProperties: BackendProperty[];
  /** Whether the ticket has screen-observable behavior a human QA can tap through. */
  hasUi: boolean;
}

// Property → the AC-text and (optional) changed-path signals that imply it. Order is the stable report order.
const BACKEND_SIGNALS: ReadonlyArray<readonly [BackendProperty, { text: RegExp; path?: RegExp }]> = [
  ["rls", { text: /\brls\b|row[- ]level|deny[- ]all|\bpolic(?:y|ies)\b|isolation|can(?:'?t| ?not) (?:see|read|access)/, path: /(?:^|\/)(?:policies?|rls)\b/ }],
  ["trigger", { text: /\btrigger(?:s|ed|ing)?\b/ }],
  ["schema", { text: /\b(?:migration|schema|constraint)\b/, path: /(?:^|\/)migrations?\/|\.sql$/ }],
  ["server-logic", { text: /server[- ]side|\bjwt\b|webhook|signature|\bworker\b|server[- ]authoritative/, path: /(?:^|\/)functions?\// }],
  ["data-integrity", { text: /idempoten|duplicate|dedup|\bupsert\b/ }],
  ["storage", { text: /\bstorage\b|\bbucket\b|upload[^.]*(?:file|photo|image)/ }],
];

// Screen-observable signals: a human can tap/look to confirm.
const UI_TEXT = /\btap|\bscreen\b|\btab\b|\bshows?\b|appears?|\bgrid\b|\bbutton\b|render|on[- ]screen|scroll|bottom bar|\bicon\b|toggle|\bheart\b|visible|two[- ]column/;
const UI_PATH = /(?:^|\/)(?:app|components?|screens?)\/|\.tsx$/;

/**
 * Classify a Verifying ticket from its acceptance-criteria text + the merged PR's changed paths.
 * Pure. `ui` = fully screen-observable; `backend` = only invisible properties; `mixed` = both.
 */
export function classifyVerification(text: string, changedPaths: readonly string[] = []): VerifyClassification {
  const hay = text.toLowerCase();
  const paths = changedPaths.join("\n").toLowerCase();

  const backendProperties: BackendProperty[] = [];
  for (const [prop, sig] of BACKEND_SIGNALS) {
    if (sig.text.test(hay) || (sig.path?.test(paths) ?? false)) backendProperties.push(prop);
  }

  const hasUi = UI_TEXT.test(hay) || UI_PATH.test(paths);
  const backend = backendProperties.length > 0;
  const verifiability: Verifiability = backend ? (hasUi ? "mixed" : "backend") : "ui";
  return { verifiability, backendProperties, hasUi };
}
