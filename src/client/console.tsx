/**
 * Borderless console (PRD §11) — the lead-facing screens over the daemon reads: SWEEPS, BOARDS, ASSIGN,
 * LEAD DESK, ROSTER. A separate surface from the agent dashboard (`ao`); launched with `ao console`.
 *
 * Number keys 1-5 (or Tab) switch screen; ↑/↓ move the cursor; Enter on a SWEEPS row with a live session
 * attaches to it (Ink suspends for raw passthrough, re-renders on detach — same handoff as the dashboard);
 * q quits. A 1s poll keeps each screen live. All the logic (screens, formatting, nav, attach target) is the
 * pure, tested console-model; this file is thin render + the daemon round-trips + the attach loop.
 */

import React, { useEffect, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { type DaemonClient } from "./daemon-client.ts";
import { ensureDaemon } from "./index.tsx";
import { attachSession } from "./attach.ts";
import {
  CONSOLE_SCREENS, formatRow, clampCursor, moveCursor, attachTarget,
} from "./console-model.ts";

type Action = { type: "quit" } | { type: "attach"; sessionId: string };

function Console({ client, onAction }: { client: DaemonClient; onAction: (a: Action) => void }) {
  const [screenIdx, setScreenIdx] = useState(0);
  const [rows, setRows] = useState<unknown[]>([]);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { exit } = useApp();
  const screen = CONSOLE_SCREENS[screenIdx]!;

  useEffect(() => {
    let alive = true;
    const load = () => client.request<unknown[]>(screen.request)
      .then((r) => { if (alive) { setRows(Array.isArray(r) ? r : []); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    load();
    const t = setInterval(load, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [screen.request, client]);

  useEffect(() => { setCursor((c) => clampCursor(c, rows.length)); }, [rows.length]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) { onAction({ type: "quit" }); exit(); return; }
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= CONSOLE_SCREENS.length) { setScreenIdx(n - 1); setCursor(0); return; }
    if (key.tab) { setScreenIdx((i) => (i + 1) % CONSOLE_SCREENS.length); setCursor(0); return; }
    if (key.upArrow) { setCursor((c) => moveCursor(c, -1, rows.length)); return; }
    if (key.downArrow) { setCursor((c) => moveCursor(c, +1, rows.length)); return; }
    if (key.return) {
      const sessionId = attachTarget(screen.key, rows, cursor);
      if (sessionId) { onAction({ type: "attach", sessionId }); exit(); }
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{CONSOLE_SCREENS.map((s, i) => (i === screenIdx ? `[${s.label}]` : ` ${s.label} `)).join(" ")}</Text>
      <Box flexDirection="column" marginTop={1}>
        {error ? <Text color="red">error: {error}</Text>
          : rows.length === 0 ? <Text dimColor>{screen.empty}</Text>
            : rows.map((r, i) => <Text key={i} inverse={i === cursor}>{formatRow(screen.key, r)}</Text>)}
      </Box>
      <Text dimColor>{"\n"}1-{CONSOLE_SCREENS.length} screen · tab next · ↑/↓ move · ⏎ attach (SWEEPS) · q quit</Text>
    </Box>
  );
}

async function renderOnce(client: DaemonClient): Promise<Action> {
  let action: Action = { type: "quit" };
  const app = render(<Console client={client} onAction={(a) => { action = a; }} />);
  await app.waitUntilExit();
  return action;
}

/** Launch the console: auto-start the daemon, then render → (attach → re-render) until quit. */
export async function runConsole(): Promise<void> {
  const client = await ensureDaemon();
  try {
    for (;;) {
      const action = await renderOnce(client);
      if (action.type === "quit") return;
      if (action.type === "attach") {
        await Bun.sleep(20); // let Ink restore the terminal before attach takes raw stdin
        await attachSession(client, action.sessionId);
        await Bun.sleep(20); // let attach's reset settle before Ink re-renders
      }
    }
  } finally {
    client.close();
  }
}
