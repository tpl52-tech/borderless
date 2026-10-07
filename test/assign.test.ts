import { test, expect, describe } from "bun:test";
import { activeLoads, suggestAssignments } from "../src/shared/assign.ts";
import type { Member } from "../src/shared/roster.ts";
import type { DoNextEntry } from "../src/shared/boards.ts";
import type { LinearIssue } from "../src/shared/types.ts";

const mem = (netid: string, linearIds: string[], name = netid): Member => ({ name, netid, emails: [], linearIds, github: netid });
const entry = (id: string, downstream: number): DoNextEntry => ({
  issue: { id, identifier: id.toUpperCase(), title: `t-${id}`, stateType: "unstarted", blockedBy: [] } as LinearIssue,
  downstream,
});
const iss = (assignee: string | null, stateType = "unstarted"): Pick<LinearIssue, "assignee" | "stateType"> => ({ assignee, stateType });

describe("activeLoads", () => {
  test("counts non-terminal assigned issues per member; excludes terminal/unassigned/unknown", () => {
    const members = [mem("a", ["la1", "la2"]), mem("b", ["lb"])];
    const loads = activeLoads(
      [iss("la1"), iss("la2"), iss("la1", "completed"), iss("lb"), iss(null), iss("unknown"), iss("lb", "canceled")],
      members,
    );
    expect(loads.get("a")).toBe(2); // la1 + la2 (the completed one excluded)
    expect(loads.get("b")).toBe(1); // lb (the canceled one excluded)
  });

  test("a member with no active issues is present with load 0", () => {
    expect(activeLoads([], [mem("a", ["la"])]).get("a")).toBe(0);
  });
});

describe("suggestAssignments (PRD §8)", () => {
  const members = [mem("a", ["la"]), mem("b", ["lb"]), mem("c", ["lc"])];

  test("load-balances across members (equal base → one each, spread not piled)", () => {
    const s = suggestAssignments([entry("t1", 0), entry("t2", 0), entry("t3", 0)], members, new Map([["a", 0], ["b", 0], ["c", 0]]));
    expect(s.map((x) => x.netid).sort()).toEqual(["a", "b", "c"]);
  });

  test("the highest-impact ticket is placed first, to the least-loaded member", () => {
    const s = suggestAssignments([entry("low", 0), entry("high", 9)], members, new Map([["a", 5], ["b", 0], ["c", 2]]));
    expect(s[0]!.ticketKey).toBe("HIGH"); // critical-path first
    expect(s[0]!.netid).toBe("b"); // least loaded
  });

  test("respects base loads — a far-busier member gets nothing until it catches up", () => {
    const s = suggestAssignments([entry("t1", 0), entry("t2", 0)], members, new Map([["a", 0], ["b", 10], ["c", 10]]));
    expect(s.every((x) => x.netid === "a")).toBe(true);
  });

  test("ties break by name", () => {
    const s = suggestAssignments([entry("t1", 0)], [mem("z", ["lz"], "Zoe"), mem("a", ["la"], "Amy")], new Map([["z", 0], ["a", 0]]));
    expect(s[0]!.name).toBe("Amy");
  });

  test("no members → no suggestions", () => {
    expect(suggestAssignments([entry("t1", 0)], [], new Map())).toEqual([]);
  });
});
