/**
 * Unix-domain socket server (design §8.2, §8.3, §5.2).
 *
 * Serves the wire protocol (see src/shared/wire.ts). No authentication: filesystem permissions on the
 * socket file are the only protection. On boot: remove a stale socket file then listen (no liveness
 * probe of an old daemon, design §5.2).
 *
 * MILESTONE 1: the request surface for tasks, sessions, attach/detach, and snapshots. The full
 * fan-out rules (work-item suppression while attached, per-socket Linear events) and the rest of the
 * request surface arrive with their subsystems (build steps 2+).
 */

import { existsSync, unlinkSync } from "node:fs";
import {
  FrameKind, FrameDecoder, createFrameWriter, controlFrame, parseControl, parseResize,
  ptyOutputFrame, type Frame, type FrameWriter, type ControlRequest, type ControlEvent,
} from "../shared/wire.ts";
import { doNext } from "../shared/boards.ts";
import { activeLoads, suggestAssignments } from "../shared/assign.ts";
import { deskOverview, type DelegateRequest, type DelegateResult } from "../shared/lead-desk.ts";
import { ROSTER, buildRosterIndexes } from "../shared/roster.ts";
import type { Store } from "./store.ts";
import type { SessionManager } from "./session-manager.ts";
import type { WorkItemMonitor } from "./monitors/work-item.ts";
import type { NudgeDelivery } from "./nudge/index.ts";

interface ConnState {
  decoder: FrameDecoder;
  writer: FrameWriter;
  attachedSessionId: string | null;
  unsubscribe: (() => void) | null;
}

export interface UdsServerDeps {
  store: Store;
  manager: SessionManager;
  monitor: WorkItemMonitor;
  nudge: NudgeDelivery;
  autonomyState: () => unknown;
  extendAutonomy: (hours: number) => { until: number };
  /** Build order #2/#3c: refresh linear_issues (if configured), enqueue in-review sweep jobs, then run them. */
  scanInReview: (stateName?: string) => Promise<{ synced: number; created: number; started: number }>;
  /** Build order #4b: the Rescues queue — eligible overdue tickets (PRD §5). */
  rescueScan: () => Promise<Array<{ ticketId: string; ticketKey: string; title: string; daysOverdue: number }>>;
  /** Build order #4b: authorize a rescue for one ticket (id or identifier) → a rescue sweep_job + run it. */
  rescueAuthorize: (ticket: string) => { ticketKey: string; created: boolean; started: boolean };
  /** PRD §9: the lead-desk project name whose issues are excluded from the sweeps and shown on the desk. */
  leadOpsProject?: string;
  /** PRD §9: delegate a captured task → a Lead Ops issue assigned to the member + a best-effort Slack DM. */
  leadDelegate: (req: DelegateRequest) => Promise<DelegateResult>;
  /** PRD §10: Ask Borderless — answer over live fleet state; allowActions confirms the (consequential) tools. */
  askRun: (question: string, allowActions: boolean) => Promise<{ answer: string; steps: number; costMicros: number; configured: boolean }>;
}

export interface UdsServer {
  broadcast(event: ControlEvent): void;
  /** true iff any client is currently attached (isBusy, design §5.1). */
  isBusy(): boolean;
  stop(): void;
}

