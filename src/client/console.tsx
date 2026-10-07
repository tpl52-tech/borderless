/**
 * Borderless console (PRD §11) — the lead-facing TUI over the daemon reads, styled to the committed design
 * in docs/borderless-console.html: a top bar (brand · crumb · DAEMON/NEED-YOU badges · project), a left nav
 * rail, and a per-screen content area of hero + bordered, colored panels and tables. Screens: SWEEPS,
 * BOARDS, ASSIGN, LEAD DESK, ROSTER, and a plain ASK chat.
 *
 * Number keys / Tab switch screen; on the list screens ↑/↓ move and Enter on a SWEEPS row with a live
 * session attaches to it (Ink suspends for raw passthrough, re-renders on detach — the shared runSurface
 * harness). The SWEEPS queue is polled independently of the active screen so the top bar's "N NEED YOU"
 * badge is always current. The ASK screen is a plain chat (PRD §10): type, Enter runs `ask.run` (advisory —
 * actions need the confirm path, not wired here). q quits on a list screen; Ctrl-C quits anywhere. All
 * derivations (screens, nav, hero stats, partitions, tones, cells, attach target, input editing) live in the
 * pure, tested console-model + theme; this file is thin render + daemon round-trips.
 */

import React, { useEffect, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { type DaemonClient } from "./daemon-client.ts";
import { ensureDaemon, navDirection, runSurface, type SurfaceAction } from "./runtime.ts";
import { PALETTE, toneColor, type Tone } from "./theme.ts";
import {
  CONSOLE_SCREENS, NAV_LABELS, crumbLabel, cell, clampCursor, moveCursor, attachTarget, editInput,
  heroStats, readyRows, needsYouRows, stateTone, kindTone, kindLabel,
  type SweepRow, type BoardRow, type AssignRow, type RosterRow, type DeskRow,
} from "./console-model.ts";

const ASK_IDX = CONSOLE_SCREENS.length; // the ASK tab sits after the five list screens
const ASK_HISTORY = 6; // transcript turns kept on screen
const SWEEP_POLL_MS = 1000;

interface AskResult { answer: string; steps: number; costMicros: number; configured: boolean }

// --- shared chrome -------------------------------------------------------------------------------------

/** One bracketed status pill for the top bar (a bordered box would be three lines tall in a terminal). */
function Badge({ text, tone }: { text: string; tone: Tone }) {
  return <Text color={toneColor(tone)}>[ {text} ]</Text>;
}

function Topbar({ crumb, daemonOk, needsYou }: { crumb: string; daemonOk: boolean | null; needsYou: number }) {
  return (
    <Box
      borderStyle="single" borderColor={PALETTE.line}
      borderTop={false} borderLeft={false} borderRight={false}
      paddingX={1}
    >
      <Text bold color={PALETTE.pink}>BORDERLESS</Text>
      <Text color={PALETTE.dim}> v0.3</Text>
      <Text color={PALETTE.ink2}>   ROOT / </Text>
      <Text color={PALETTE.green}>{crumb}</Text>
      <Box flexGrow={1} />
      <Badge text={daemonOk == null ? "DAEMON …" : daemonOk ? "DAEMON OK" : "DAEMON DOWN"} tone={daemonOk === false ? "red" : daemonOk == null ? "amber" : "green"} />
      {needsYou > 0 ? <><Text> </Text><Badge text={`${needsYou} NEED YOU`} tone="pink" /></> : null}
      <Text color={PALETTE.ink2}>  ReUse · Fall 2026 ▾</Text>
    </Box>
  );
}

function Sidebar({ screenIdx }: { screenIdx: number }) {
  return (
    <Box
      flexDirection="column" width={14} paddingX={1}
      borderStyle="single" borderColor={PALETTE.line}
      borderTop={false} borderBottom={false} borderLeft={false}
    >
      {NAV_LABELS.map((label, i) => {
        const active = i === screenIdx;
        return <Text key={label} color={active ? PALETTE.pink : PALETTE.ink2} bold={active}>{active ? "▎" : " "}{label}</Text>;
      })}
      <Box flexGrow={1} />
      <Text color={PALETTE.dim}>LEAD</Text>
      <Text color={PALETTE.green}>● LIVE</Text>
    </Box>
  );
}

/** A bordered, color-accented panel with a header row (title + optional right-aligned meta). */
function Panel({ title, meta, accent, children }: { title: string; meta?: string; accent?: "green" | "pink"; children: React.ReactNode }) {
  const borderColor = accent === "green" ? PALETTE.green2 : accent === "pink" ? PALETTE.pink2 : PALETTE.line;
  const titleColor = accent === "pink" ? PALETTE.pink : PALETTE.green;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginBottom={1}>
      <Box>
        <Text bold color={titleColor}>{title}</Text>
        {meta ? <><Box flexGrow={1} /><Text color={PALETTE.dim}>{meta}</Text></> : null}
      </Box>
      {children}
    </Box>
  );
}

