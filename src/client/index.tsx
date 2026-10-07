/**
 * TUI client entry (`ao`) — a thin Ink app (design §3.1, §19).
 *
 * MILESTONE 2 dashboard: a flat, HUMAN-ORDERED list of tasks and their sessions — never re-sorted by
 * urgency or recency (rows must not move under the cursor, §19). Each task shows a rollup glyph (the
 * highest-attention session status, §10.1); each session shows its status glyph, title, tool:model,
 * location, worktree/planning badges. Live status arrives via `session.status` events on top of a 1s
 * poll. Navigate with the arrows, Enter to attach (Ink suspends for raw passthrough, re-renders on
 * detach), n new task, a add agent, x close, r refresh, q quit. PR rows, usage/quota, and the focus
 * view arrive with their subsystems (build steps 5+).
 */

import React, { useEffect, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { type DaemonClient } from "./daemon-client.ts";
import { ensureDaemon, navDirection, openUrl, runSurface, type SurfaceAction } from "./runtime.ts";
import { statusStyle, taskRollupStatus } from "../shared/status.ts";
import { classifyWorkItem, type WorkItemFocus } from "../shared/focus.ts";
import { DEFAULT_REVIEW_POLICY } from "../shared/profile.ts";
import type { Task, Session, SessionStatus, WorkItem, CodexReviewState, CtoState, AutonomyAction } from "../shared/types.ts";

type SessionView = Session & { status: SessionStatus };
interface AutonomyState { enabled: boolean; dryRun: boolean; killed: boolean; window: string }
interface Snapshot { tasks: Task[]; sessions: SessionView[]; workItems: WorkItem[]; usage?: Record<string, number>; autonomy?: AutonomyState; now?: number }
type Action = SurfaceAction;

type Row =
  | { kind: "task"; task: Task; rollup: SessionStatus | null }
  | { kind: "session"; session: SessionView }
  | { kind: "workitem"; item: WorkItem };

function buildRows(snap: Snapshot): Row[] {
  const rows: Row[] = [];
  for (const task of snap.tasks) {
    if (task.status === "closed") continue; // closing a task removes it from the list (x = close/archive)
    const sessions = snap.sessions.filter((x) => x.taskId === task.id);
    rows.push({ kind: "task", task, rollup: taskRollupStatus(sessions.map((s) => s.status)) });
    for (const s of sessions) {
      rows.push({ kind: "session", session: s });
      for (const item of snap.workItems.filter((w) => w.sessionId === s.id)) {
        rows.push({ kind: "workitem", item });
      }
    }
  }
  return rows;
}

const EMPTY: Snapshot = { tasks: [], sessions: [], workItems: [] };

const CODEX_GLYPH: Record<CodexReviewState, string> = {
  approved: "✓", reviewed: "◐", requested: "…", none: "—",
};
const CTO_GLYPH: Record<CtoState, string> = {
  approved: "✓", "stale-approval": "✓~", "changes-requested": "✗", "commented-after-approval": "✓!",
  reviewed: "◐", requested: "…", none: "—",
};

function TaskRow({ row, selected }: { row: Extract<Row, { kind: "task" }>; selected: boolean }) {
  const marker = selected ? "› " : "  ";
  const style = row.rollup ? statusStyle(row.rollup) : null;
  return (
    <Text color={selected ? "cyan" : undefined} bold>
      {marker}
      {style
        ? <Text color={style.color} dimColor={style.dim}>{style.glyph} </Text>
        : <Text dimColor>▸ </Text>}
      {row.task.name}
      {row.task.status === "closed" ? <Text dimColor> (closed)</Text> : null}
    </Text>
  );
}

function SessionRow({ s, selected, costMicros }: { s: SessionView; selected: boolean; costMicros?: number }) {
  const marker = selected ? "› " : "  ";
  const style = statusStyle(s.status);
  return (
    <Text color={selected ? "cyan" : undefined}>
      {marker}    <Text color={style.color} dimColor={style.dim}>{style.glyph}</Text>{" "}
      {s.title || s.id.slice(0, 8)}
      <Text dimColor> · {s.tool}:{s.model} · {s.location}{s.usesWorktree ? " wt" : ""}</Text>
      {" "}<Text color={style.color} dimColor={style.dim}>{style.label}</Text>
      {s.planning ? <Text color="magenta"> ·planning</Text> : null}
      {costMicros ? <Text dimColor> · ${(costMicros / 1_000_000).toFixed(2)}</Text> : null}
    </Text>
  );
}

function CiCell({ item }: { item: WorkItem }) {
  if (item.ciState === "success") return <Text color="green">CI ✓</Text>;
  if (item.ciState === "pending") return <Text color="yellow">CI …</Text>;
  if (item.ciState === "failure") {
    const first = item.failedChecks[0] ?? "failing";
    const extra = item.failedChecks.length > 1 ? `+${item.failedChecks.length - 1}` : "";
    return <Text color="red">CI ✗ {first}{extra}</Text>;
  }
  return <Text dimColor>CI ?</Text>;
}

function PrRow({ item, selected }: { item: WorkItem; selected: boolean }) {
  const marker = selected ? "› " : "  ";
  const num = item.number != null ? `#${item.number}` : item.externalKey;
  return (
    <Text color={selected ? "cyan" : undefined}>
      {marker}      <Text dimColor>{num}</Text> {item.title || ""}
      {item.isDraft ? <Text dimColor> draft</Text> : null}
      {item.mergeable === "CONFLICTING" ? <Text color="red"> conflicts</Text> : null}
      {"  "}<CiCell item={item} />
      {item.unresolvedComments > 0 ? <Text color="yellow">  {item.unresolvedComments} unresolved</Text> : null}
      {item.codexState ? <Text dimColor>  codex {CODEX_GLYPH[item.codexState]}</Text> : null}
      {item.ctoState ? <Text dimColor>  cto {CTO_GLYPH[item.ctoState]}</Text> : null}
      {item.reviewBotState === "reviewed" ? <Text color="yellow">  rev ◐</Text> : null}
    </Text>
  );
}

// Section label + color, and which focuses fall into it (final-ready + ready-to-merge share one).
const FOCUS_SECTIONS: Array<[label: string, color: string, focuses: WorkItemFocus[]]> = [
  ["READY TO MERGE", "green", ["final-ready", "ready-to-merge"]],
  ["NEEDS ATTENTION", "red", ["needs-attention"]],
  ["WAITING REVIEW", "yellow", ["waiting-review"]],
  ["IN PROGRESS", "gray", ["in-progress"]],
];

function FocusView({ snap, now }: { snap: Snapshot; now: number }) {
  const byFocus = new Map<WorkItemFocus, WorkItem[]>();
  for (const item of snap.workItems) {
    if (item.kind !== "pr") continue;
    const f = classifyWorkItem(item, now, DEFAULT_REVIEW_POLICY);
    const list = byFocus.get(f) ?? [];
    list.push(item);
    byFocus.set(f, list);
  }
  return (
    <Box flexDirection="column">
      <Text bold>focus <Text dimColor>(f to close)</Text></Text>
      {FOCUS_SECTIONS.map(([label, color, focuses]) => {
        const items = focuses.flatMap((f) => byFocus.get(f) ?? []);
        if (items.length === 0) return null;
        return (
          <Box key={label} flexDirection="column" marginTop={1}>
            <Text color={color} bold>{label}</Text>
            {items.map((it) => (
              <Text key={it.id}>  {it.number != null ? `#${it.number}` : it.externalKey} {it.title || ""}</Text>
            ))}
          </Box>
        );
      })}
      {snap.workItems.length === 0 && <Text dimColor>no PRs tracked yet</Text>}
    </Box>
  );
}

const ACTION_COLOR: Record<string, string> = {
  performed: "green", queued: "cyan", "dry-run": "gray", suppressed: "gray", failed: "red",
  undelivered: "yellow", cancelled: "gray",
};

function ActivityView({ client }: { client: DaemonClient }) {
  const [rows, setRows] = useState<AutonomyAction[]>([]);
  useEffect(() => {
    const load = () => client.request<AutonomyAction[]>("autonomy.log", { limit: 30 }).then(setRows).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [client]);
  return (
    <Box flexDirection="column">
      <Text bold>activity <Text dimColor>(A to close)</Text></Text>
      {rows.length === 0 && <Text dimColor>no autonomy actions yet</Text>}
      {rows.map((r) => (
        <Text key={r.id}>
          <Text color={ACTION_COLOR[r.status] ?? undefined}>{r.status.padEnd(11)}</Text>
          {" "}{r.action}
          {r.gate ? <Text dimColor> [{r.gate}]</Text> : null}
          {r.reason ? <Text dimColor> · {r.reason}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

function Dashboard({ client, onAction }: { client: DaemonClient; onAction: (a: Action) => void }) {
  const { exit } = useApp();
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<"list" | "newTask" | "nudge">("list");
  const [draft, setDraft] = useState("");
  const [nudgeTarget, setNudgeTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusOpen, setFocusOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);

  const refresh = async () => {
    try { setSnap(await client.request<Snapshot>("snapshot.get")); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 1000);
    const off = client.on((ev) => {
      if (ev.type === "session.status" || ev.type === "session.exit" ||
          ev.type === "workitems.changed" || ev.type === "autonomy.acted") {
        void refresh();
      }
    });
    return () => { clearInterval(t); off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = buildRows(snap);
  const clamped = Math.min(cursor, Math.max(0, rows.length - 1));
  const current = rows[clamped];

  const taskFor = (): Task | undefined =>
    current?.kind === "task" ? current.task
      : current?.kind === "session" ? snap.tasks.find((t) => t.id === current.session.taskId)
      : undefined;

  useInput((input, key) => {
    if (mode === "newTask" || mode === "nudge") {
      if (key.escape) { setMode("list"); setDraft(""); setNudgeTarget(null); return; }
      if (key.return) {
        const text = draft.trim();
        const m = mode; const target = nudgeTarget;
        setMode("list"); setDraft(""); setNudgeTarget(null);
        if (text && m === "newTask") client.request("task.create", { name: text }).then(refresh).catch(() => {});
        if (text && m === "nudge" && target) client.request("session.nudge", { sessionId: target, body: text }).catch((e) => setError(String(e)));
        return;
      }
      if (key.backspace || key.delete) { setDraft((d) => d.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setDraft((d) => d + input);
      return;
    }

    if (input === "q" || (key.ctrl && input === "c")) { onAction({ type: "quit" }); exit(); return; }
    if (input === "f") { setFocusOpen((v) => !v); return; }
    if (input === "A") { setActivityOpen((v) => !v); return; }
    if (input === "E") { client.request("autonomy.extend", { hours: 2 }).then(refresh).catch(() => {}); return; }
    if (focusOpen || activityOpen) return; // overlays are read-only
    const nav = navDirection(input, key);
    if (nav === "up") { setCursor((c) => Math.max(0, c - 1)); return; }
    if (nav === "down") { setCursor((c) => Math.min(rows.length - 1, c + 1)); return; }
    if (input === "r") { void refresh(); return; }
    if (input === "n") { setMode("newTask"); return; }

    if (current?.kind === "task") {
      if (input === "x") {
        const closing = current.task.status !== "closed";
        client.request(closing ? "task.close" : "task.reopen", { id: current.task.id }).then(refresh).catch((e) => setError(String(e)));
        return;
      }
    }

    if (current?.kind === "workitem") {
      if (key.return && current.item.url) { openUrl(current.item.url); return; }
      if (input === "x") { client.request("workitem.remove", { id: current.item.id }).then(refresh).catch(() => {}); return; }
    }

    if (input === "a") {
      const task = taskFor();
      if (task) {
        client.request("session.spawn", {
          taskId: task.id, tool: "claude", location: "local", cwd: process.cwd(),
          model: "auto", permissions: "full-access", usesWorktree: false,
          cols: process.stdout.columns, rows: process.stdout.rows, // start at the real terminal size
        }).then(refresh).catch((e) => setError(String(e)));
      }
      return;
    }

    if (current?.kind === "session") {
      if (key.return) { onAction({ type: "attach", sessionId: current.session.id }); exit(); return; }
      if (input === "m") { setMode("nudge"); setNudgeTarget(current.session.id); return; }
      if (input === "i") { client.request("session.setPlanning", { id: current.session.id, planning: !current.session.planning }).then(refresh).catch(() => {}); return; }
      if (input === "x") {
        client.request("session.close", { sessionId: current.session.id }).then(refresh).catch(() => {});
        return;
      }
    }
  });

  const openTasks = snap.tasks.filter((t) => t.status === "open").length;

  if (focusOpen) return <FocusView snap={snap} now={snap.now ?? Date.now()} />;
  if (activityOpen) return <ActivityView client={client} />;

  const auto = snap.autonomy;
  const autoBadge = !auto ? "" : (auto.killed || !auto.enabled) ? "off" : auto.dryRun ? "·dry" : "auto";
  const autoColor = autoBadge === "auto" ? "green" : autoBadge === "·dry" ? "yellow" : "gray";

  return (
    <Box flexDirection="column">
      <Text bold>
        borderless <Text dimColor>· {openTasks} open · {snap.sessions.length} sessions · {snap.workItems.length} PRs</Text>
        {auto ? <Text> · <Text color={autoColor}>{autoBadge}</Text> <Text dimColor>{auto.window}</Text></Text> : null}
      </Text>
      {rows.length === 0 && <Text dimColor>no tasks yet — press n to create one</Text>}
      {rows.map((row, idx) =>
        row.kind === "task"
          ? <TaskRow key={`t-${row.task.id}`} row={row} selected={idx === clamped} />
          : row.kind === "session"
            ? <SessionRow key={`s-${row.session.id}`} s={row.session} selected={idx === clamped} costMicros={snap.usage?.[row.session.id]} />
            : <PrRow key={`w-${row.item.id}`} item={row.item} selected={idx === clamped} />,
      )}
      {mode === "newTask" && <Text>new task name: {draft}▌</Text>}
      {mode === "nudge" && <Text color="magenta">nudge: {draft}▌</Text>}
      {error && <Text color="red">{error}</Text>}
      <Text dimColor>↑/↓ · enter attach/open · n task · a agent · m nudge · i planning · x close · f focus · A activity · E extend · r · q</Text>
    </Box>
  );
}

export async function main(): Promise<void> {
  const client = await ensureDaemon();
  try {
    await runSurface(client, (onAction) => render(<Dashboard client={client} onAction={onAction} />));
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
