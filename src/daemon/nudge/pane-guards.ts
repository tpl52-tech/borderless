/**
 * Pane guards — Claude-shaped, ONE-DIRECTIONAL (design §10.5).
 *
 * An uninterpretable line means "safe to type"; anything ambiguous means "hold". The asymmetry is
 * deliberate: one TUI change that fools a guard should silence a nudge, never fire one into a busy pane.
 *
 * These read a `tmux capture-pane -p -e` (SGR kept, so a dim greyed placeholder can be told from real
 * input). Stranded-text recognition exists because of the 58-copies incident: typed, submit didn't take,
 * next tick saw "pending input", hold expired, retry typed another copy on top, repeat. The rule: NEVER
 * retype our own stranded text.
 */

const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DIM_RUN = /\x1b\[2m[\s\S]*?\x1b\[(?:0|22)m/g; // greyed placeholder suggestions look like input

/** Strip dim runs (their content is a placeholder, not real input), then all remaining ANSI. */
export function plain(text: string): string {
  return text.replace(DIM_RUN, "").replace(OSC, "").replace(CSI, "").replace(/\r/g, "");
}

const normalizeLine = (s: string): string => s.replace(/[ \t]+/g, " ").trim();
const lines = (s: string): string[] => s.split("\n");

/** "esc to interrupt" present, or a live spinner line (glyph, word, ellipsis, duration incl. h/m/s). */
export function looksBusy(plainText: string): boolean {
  if (/esc to interrupt/i.test(plainText)) return true;
  for (const line of lines(plainText)) {
    const hasEllipsis = /(?:…|\.\.\.)/.test(line);
    // A duration digit + unit; NO trailing \b so concatenated forms like "1h2m3s" match. The unit
    // class MUST include h (an hour-long turn once read idle).
    const hasDuration = /\d+\s*[hms]/.test(line);
    if (hasEllipsis && hasDuration) return true;
  }
  return false;
}

/** The last prompt row (> or ❯) has non-whitespace text after the prompt character. */
export function hasPendingInput(plainText: string): boolean {
  let pending = false;
  for (const line of lines(plainText)) {
    const m = /^\s*[>❯]\s?(.*)$/.exec(line);
    if (m) pending = normalizeLine(m[1]!).length > 0;
  }
  return pending;
}

/** A confirmation/selection menu: a footer AND a numbered option in the last 15 lines. */
export function looksLikeMenu(plainText: string): boolean {
  const last15 = lines(plainText).slice(-15);
  const joined = last15.join("\n");
  const footer = /enter to confirm|esc to cancel|to select|↑\/↓/i.test(joined);
  const numbered = last15.some((l) => /^\s*[>❯]?\s*\d+[.)]/.test(l));
  if (!footer || !numbered) return false;
  // Cleared-dialog exception: an empty prompt row plus a blank row between (design §10.5).
  for (let i = 0; i < last15.length - 1; i++) {
    if (/^\s*[>❯]\s*$/.test(last15[i]!) && normalizeLine(last15[i + 1]!) === "") return false;
  }
  return true;
}

export interface PaneAnalysis {
  hasPendingInput: boolean;
  looksBusy: boolean;
  looksLikeMenu: boolean;
}

export function analyzePane(captured: string): PaneAnalysis {
  const p = plain(captured);
  return { hasPendingInput: hasPendingInput(p), looksBusy: looksBusy(p), looksLikeMenu: looksLikeMenu(p) };
}

/**
 * Fingerprint of a nudge body: its normalized first line, usable when >= 12 chars (>= 24 is the strong
 * form; >= 12 is the prefix form for narrow wrapped panes). Returns null when too short to be reliable.
 */
export function fingerprint(body: string): string | null {
  const first = normalizeLine(lines(body)[0] ?? "");
  return first.length >= 12 ? first : null;
}

/**
 * Is our own sent body currently stranded in the pane (typed but unsent)? If so, the caller presses
 * Enter — it NEVER retypes (the 58-copies rule). Pragmatic reconstruction: does the pane contain our
 * fingerprint (full, or a 12-char prefix)?
 */
export function isStranded(capturedPane: string, sentBody: string): boolean {
  const fp = fingerprint(sentBody);
  if (!fp) return false;
  const pane = normalizeLine(plain(capturedPane));
  if (pane.includes(fp)) return true;
  const prefix = fp.slice(0, 12);
  return prefix.length >= 12 && pane.includes(prefix);
}