function Vhead({ title, sub }: { title: string; sub: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={PALETTE.pink}>{title}</Text>
      <Text color={PALETTE.ink2}>{sub}</Text>
    </Box>
  );
}

interface Column<T> { header: string; width: number; align?: "left" | "right"; value: (r: T) => string; tone?: (r: T) => Tone }

/** A columnar table with a dim header row, per-cell tones, and a pink left bar on the selected row. */
function Table<T>({ columns, data, selected }: { columns: Column<T>[]; data: T[]; selected?: number }) {
  // wrap="truncate" keeps every row to one line — a cell cut short by a narrow terminal beats a row that
  // wraps and shears the column grid (cell() already fits content to the column; this guards the overflow).
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text> </Text>
        {columns.map((c, ci) => <Text key={ci} wrap="truncate" color={PALETTE.dim}>{cell(c.header, c.width, c.align)} </Text>)}
      </Box>
      {data.map((r, i) => {
        const sel = i === selected;
        return (
          <Box key={i}>
            <Text color={PALETTE.pink}>{sel ? "▎" : " "}</Text>
            {columns.map((c, ci) => {
              const color = c.tone ? toneColor(c.tone(r)) : sel ? PALETTE.ink : PALETTE.ink2;
              return <Text key={ci} wrap="truncate" color={color} bold={sel && ci === 0}>{cell(c.value(r), c.width, c.align)} </Text>;
            })}
          </Box>
        );
      })}
    </Box>
  );
}

// --- screens -------------------------------------------------------------------------------------------

const SWEEP_COLUMNS: Column<SweepRow>[] = [
  { header: "TICKET", width: 8, value: (r) => r.ticketKey },
  { header: "KIND", width: 7, value: (r) => kindLabel(r.kind), tone: (r) => kindTone(r.kind) },
  { header: "OWNER", width: 9, value: (r) => r.owner ?? "—", tone: () => "ink2" },
  { header: "STATE", width: 12, value: (r) => r.state.toUpperCase(), tone: (r) => stateTone(r.state) },
  { header: "CYC", width: 3, align: "right", value: (r) => String(r.cycles), tone: () => "dim" },
];

function SweepsView({ sweeps, cursor, empty }: { sweeps: SweepRow[]; cursor: number; empty: string }) {
  const stats = heroStats(sweeps);
  const ready = readyRows(sweeps);
  const needs = needsYouRows(sweeps);
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={PALETTE.pink2} paddingX={1} marginBottom={1}>
        <Box>
          <Text bold color={PALETTE.pink}>SWEEP CONSOLE</Text>
          <Box flexGrow={1} />
          {stats.needsYou > 0 ? <Text bold color={PALETTE.pink}>▲ {stats.needsYou}</Text> : null}
        </Box>
        <Text>
          <Text color={PALETTE.ink2}>{stats.inScope} in scope · </Text>
          <Text color={PALETTE.green}>{stats.ready} ready</Text>
          <Text color={PALETTE.ink2}> · </Text>
          <Text color={PALETTE.ink}>{stats.active} active</Text>
          <Text color={PALETTE.ink2}> · </Text>
          <Text color={PALETTE.pink}>{stats.needsYou} need you</Text>
        </Text>
        <Text color={PALETTE.dim}>agents drive to the gate; you decide.</Text>
      </Box>

      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={2} marginRight={1}>
          <Panel title="SWEEP_QUEUE" meta={`${sweeps.length} JOBS`}>
            {sweeps.length === 0
              ? <Text color={PALETTE.dim}>{empty}</Text>
              : <Table columns={SWEEP_COLUMNS} data={sweeps} selected={cursor} />}
          </Panel>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Panel title="READY_TO_MERGE" meta={String(ready.length)} accent="green">
            {ready.length === 0 ? <Text color={PALETTE.dim}>nothing at the gate</Text>
              : ready.map((r) => (
                <Text key={r.ticketKey} wrap="truncate">
                  <Text bold color={PALETTE.green}>{r.ticketKey}</Text>
                  <Text color={PALETTE.ink2}>{r.prNumber != null ? `  PR#${r.prNumber}` : ""}  ⏎ merge</Text>
                </Text>
              ))}
          </Panel>
          <Panel title="NEEDS_YOU" meta={String(needs.length)} accent="pink">
            {needs.length === 0 ? <Text color={PALETTE.dim}>nothing waiting on you</Text>
              : needs.map((r) => (
                <Box key={r.ticketKey} flexDirection="column">
                  <Text wrap="truncate"><Text bold color={PALETTE.pink}>{r.ticketKey}</Text><Text color={PALETTE.dim}>  {r.cycles} cyc</Text></Text>
                  {r.reason ? <Text wrap="truncate" color={PALETTE.ink2}>{r.reason}</Text> : null}
                </Box>
              ))}
          </Panel>
        </Box>
      </Box>
    </Box>
  );
}

