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
 *
 * Path signals are tested PER PATH (like sweep-gate.ts/collision.ts), so `^`/`$` anchor each path — a
 * whole-string join would make `.sql$` match only the last path. Text signals require noun/DB context where
 * a bare verb would over-fire (the `trigger`/`storage`/`policy` senses collide with ordinary UI language).
 * Note: `lib/api/*` is deliberately NOT a backend signal — in this Expo app it's the RN client's own data
 * layer (frontend), so mapping it would false-flag every data-loading screen.
 */

/** Overall verifiability of a Verifying ticket. */
export type Verifiability = "ui" | "backend" | "mixed";

/** An invisible property class that a human QA cannot confirm from the app UI. */
export type BackendProperty = "rls" | "trigger" | "schema" | "server-logic" | "data-integrity" | "storage";

// Property → the AC-text and (optional, per-path) changed-path signals that imply it. Stable report order.
const BACKEND_SIGNALS: ReadonlyArray<readonly [BackendProperty, { text: RegExp; path?: RegExp }]> = [
  // cross-user access control — not the "privacy policy screen" or "can't see the grid" UI senses.
  ["rls", { text: /\brls\b|row[- ]level|deny[- ]all|(?:rls|security|access) polic(?:y|ies)|can(?:'?t| ?not) (?:see|read|access) (?:another|other|others|each other|a different)/, path: /(?:^|\/)(?:policies?|rls)\b/ }],
  // DB trigger, not the verb "triggers" — needs a DB-noun nearby, an explicit "db/sql trigger", or a migration path.
  ["trigger", { text: /\btrigger(?:s|ed|ing)?\b[^.\n]{0,40}\b(?:insert|inserts|row|rows|record|notification|table|function|on (?:approv|sold|insert|update|delete))|\b(?:insert|inserts|row|notification|record)[^.\n]{0,40}\btrigger|\b(?:db|database|sql)[- ]?trigger/, path: /(?:^|\/)migrations?\/|\.sql$/ }],
  ["schema", { text: /\b(?:migration|schema|constraint)\b/, path: /(?:^|\/)migrations?\/|\.sql$/ }],
  ["server-logic", { text: /server[- ]side|\bjwt\b|webhook|signature|\bworker\b|server[- ]authoritative/, path: /(?:^|\/)functions?\// }],
  ["data-integrity", { text: /idempoten|duplicate|dedup|\bupsert\b/ }],
  // Supabase Storage — the negative lookbehinds keep bare "to Storage" recall while excluding the
  // device-local "local storage" / "async storage" senses, which are screen-observable (COR-35).
  ["storage", { text: /(?<!local )(?<!async )\bstorage\b|\bbucket\b|upload[^.\n]*(?:file|photo|image)/ }],
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
  const paths = changedPaths.map((p) => p.toLowerCase());
  const matchesPath = (re: RegExp | undefined): boolean => re != null && paths.some((p) => re.test(p));

  const backendProperties: BackendProperty[] = [];
  for (const [prop, sig] of BACKEND_SIGNALS) {
    if (sig.text.test(hay) || matchesPath(sig.path)) backendProperties.push(prop);
  }

  const hasUi = UI_TEXT.test(hay) || paths.some((p) => UI_PATH.test(p));
  const backend = backendProperties.length > 0;
  const verifiability: Verifiability = backend ? (hasUi ? "mixed" : "backend") : "ui";
  return { verifiability, backendProperties, hasUi };
}

export interface VerifyClassification {
  verifiability: Verifiability;
  /** Which invisible properties the ticket carries (empty ⇒ fully screen-observable). */
  backendProperties: BackendProperty[];
  /** Whether the ticket has screen-observable behavior a human QA can tap through. */
  hasUi: boolean;
}
