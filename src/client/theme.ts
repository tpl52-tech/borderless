/**
 * Borderless console palette (PRD §11) — the committed single-theme terminal look from
 * docs/borderless-console.html: pink + green on near-black (reUSE: nature + feminine). Pure constants + a
 * tone→hex map, so console-model can reason in semantic tones and console.tsx renders exact colors. Ink
 * accepts hex for both `color` and `borderColor`, so these are the same values the HTML mock uses.
 */

export const PALETTE = {
  bg: "#0b0f0c",
  panel: "#0f1511",
  panel2: "#131c16",
  line: "#243029",
  line2: "#35463b",
  ink: "#d6e4db",
  ink2: "#89a093",
  dim: "#5d7067",
  green: "#7ce7a6",
  green2: "#4b946e",
  pink: "#ff9ed4",
  pink2: "#c870a6",
  amber: "#f0ca6c",
  red: "#ff818d",
} as const;

/** Semantic foreground tones used across the console (a subset of the palette, named by meaning). */
export type Tone = "green" | "pink" | "amber" | "ink" | "ink2" | "dim" | "red";

/** Resolve a tone to its palette hex. */
export function toneColor(tone: Tone): string {
  return PALETTE[tone];
}