function BoardsView({ rows, cursor, empty }: { rows: BoardRow[]; cursor: number; empty: string }) {
  return (
    <Box flexDirection="column">
      <Vhead title="BOARDS" sub="What's workable right now, and what to attack first." />
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} marginRight={1}>
          <Panel title="UNBLOCKED" meta={`${rows.length}`}>
            {rows.length === 0 ? <Text color={PALETTE.dim}>{empty}</Text>
              : <Table columns={[
                { header: "TICKET", width: 8, value: (r: BoardRow) => r.ticketKey },
                { header: "TITLE", width: 24, value: (r: BoardRow) => r.title, tone: () => "ink" },
                { header: "UNBLKS", width: 6, align: "right", value: (r: BoardRow) => String(r.downstream), tone: () => "green" },
              ]} data={rows} selected={cursor} />}
          </Panel>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Panel title="DO NEXT" meta="BY LEVERAGE" accent="pink">
            <Text color={PALETTE.dim}>ranked by downstream work each unblocks.</Text>
            {rows.slice(0, 6).map((r, i) => (
              <Text key={r.ticketKey} wrap="truncate">
                <Text bold color={PALETTE.pink}>{i + 1} </Text>
                <Text color={PALETTE.ink}>{cell(r.ticketKey, 8)} {r.title}</Text>
                <Text color={PALETTE.green}>  +{r.downstream}</Text>
              </Text>
            ))}
          </Panel>
        </Box>
      </Box>
    </Box>
  );
}

function AssignView({ rows, cursor, empty }: { rows: AssignRow[]; cursor: number; empty: string }) {
  return (
    <Box flexDirection="column">
      <Vhead title="ASSIGN" sub="Suggested owner per unblocked ticket — from load, fit, and the do-next order. You approve; nothing auto-assigns." />
      <Panel title="SUGGESTIONS" meta={`${rows.length}`}>
        {rows.length === 0 ? <Text color={PALETTE.dim}>{empty}</Text>
          : <Table columns={[
            { header: "TICKET", width: 8, value: (r: AssignRow) => r.ticketKey },
            { header: "→ SUGGEST", width: 22, value: (r: AssignRow) => r.name, tone: () => "pink" },
            { header: "NETID", width: 8, value: (r: AssignRow) => r.netid, tone: () => "dim" },
            { header: "LOAD", width: 4, align: "right", value: (r: AssignRow) => String(r.load), tone: () => "ink2" },
          ]} data={rows} selected={cursor} />}
      </Panel>
    </Box>
  );
}

