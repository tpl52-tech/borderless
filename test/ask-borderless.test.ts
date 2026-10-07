import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import {
  buildFleetContext, FLEET_TOOLS, askBorderless, type FleetToolDeps,
} from "../src/daemon/ask-borderless.ts";
import type { Chat, ChatResponse } from "../src/daemon/openrouter/runner.ts";
import { ROSTER } from "../src/shared/roster.ts";

function tool(name: string) {
  const t = FLEET_TOOLS.find((x) => x.def.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function seeded(): Store {
  const s = new Store(":memory:");
  s.upsertLinearIssue({ id: "u1", identifier: "COR-1", title: "Login", stateName: "In Review", stateType: "started" });
  s.upsertLinearIssue({ id: "u2", identifier: "COR-2", title: "Done thing", stateName: "Done", stateType: "completed" });
  s.upsertLinearIssue({ id: "u5", identifier: "COR-5", title: "Overdue thing", stateName: "In Progress", stateType: "started" });
  // an in-review job stuck waiting on a human
  const j = s.createSweepJob({ kind: "in_review", ticketId: "u9", ticketKey: "COR-9" });
  s.transitionSweepJob(j.id, { state: "needs_human", reason: "no PR found" });
  return s;
}

/** deps with recording fakes for the Linear writes. */
function deps(over: Partial<FleetToolDeps> = {}): FleetToolDeps & { reassigns: any[]; comments: any[] } {
  const reassigns: any[] = [];
  const comments: any[] = [];
  return {
    store: over.store ?? seeded(),
    roster: over.roster ?? ROSTER,
    reassigns, comments,
    reassign: async (ticketKey, assigneeLinearId) => { reassigns.push({ ticketKey, assigneeLinearId }); return `reassigned ${ticketKey}`; },
    comment: async (ticketKey, body) => { comments.push({ ticketKey, body }); return `commented on ${ticketKey}`; },
    ...over,
  };
}

describe("buildFleetContext (PRD §10)", () => {
  test("summarizes sweep states, needs-human jobs, open issues, and the roster", () => {
    const ctx = buildFleetContext(seeded(), { prd: "PRD BODY", handoff: "HANDOFF BODY" });
    expect(ctx).toContain("Sweep jobs by state:");
    expect(ctx).toContain("needs_human: 1");
    expect(ctx).toMatch(/Waiting on a human:\n {2}COR-9 \[in_review\] needs_human cycles=0 — no PR found/);
    expect(ctx).toContain("Open issues: COR-1, COR-5"); // COR-2 (Done) excluded
    expect(ctx).toContain("Roster:");
    expect(ctx).toContain("(tpl52)"); // a real roster member
    expect(ctx).toContain("PRD BODY");
    expect(ctx).toContain("HANDOFF BODY");
  });

  test("clips an over-long doc", () => {
    const ctx = buildFleetContext(new Store(":memory:"), { prd: "x".repeat(9000) });
    expect(ctx).toContain("x".repeat(6000));
    expect(ctx).not.toContain("x".repeat(6001));
  });
});

describe("fleet tools (PRD §10)", () => {
  test("exposes exactly the four §10 fleet action tools", () => {
    expect(FLEET_TOOLS.map((t) => t.def.name).sort()).toEqual(
      ["enqueue_sweep", "post_linear_comment", "reassign_ticket", "resolve_needs_human"]);
  });

  test("enqueue_sweep errors on an unknown kind (no silent in_review fallback)", async () => {
    const d = deps();
    const r = await tool("enqueue_sweep").run({ kind: "inreview" }, d);
    expect(r.isError).toBe(true);
    expect(d.store.listSweepJobs().some((j) => j.ticketKey === "COR-1")).toBe(false); // COR-1 not enqueued
  });

  test("enqueue_sweep in_review queues eligible In Review tickets", async () => {
    const d = deps();
    const r = await tool("enqueue_sweep").run({ kind: "in_review" }, d);
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("COR-1"); // the one In Review, non-lead, non-Lead-Ops issue
    expect(d.store.listSweepJobs({ kind: "in_review" }).some((j) => j.ticketKey === "COR-1")).toBe(true);
  });

  test("enqueue_sweep rescue needs a ticket, then authorizes it", async () => {
    const d = deps();
    expect((await tool("enqueue_sweep").run({ kind: "rescue" }, d)).isError).toBe(true);
    const r = await tool("enqueue_sweep").run({ kind: "rescue", ticket: "COR-5" }, d);
    expect(r.output).toMatch(/rescue COR-5: authorized/);
    expect(d.store.listSweepJobs({ kind: "rescue" }).some((j) => j.ticketKey === "COR-5")).toBe(true);
  });

  test("resolve_needs_human requeues or dismisses, and reports a missing job", async () => {
    const d1 = deps();
    await tool("resolve_needs_human").run({ ticket: "COR-9", action: "requeue" }, d1);
    expect(d1.store.listSweepJobs().find((j) => j.ticketKey === "COR-9")!.state).toBe("queued");

    const d2 = deps();
    await tool("resolve_needs_human").run({ ticket: "COR-9", action: "dismiss" }, d2);
    expect(d2.store.listSweepJobs().find((j) => j.ticketKey === "COR-9")!.state).toBe("failed");

    expect((await tool("resolve_needs_human").run({ ticket: "COR-404", action: "requeue" }, deps())).isError).toBe(true);
  });

  test("reassign_ticket resolves a roster member then calls the live write; unknown member errors", async () => {
    const d = deps();
    const r = await tool("reassign_ticket").run({ ticket: "COR-1", assignee: "ktt38" }, d);
    expect(r.output).toContain("reassigned COR-1");
    expect(d.reassigns[0].ticketKey).toBe("COR-1");
    expect(d.reassigns[0].assigneeLinearId).toBe("5fbc05b9-937e-4301-95c2-9352ad800a75"); // Kenan's Linear id
    await expect(tool("reassign_ticket").run({ ticket: "COR-1", assignee: "nobody" }, d)).rejects.toThrow(/no roster member/i);
  });

  test("post_linear_comment rejects an empty body, else posts", async () => {
    const d = deps();
    expect((await tool("post_linear_comment").run({ ticket: "COR-1", body: "  " }, d)).isError).toBe(true);
    const r = await tool("post_linear_comment").run({ ticket: "COR-1", body: "looks good" }, d);
    expect(r.output).toContain("commented on COR-1");
    expect(d.comments[0]).toEqual({ ticketKey: "COR-1", body: "looks good" });
  });
});

describe("askBorderless orchestration (PRD §10)", () => {
  test("injects the fleet context into the user turn and returns the final answer", async () => {
    let seenSeed = "";
    const chat: Chat = async (messages) => { seenSeed = messages[1]?.content ?? ""; return { text: "All quiet." }; };
    const d = deps();
    const { answer } = await askBorderless("status?", { chat, store: d.store, reassign: d.reassign, comment: d.comment });
    expect(answer).toBe("All quiet.");
    expect(seenSeed).toContain("status?");
    expect(seenSeed).toContain("--- FLEET STATE ---");
    expect(seenSeed).toContain("needs_human: 1");
  });

  test("a consequential tool is blocked when confirm denies (default), and the chat still answers", async () => {
    let turn = 0;
    const chat: Chat = async () => {
      turn++;
      return turn === 1
        ? { toolCalls: [{ id: "t1", name: "enqueue_sweep", args: { kind: "in_review" } }] } as ChatResponse
        : { text: "Blocked — needs your confirmation." };
    };
    const d = deps();
    const before = d.store.listSweepJobs({ kind: "in_review" }).length;
    const { answer, result } = await askBorderless("enqueue the review sweep", { chat, store: d.store, reassign: d.reassign, comment: d.comment });
    expect(d.store.listSweepJobs({ kind: "in_review" }).length).toBe(before); // nothing enqueued
    expect(result.messages.some((m) => m.role === "tool" && m.content.includes("needs the lead's confirmation"))).toBe(true);
    expect(answer).toContain("confirmation");
  });

  test("with confirm granted, the tool runs and changes fleet state", async () => {
    let turn = 0;
    const chat: Chat = async () => {
      turn++;
      return turn === 1
        ? { toolCalls: [{ id: "t1", name: "enqueue_sweep", args: { kind: "in_review" } }] } as ChatResponse
        : { text: "Queued COR-1." };
    };
    const d = deps();
    const { result } = await askBorderless("enqueue it", {
      chat, store: d.store, reassign: d.reassign, comment: d.comment, confirm: async () => true,
    });
    expect(d.store.listSweepJobs({ kind: "in_review" }).some((j) => j.ticketKey === "COR-1")).toBe(true);
    expect(result.messages.some((m) => m.role === "tool" && m.content.includes("COR-1"))).toBe(true);
  });
});
