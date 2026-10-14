import { test, expect, describe } from "bun:test";
import {
  fixMarker, shouldCloseFeature, buildFixTitle, buildFixBody, buildFixTicketInput, decideFix, actionableVerdicts,
  QA_FIX_LABEL, QA_BLOCKED_LABEL,
} from "../src/shared/verify-qa-fix.ts";
import type { QaVerdictRow } from "../src/shared/verify-qa-sync.ts";

const AT = 1760054400000;
const row = (verdict: QaVerdictRow["verdict"], run: Partial<QaVerdictRow["run"]> = {}): QaVerdictRow =>
  ({ ticketKey: "COR-91", verdict, verdictAt: AT, run: { verdict, verdictBy: "dana", verdictAt: AT, ...run } });

describe("shouldCloseFeature", () => {
  test("closes an open feature on a pass, never one already completed/canceled or of unknown state", () => {
    expect(shouldCloseFeature("started")).toBe(true);
    expect(shouldCloseFeature("unstarted")).toBe(true); // Todo but QA-verified → Done
    expect(shouldCloseFeature("backlog")).toBe(true);
    expect(shouldCloseFeature("triage")).toBe(true);
    expect(shouldCloseFeature(null)).toBe(false); // unknown state → cautious
    expect(shouldCloseFeature("completed")).toBe(false);
    expect(shouldCloseFeature("canceled")).toBe(false);
  });
});

describe("buildFixTitle", () => {
  test("distinguishes a fix from a block, and tolerates an empty title", () => {
    expect(buildFixTitle("fix", "Search results list")).toBe("Fix: Search results list (QA failed)");
    expect(buildFixTitle("blocked", "Login screen")).toBe("QA blocked: Login screen");
    expect(buildFixTitle("fix", "   ")).toBe("Fix: untitled (QA failed)");
  });
});

describe("buildFixBody", () => {
  const links = { parentKey: "COR-17", subKey: "COR-91" };

  test("a fail body records the failure, the failed-step notes, the provenance, and the marker", () => {
    const body = buildFixBody("fix", row("fail", { steps: { "1": "pass", "2": "fail", "3": "fail" }, notes: { "2": "button did nothing", "3": "  " } }), links);
    expect(body).toContain("**failed**");
    expect(body).toContain("recorded by Dana");
    expect(body).toContain("Steps: 1 passed, 2 failed.");
    expect(body).toContain("- Step 2: button did nothing");
    expect(body).not.toContain("Step 3:"); // blank note dropped
    expect(body).toContain("From the manual-QA run sheet COR-91, under COR-17.");
    expect(body).toContain(fixMarker(AT));
  });

  test("a blocked body reads as blocked, not failed", () => {
    const body = buildFixBody("blocked", row("blocked"), links);
    expect(body).toContain("**blocked**");
    expect(body).not.toContain("Steps:");
    expect(body).toContain(fixMarker(AT));
  });
});

describe("buildFixTicketInput", () => {
  const base = { teamId: "t1", projectId: "p1", parentId: "u17", labelId: "lfix", title: "T", description: "D" };

  test("an unassigned, labelled child in the feature ticket's project", () => {
    const input = buildFixTicketInput(base);
    expect(input).toMatchObject({ teamId: "t1", projectId: "p1", parentId: "u17", labelIds: ["lfix"], title: "T", description: "D", assigneeId: null });
  });

  test("opens in the given Todo state when one is passed, else the team default (omitted)", () => {
    expect(buildFixTicketInput({ ...base, stateId: "todo-1" }).stateId).toBe("todo-1");
    expect(buildFixTicketInput(base).stateId).toBeUndefined();
  });

  test("inherits a real priority, omits None/absent", () => {
    expect(buildFixTicketInput({ ...base, parentPriority: 2 }).priority).toBe(2);
    expect(buildFixTicketInput({ ...base, parentPriority: 0 }).priority).toBeUndefined(); // 0 = None
    expect(buildFixTicketInput({ ...base, parentPriority: null }).priority).toBeUndefined();
  });
});

describe("decideFix", () => {
  test("a fail → a fix ticket (the feature ticket is not moved)", () => {
    expect(decideFix(row("fail"), { childDescriptions: [] })).toEqual({ alreadyExists: false, kind: "fix" });
  });

  test("a blocked → a blocked ticket", () => {
    expect(decideFix(row("blocked"), { childDescriptions: [] })).toEqual({ alreadyExists: false, kind: "blocked" });
  });

  test("idempotent: a child already carrying this verdict's marker → alreadyExists", () => {
    const bodies = [`some fix ticket\n_ref ${fixMarker(AT)}_`];
    expect(decideFix(row("fail"), { childDescriptions: bodies }).alreadyExists).toBe(true);
  });

  test("a different verdict instance (new verdictAt) is NOT considered existing", () => {
    const bodies = [`_ref ${fixMarker(AT - 1)}_`];
    expect(decideFix(row("fail"), { childDescriptions: bodies }).alreadyExists).toBe(false);
  });
});

describe("actionableVerdicts", () => {
  test("keeps every real verdict (FAIL + PASS + BLOCKED), drops the __probe row", () => {
    const rows = actionableVerdicts([
      { ticket_id: "COR-91", run: { verdict: "fail", verdictAt: AT } },
      { ticket_id: "COR-94", run: { verdict: "pass", verdictAt: AT } },
      { ticket_id: "COR-95", run: { verdict: "blocked", verdictAt: AT } },
      { ticket_id: "__probe", run: { verdict: "fail", verdictAt: AT } },
    ]);
    expect(rows.map((r) => `${r.ticketKey}:${r.verdict}`)).toEqual(["COR-91:fail", "COR-94:pass", "COR-95:blocked"]);
  });
});

describe("label constants", () => {
  test("the two kinds carry distinct labels", () => {
    expect([QA_FIX_LABEL, QA_BLOCKED_LABEL]).toEqual(["qa-fix", "qa-blocked"]);
  });
});
