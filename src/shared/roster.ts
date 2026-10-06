/**
 * Team roster — Linear <-> GitHub <-> Slack identity map (lead-console PRD §5).
 *
 * Slack users are NOT stored statically: resolve each at runtime via
 * `slack.users.lookupByEmail`, trying `emails` in order, then falling back to a
 * display-name match (names are identical across Linear and Slack), then skipping
 * the DM (the Linear comment still posts). Built 2026-10-06 from the
 * "Cornell EWB SoftDev" Linear workspace; Slack handles are resolved, never hard-coded.
 */

/** One person, across Linear, GitHub, and Slack. */
export interface Member {
  /** Display name — matches the Slack full name (the name-match fallback). */
  name: string;
  /** Cornell netid. */
  netid: string;
  /** Emails to try against slack.users.lookupByEmail, in order (cornell first). */
  emails: string[];
  /** Every Linear account id for this person (Dana Ryu has two). */
  linearIds: string[];
  /** GitHub login. */
  github: string;
  /** Software-dev lead. */
  lead?: boolean;
}

export const ROSTER: Member[] = [
  { name: "Hyunsuh (Tess) Lee", netid: "tpl52", emails: ["tpl52@cornell.edu"], linearIds: ["b21d8c6e-f3a3-4894-979f-0e8619ca9f48"], github: "tpl52-tech", lead: true },
  { name: "Kenan Tat", netid: "ktt38", emails: ["ktt38@cornell.edu"], linearIds: ["5fbc05b9-937e-4301-95c2-9352ad800a75"], github: "Kenan-t", lead: true },
  { name: "Neha Bommireddy", netid: "nb644", emails: ["nb644@cornell.edu"], linearIds: ["4bcdb0df-85e3-4fa2-a150-30a759131b1e"], github: "nehabommireddy", lead: true },
  { name: "Enaika Kishnani", netid: "ek756", emails: ["ek756@cornell.edu"], linearIds: ["58d355dd-7e2a-4bbb-b76f-c44e43c6e42e"], github: "enaikak" },
  { name: "Willow Chen", netid: "wc697", emails: ["wc697@cornell.edu"], linearIds: ["b391333e-0039-40a9-8930-423ddbaeaa05"], github: "willowchen2" },
  { name: "Renee Gowda", netid: "rsg276", emails: ["rsg276@cornell.edu"], linearIds: ["dd7f7d59-a191-48f6-bde4-1fdad5e7ef1c"], github: "reneegowda" },
  { name: "Roma Rangaswamy", netid: "rr829", emails: ["rr829@cornell.edu"], linearIds: ["9d39d67f-7998-4bb8-92bf-15966231566b"], github: "RomaR2007" },
  { name: "Sabrina Gerson", netid: "sjg326", emails: ["sjg326@cornell.edu"], linearIds: ["8ad608d2-2181-4938-8470-b9610617f422"], github: "sjg326" },
  { name: "Samantha Ahn", netid: "sa2389", emails: ["sa2389@cornell.edu"], linearIds: ["699ad942-327f-4009-8b8a-c2249833be97"], github: "SamanthaAhn17" },
  { name: "Karan Singh Madia", netid: "km2253", emails: ["km2253@cornell.edu"], linearIds: ["832b871c-eb62-4b3d-93e0-6fa2afdbd76d"], github: "ksm0712" },
  { name: "Lahari Bandaru", netid: "lb825", emails: ["lb825@cornell.edu"], linearIds: ["572573d5-0e0e-4b77-8081-da5f4de3623b"], github: "Liribee" },
  // Dana Ryu — two Linear accounts; activity on both is attributed to this one person (lead decision, 2026-10-06).
  { name: "Dana Ryu", netid: "er559", emails: ["er559@cornell.edu", "dana.ryu2007@gmail.com"], linearIds: ["21964707-6acc-493e-80d5-af0a402af210", "411f7c8b-01d3-45ba-b152-ce4588f55045"], github: "danaryu2007-oss" },
];

/**
 * Build the id/login lookup indexes, failing loud on a duplicate (the roster is the
 * identity source — a silent overwrite would misroute a Slack DM or a sweep).
 */
export function buildRosterIndexes(members: Member[]): {
  byLinearId: Map<string, Member>;
  byGithub: Map<string, Member>;
} {
  const byLinearId = new Map<string, Member>();
  const byGithub = new Map<string, Member>();
  for (const m of members) {
    const gh = m.github.toLowerCase();
    if (byGithub.has(gh)) throw new Error(`roster: duplicate github "${m.github}" (${m.name})`);
    byGithub.set(gh, m);
    for (const id of m.linearIds) {
      if (byLinearId.has(id)) throw new Error(`roster: duplicate linearId "${id}" (${m.name})`);
      byLinearId.set(id, m);
    }
  }
  return { byLinearId, byGithub };
}

const { byLinearId, byGithub } = buildRosterIndexes(ROSTER);

/** Member for a Linear user id — both of Dana Ryu's ids resolve to the same one. */
export function memberByLinearId(linearId: string): Member | undefined {
  return byLinearId.get(linearId);
}

/** Member for a GitHub login (case-insensitive) — e.g. a PR author -> person -> Slack. */
export function memberByGithub(login: string): Member | undefined {
  return byGithub.get(login.toLowerCase());
}

/** Emails to try, in order, against slack.users.lookupByEmail for a Linear user. */
export function slackLookupEmails(linearId: string): string[] {
  return byLinearId.get(linearId)?.emails ?? [];
}