function LeadDeskView({ rows, cursor, empty }: { rows: DeskRow[]; cursor: number; empty: string }) {
  return (
    <Box flexDirection="column">
      <Vhead title="LEAD DESK" sub="Ad-hoc lead/ops work handed to another lead — a Lead Ops Linear issue + a Slack DM. The sweeps never touch these." />
      <Panel title="DELEGATED" meta={`${rows.length} OPEN`} accent="pink">
        {rows.length === 0 ? <Text color={PALETTE.dim}>{empty}</Text>
          : rows.map((r, i) => (
            <Text key={r.ticketKey} wrap="truncate">
              <Text color={PALETTE.pink}>{i === cursor ? "▎" : " "}● </Text>
              <Text color={i === cursor ? PALETTE.ink : PALETTE.ink2}>{cell(r.title, 34)}</Text>
              <Text color={PALETTE.amber}> [{r.state}]</Text>
              <Text color={PALETTE.green2}> → {r.assignee}</Text>
            </Text>
          ))}
      </Panel>
    </Box>
  );
}

function RosterView({ rows, cursor, empty }: { rows: RosterRow[]; cursor: number; empty: string }) {
  return (
    <Box flexDirection="column">
      <Vhead title="ROSTER" sub="The team from shared/roster.ts — the Linear↔GitHub↔Slack identity map the sweeps and lead desk resolve people through." />
      <Panel title="MEMBERS" meta={`${rows.length}`}>
        {rows.length === 0 ? <Text color={PALETTE.dim}>{empty}</Text>
          : <Table columns={[
            { header: "NAME", width: 22, value: (r: RosterRow) => r.name, tone: () => "ink" },
            { header: "NETID", width: 8, value: (r: RosterRow) => r.netid, tone: () => "dim" },
            { header: "GITHUB", width: 18, value: (r: RosterRow) => r.github, tone: () => "ink2" },
            { header: "ROLE", width: 6, value: (r: RosterRow) => (r.lead ? "lead" : "member"), tone: (r: RosterRow) => (r.lead ? "pink" : "dim") },
          ]} data={rows} selected={cursor} />}
      </Panel>
    </Box>
  );
}

function AskView({ log, input, busy }: { log: Array<{ q: string; a: string }>; input: string; busy: boolean }) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1} borderStyle="single" borderColor={PALETTE.line} borderTop={false} borderLeft={false} borderRight={false} paddingBottom={0}>
        <Text bold color={PALETTE.ink}>Ask Borderless</Text>
        <Text color={PALETTE.dim}>context: sweeps · boards · roster · PRD</Text>
      </Box>
      {log.length === 0
        ? <Text color={PALETTE.dim}>ask about the fleet — e.g. "what's blocked?" or "who's overloaded?"</Text>
        : log.slice(-ASK_HISTORY).map((t, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Text bold color={PALETTE.pink}>You</Text>
            <Text color={PALETTE.ink}>{t.q}</Text>
            <Text bold color={PALETTE.green}>Borderless</Text>
            <Text color={PALETTE.ink}>{t.a}</Text>
          </Box>
        ))}
      <Box marginTop={1}>
        <Text color={PALETTE.pink}>› </Text>
        <Text color={busy ? PALETTE.dim : PALETTE.ink}>{busy ? "… thinking" : input || " "}</Text>
      </Box>
    </Box>
  );
}

// --- the console -----------------------------------------------------------------------------------------