export function startUdsServer(socketPath: string, deps: UdsServerDeps): UdsServer {
  const { store, manager, monitor, nudge } = deps;
  const conns = new Set<ConnState>();

  if (existsSync(socketPath)) unlinkSync(socketPath); // stale socket, no liveness probe (§5.2)

  const server = Bun.listen<ConnState>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = {
          decoder: new FrameDecoder(),
          writer: createFrameWriter(socket),
          attachedSessionId: null,
          unsubscribe: null,
        };
        conns.add(socket.data);
      },
      data(socket, chunk) {
        const conn = socket.data;
        for (const frame of conn.decoder.push(chunk)) {
          try {
            handleFrame(conn, frame);
          } catch (err) {
            // A malformed frame should never take the daemon down.
            console.error("uds: frame handling error:", err);
          }
        }
      },
      drain(socket) {
        socket.data.writer.flush();
      },
      close(socket) {
        teardown(socket.data);
      },
      error(socket, err) {
        console.error("uds: socket error:", err);
        teardown(socket.data);
      },
    },
  });

  function teardown(conn: ConnState): void {
    conn.unsubscribe?.();
    conn.unsubscribe = null;
    conn.attachedSessionId = null;
    conns.delete(conn);
  }

  function handleFrame(conn: ConnState, frame: Frame): void {
    switch (frame.kind) {
      case FrameKind.Control: {
        const msg = parseControl(frame.payload);
        if (msg.msg === "request") void respond(conn, msg);
        return;
      }
      case FrameKind.PtyInput: {
        if (frame.sessionId) manager.write(frame.sessionId, frame.payload);
        return;
      }
      case FrameKind.PtyResize: {
        if (frame.sessionId) {
          const { cols, rows } = parseResize(frame.payload);
          manager.resize(frame.sessionId, cols, rows);
        }
        return;
      }
      default:
        return; // PtyOutput is daemon->client only; ignore inbound
    }
  }

  async function respond(conn: ConnState, req: ControlRequest): Promise<void> {
    try {
      const data = await dispatch(conn, req);
      conn.writer.write(controlFrame({ msg: "response", id: req.id, ok: true, data }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      conn.writer.write(controlFrame({ msg: "response", id: req.id, ok: false, error }));
    }
  }

  function dispatch(conn: ConnState, req: ControlRequest): unknown {
    const p = (req.params ?? {}) as Record<string, any>;
    switch (req.type) {
      // --- tasks ---
      case "task.list":
        return store.listTasks(p.includeClosed ?? true);
      case "task.create":
        return store.createTask({ name: p.name, description: p.description });
      case "task.update":
        return store.updateTask(p.id, { name: p.name, description: p.description });
      case "task.close":
        store.closeTask(p.id);
        return { ok: true };
      case "task.reopen":
        store.reopenTask(p.id);
        return { ok: true };

      // --- sessions ---
      case "session.list":
        return store.listSessions({ taskId: p.taskId, includeClosed: p.includeClosed })
          .map((s) => ({ ...s, status: manager.status(s.id) }));
      case "session.spawn":
        return manager.spawn(p as any);
      case "session.rename":
        return store.updateSession(p.id, { title: p.title });
      case "session.setPlanning": {
        const updated = store.updateSession(p.id, { planning: !!p.planning });
        if (p.planning) nudge.clearAutonomous(p.id); // manual survive (§10.6)
        return updated;
      }
      case "session.nudge":
        return nudge.enqueue({ sessionId: p.sessionId, body: String(p.body ?? ""), manual: true, settleKeys: p.settle });
      case "session.resume":
        manager.resume(p.sessionId, sizeOf(p));
        return { ok: true };
      case "session.kill":
        manager.kill(p.sessionId);
        return { ok: true };
      case "session.close":
        manager.kill(p.sessionId);
        nudge.forget(p.sessionId);
        store.closeSession(p.sessionId);
        return { ok: true };
      case "session.remove":
        manager.kill(p.sessionId);
        manager.forget(p.sessionId);
        nudge.forget(p.sessionId);
        store.removeSession(p.sessionId);
        return { ok: true };
      case "session.interrupt":
        manager.write(p.sessionId, new Uint8Array([0x1b])); // bare ESC, no CR (design §10.8)
        return { ok: true };
      case "session.attach":
        return attach(conn, p.sessionId, sizeOf(p));
      case "session.detach":
        detach(conn);
        return { ok: true };

      // --- work items ---
      case "workitem.list":
        return p.sessionId ? store.listWorkItemsBySession(p.sessionId, !!p.includeRetired)
          : store.listActiveWorkItems();
      case "workitem.refresh":
        return monitor.pollSession(p.sessionId).then(() => store.listWorkItemsBySession(p.sessionId));
      case "workitem.add":
        return monitor.addManual(p.sessionId, p.ref).then(() => store.listWorkItemsBySession(p.sessionId));
      case "workitem.remove":
        store.removeWorkItem(p.id);
        return { ok: true };

      // --- autonomy ---
      case "autonomy.log":
        return store.listActions(p.limit ?? 40);
      case "autonomy.extend":
        return deps.extendAutonomy(Number(p.hours ?? 2));

      // --- sweeps ---
      case "sweep.scanInReview":
        return deps.scanInReview(typeof p.stateName === "string" ? p.stateName : undefined);
      case "rescue.scan":
        return deps.rescueScan();
      case "rescue.authorize":
        return deps.rescueAuthorize(String(p.ticket ?? ""));

      // --- boards + assignment (PRD §7-§8): pure reads over synced linear_issues + roster, no live I/O ---
      case "boards.get":
        return doNext(store.listLinearIssues()).map((e) => ({
          ticketKey: e.issue.identifier, title: e.issue.title, downstream: e.downstream,
        }));
      case "assign.suggest": {
        const issues = store.listLinearIssues();
        return suggestAssignments(doNext(issues), ROSTER, activeLoads(issues, ROSTER))
          .map((s) => ({ ticketKey: s.ticketKey, netid: s.netid, name: s.name, load: s.load }));
      }

      // --- lead desk (PRD §9): open Lead Ops tasks, a plain human task list (no gate, no agent) ----------
      case "lead.desk":
        return deskOverview(store.listLinearIssues(), ROSTER, deps.leadOpsProject);
      case "lead.delegate":
        return deps.leadDelegate({ who: String(p.who ?? ""), title: String(p.title ?? ""), notes: typeof p.notes === "string" ? p.notes : undefined });
      case "ask.run":
        return deps.askRun(String(p.question ?? ""), p.allowActions === true);

      // --- console reads (PRD §11 Ink TUI): plain reads for the SWEEPS + ROSTER screens -----------------
      case "sweep.list": {
        const byLinearId = buildRosterIndexes(ROSTER).byLinearId;
        const ownerOf = (assignee: string | null): string | null =>
          assignee ? (byLinearId.get(assignee)?.name.split(" ")[0] ?? assignee) : null; // first name, else raw id
        return store.listSweepJobs().map((j) => ({
          ticketKey: j.ticketKey, kind: j.kind, state: j.state, owner: ownerOf(j.assignee),
          prNumber: j.prNumber, cycles: j.cycles, reason: j.reason, sessionId: j.sessionId,
        }));
      }
      case "roster.get":
        return ROSTER.map((m) => ({ name: m.name, netid: m.netid, github: m.github, lead: Boolean(m.lead) }));

      // --- usage / quota ---
      case "usage.get":
        return store.usageTotals();
      case "quota.get":
        return {}; // live-only in M8 (design §15.3)

      // --- snapshot ---
      case "snapshot.get":
        return snapshot();

      default:
        throw new Error(`unsupported request: ${req.type}`);
    }
  }

  async function attach(conn: ConnState, sessionId: string, size?: { cols: number; rows: number }): Promise<unknown> {
    detach(conn); // one attachment per connection
    const pty = manager.resume(sessionId, size);
    // Register the output listener BEFORE repaint (design §8.4), then paint: the local replay buffer,
    // or — for a devbox session — a fresh tmux capture (never the recorded cursor-relative bytes).
    conn.unsubscribe = pty.addOutputListener((bytes) => {
      conn.writer.write(ptyOutputFrame(sessionId, bytes));
    });
    conn.attachedSessionId = sessionId;
    const paint = await manager.repaintBytes(sessionId);
    if (paint.length) conn.writer.write(ptyOutputFrame(sessionId, paint));
    // A live session keeps its spawn-time geometry — resume() returns the existing PTY and never resizes
    // it — so without this the agent renders in its original 80x24 box. Match the attaching terminal; the
    // resulting SIGWINCH makes the agent redraw full-size through the listener we just registered (§8.4).
    if (size) manager.resize(sessionId, size.cols, size.rows);
    return { ok: true, attached: sessionId };
  }

  function detach(conn: ConnState): void {
    conn.unsubscribe?.();
    conn.unsubscribe = null;
    conn.attachedSessionId = null;
  }

  function snapshot(): unknown {
    const tasks = store.listTasks(true);
    const sessions = store.listSessions({ includeClosed: false })
      .map((s) => ({ ...s, status: manager.status(s.id) }));
    const workItems = store.listActiveWorkItems();
    const usageBySession: Record<string, number> = {};
    for (const u of store.usageTotals()) {
      if (u.costMicros != null) usageBySession[u.sessionId] = (usageBySession[u.sessionId] ?? 0) + u.costMicros;
    }
    return { tasks, sessions, workItems, usage: usageBySession, autonomy: deps.autonomyState(), now: Date.now() };
  }

  return {
    broadcast(event) {
      const frame = controlFrame({ msg: "event", ...event });
      for (const conn of conns) conn.writer.write(frame);
    },
    isBusy() {
      for (const conn of conns) if (conn.attachedSessionId) return true;
      return false;
    },
    stop() {
      server.stop(true);
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch { /* already gone */ }
      }
    },
  };
}

function sizeOf(p: Record<string, any>): { cols: number; rows: number } | undefined {
  return p.cols && p.rows ? { cols: p.cols, rows: p.rows } : undefined;
}
