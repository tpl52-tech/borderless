/**
 * Borderless console (PRD §11) — the lead-facing screens over the daemon reads: SWEEPS, BOARDS, ASSIGN,
 * LEAD DESK, ROSTER, and ASK. A separate surface from the agent dashboard (`ao`); launched with `ao console`.
 *
 * Number keys / Tab switch screen; on the five list screens ↑/↓ move and Enter on a SWEEPS row with a live
 * session attaches to it (Ink suspends for raw passthrough, re-renders on detach — the shared runSurface
 * harness). The ASK screen is a plain chat (PRD §10): type a question, Enter runs `ask.run` (advisory —
 * actions need the `--yes`/confirm path, not wired to this pane), the Q/A streams into a transcript; Esc or
 * Tab leaves. q quits on a list screen; Ctrl-C quits anywhere. All logic (screens, formatting, nav, attach
 * target, input editing) is the pure, tested console-model; this file is thin render + daemon round-trips.
 */

import React, { useEffect, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { type DaemonClient } from "./daemon-client.ts";
import { ensureDaemon, navDirection, runSurface, type SurfaceAction } from "./runtime.ts";
import {
  CONSOLE_SCREENS, formatRow, clampCursor, moveCursor, attachTarget, editInput,
} from "./console-model.ts";

const ASK_IDX = CONSOLE_SCREENS.length; // the ASK tab sits after the five list screens
const TAB_LABELS = [...CONSOLE_SCREENS.map((s) => s.label), "ASK"];
const ASK_HISTORY = 8; // transcript turns kept on screen

interface AskResult { answer: string; steps: number; costMicros: number; configured: boolean }

function Console({ client, onAction }: { client: DaemonClient; onAction: (a: SurfaceAction) => void }) {
  const [screenIdx, setScreenIdx] = useState(0);
  const [rows, setRows] = useState<unknown[]>([]);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [askInput, setAskInput] = useState("");
  const [askLog, setAskLog] = useState<Array<{ q: string; a: string }>>([]);
  const [askBusy, setAskBusy] = useState(false);
  const { exit } = useApp();

  const onAsk = screenIdx === ASK_IDX;
  const listScreen = onAsk ? null : CONSOLE_SCREENS[screenIdx]!;

  useEffect(() => {
    if (!listScreen) return;
    let alive = true;
    const load = () => client.request<unknown[]>(listScreen.request)
      .then((r) => { if (alive) { setRows(Array.isArray(r) ? r : []); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    load();
    const t = setInterval(load, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [listScreen?.request, client]);

  useEffect(() => { setCursor((c) => clampCursor(c, rows.length)); }, [rows.length]);

  const submitAsk = (): void => {
    const q = askInput.trim();
    if (!q || askBusy) return;
    setAskBusy(true);
    client.request<AskResult>("ask.run", { question: q, allowActions: false })
      .then((r) => setAskLog((l) => [...l, { q, a: r.configured ? (r.answer || "(no answer)") : "Ask Borderless is off — set openRouterApiKey in ~/.borderless/config.json" }]))
      .catch((e) => setAskLog((l) => [...l, { q, a: `error: ${e instanceof Error ? e.message : String(e)}` }]))
      .finally(() => { setAskInput(""); setAskBusy(false); });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") { onAction({ type: "quit" }); exit(); return; }
    if (key.tab) { setScreenIdx((i) => (i + 1) % TAB_LABELS.length); setCursor(0); return; }
    if (onAsk) {
      if (key.escape) { setScreenIdx(0); setCursor(0); return; } // leave even while a question is in flight
      if (askBusy) return; // ...but ignore typing/submit until it returns
      if (key.return) { submitAsk(); return; }
      setAskInput((v) => editInput(v, input, key));
      return;
    }
    if (input === "q") { onAction({ type: "quit" }); exit(); return; }
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= TAB_LABELS.length) { setScreenIdx(n - 1); setCursor(0); return; }
    const nav = navDirection(input, key);
    if (nav === "up") { setCursor((c) => moveCursor(c, -1, rows.length)); return; }
    if (nav === "down") { setCursor((c) => moveCursor(c, +1, rows.length)); return; }
    if (key.return) {
      const sessionId = attachTarget(listScreen!.key, rows, cursor);
      if (sessionId) { onAction({ type: "attach", sessionId }); exit(); }
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{TAB_LABELS.map((label, i) => (i === screenIdx ? `[${label}]` : ` ${label} `)).join(" ")}</Text>
      <Box flexDirection="column" marginTop={1}>
        {onAsk ? (
          <>
            {askLog.length === 0 ? <Text dimColor>ask about the fleet — e.g. "what's blocked?" or "who's overloaded?"</Text>
              : askLog.slice(-ASK_HISTORY).map((t, i) => (
                <Box key={i} flexDirection="column" marginBottom={1}>
                  <Text color="cyan">› {t.q}</Text>
                  <Text>{t.a}</Text>
                </Box>
              ))}
            <Text>{askBusy ? "… thinking" : `> ${askInput}`}</Text>
          </>
        ) : error ? <Text color="red">error: {error}</Text>
          : rows.length === 0 ? <Text dimColor>{listScreen!.empty}</Text>
            : rows.map((r, i) => <Text key={i} inverse={i === cursor}>{formatRow(listScreen!.key, r)}</Text>)}
      </Box>
      <Text dimColor>{"\n"}{onAsk ? "type · ⏎ ask · esc/tab leave · ^C quit" : `1-${TAB_LABELS.length} screen · tab next · ↑/↓ move · ⏎ attach (SWEEPS) · q quit`}</Text>
    </Box>
  );
}

/** Launch the console: auto-start the daemon, then render → (attach → re-render) until quit. */
export async function runConsole(): Promise<void> {
  const client = await ensureDaemon();
  try {
    await runSurface(client, (onAction) => render(<Console client={client} onAction={onAction} />));
  } finally {
    client.close();
  }
}