function Console({ client, onAction }: { client: DaemonClient; onAction: (a: SurfaceAction) => void }) {
  const [screenIdx, setScreenIdx] = useState(0);
  const [sweeps, setSweeps] = useState<SweepRow[]>([]);
  const [rows, setRows] = useState<unknown[]>([]); // the non-SWEEPS list screens
  const [cursor, setCursor] = useState(0);
  const [daemonOk, setDaemonOk] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askInput, setAskInput] = useState("");
  const [askLog, setAskLog] = useState<Array<{ q: string; a: string }>>([]);
  const [askBusy, setAskBusy] = useState(false);
  const { exit } = useApp();

  const onAsk = screenIdx === ASK_IDX;
  const onSweeps = screenIdx === 0;
  const listScreen = onAsk ? null : CONSOLE_SCREENS[screenIdx]!;
  const activeRows: unknown[] = onSweeps ? sweeps : rows; // the list the cursor/attach act on

  // SWEEPS queue, polled independently of the active screen → always-current top-bar badge + daemon health.
  useEffect(() => {
    let alive = true;
    const load = () => client.request<SweepRow[]>("sweep.list")
      .then((r) => { if (alive) { setSweeps(Array.isArray(r) ? r : []); setDaemonOk(true); } })
      .catch(() => { if (alive) setDaemonOk(false); });
    load();
    const t = setInterval(load, SWEEP_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [client]);

  // The active non-SWEEPS list screen's rows (SWEEPS reads from the always-on poll above; ASK has none).
  useEffect(() => {
    if (!listScreen || onSweeps) { setRows([]); setError(null); return; } // no list error while on SWEEPS/ASK
    let alive = true;
    const load = () => client.request<unknown[]>(listScreen.request)
      .then((r) => { if (alive) { setRows(Array.isArray(r) ? r : []); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    load();
    const t = setInterval(load, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [listScreen?.request, onSweeps, client]);

  useEffect(() => { setCursor((c) => clampCursor(c, activeRows.length)); }, [activeRows.length]);

  const submitAsk = (): void => {
    const q = askInput.trim();
    if (!q || askBusy) return;
    setAskBusy(true);
    client.request<AskResult>("ask.run", { question: q, allowActions: false })
      .then((r) => setAskLog((l) => [...l, { q, a: r.configured ? (r.answer || "(no answer)") : "Ask Borderless is off — set a chat backend in ~/.borderless/config.json" }]))
      .catch((e) => setAskLog((l) => [...l, { q, a: `error: ${e instanceof Error ? e.message : String(e)}` }]))
      .finally(() => { setAskInput(""); setAskBusy(false); });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") { onAction({ type: "quit" }); exit(); return; }
    if (key.tab) { setScreenIdx((i) => (i + 1) % NAV_LABELS.length); setCursor(0); return; }
    if (onAsk) {
      if (key.escape) { setScreenIdx(0); setCursor(0); return; } // leave even while a question is in flight
      if (askBusy) return; // ...but ignore typing/submit until it returns
      if (key.return) { submitAsk(); return; }
      setAskInput((v) => editInput(v, input, key));
      return;
    }
    if (input === "q") { onAction({ type: "quit" }); exit(); return; }
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= NAV_LABELS.length) { setScreenIdx(n - 1); setCursor(0); return; }
    const nav = navDirection(input, key);
    if (nav === "up") { setCursor((c) => moveCursor(c, -1, activeRows.length)); return; }
    if (nav === "down") { setCursor((c) => moveCursor(c, +1, activeRows.length)); return; }
    if (key.return) {
      const sessionId = attachTarget(listScreen!.key, activeRows, cursor);
      if (sessionId) { onAction({ type: "attach", sessionId }); exit(); }
      return;
    }
  });

  // One content area per screen. SWEEPS + ASK own their data (always-on poll / chat); the four list screens
  // share the `rows` poll and render a red line on a request error, else their view with its empty-state text.
  const renderContent = (): React.ReactNode => {
    if (onAsk) return <AskView log={askLog} input={askInput} busy={askBusy} />;
    if (onSweeps) return <SweepsView sweeps={sweeps} cursor={cursor} empty={listScreen!.empty} />;
    if (error) return <Text color={PALETTE.red}>error: {error}</Text>;
    const empty = listScreen!.empty;
    switch (screenIdx) {
      case 1: return <BoardsView rows={rows as BoardRow[]} cursor={cursor} empty={empty} />;
      case 2: return <AssignView rows={rows as AssignRow[]} cursor={cursor} empty={empty} />;
      case 3: return <LeadDeskView rows={rows as DeskRow[]} cursor={cursor} empty={empty} />;
      default: return <RosterView rows={rows as RosterRow[]} cursor={cursor} empty={empty} />;
    }
  };

  return (
    <Box flexDirection="column">
      <Topbar crumb={crumbLabel(screenIdx)} daemonOk={daemonOk} needsYou={heroStats(sweeps).needsYou} />
      <Box flexDirection="row">
        <Sidebar screenIdx={screenIdx} />
        <Box flexDirection="column" flexGrow={1} paddingX={1} paddingTop={1}>
          {renderContent()}
        </Box>
      </Box>
      <Box paddingX={1}>
        <Text color={PALETTE.dim}>{onAsk ? "type · ⏎ ask · esc leave · ^C quit" : `1-${NAV_LABELS.length}/tab screen · ↑↓ move · ⏎ attach (SWEEPS) · q quit`}</Text>
      </Box>
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
