/**
 * The read-only verify-probe (PRD §13, phase V4c-1 / COR-88) — the controlled tool the verification agent uses
 * to inspect the live DB/app. The agent never gets raw credentials; it invokes `ao verify probe …`, which uses
 * the read-only creds (the SELECT-only catalog role + the anon/test-user app session) internally. Read-only:
 * catalog reads + anon/test-user reads, no writes.
 *
 * Connects directly from config (the agent is a separate process from the daemon). Pure logic lives in the
 * tested modules it reuses — verify-catalog (the probes) and verify-rls (the behavioral outcome); this is thin
 * live orchestration.
 */

import type { OperatorConfigLite } from "../shared/config.ts";
import { catalogChecksForTable, catalogProbe, type CheckOutcome } from "../shared/verify-catalog.ts";
import { openCatalogDb } from "./verify-db.ts";
import { openAppSession } from "./verify-session.ts";

export interface ProbeLine { label: string; status: CheckOutcome["status"]; evidence: string }

/** Run every read-only check on one table: the structural catalog checks + the behavioral RLS check. */
export async function probeTable(config: OperatorConfigLite, table: string): Promise<ProbeLine[]> {
  const lines: ProbeLine[] = [];
  if (config.verifyDbUrl) {
    const db = openCatalogDb(config.verifyDbUrl);
    try {
      for (const check of catalogChecksForTable(table)) {
        const probe = catalogProbe(check);
        if (!probe) continue;
        const o = probe.interpret(await db.run(probe));
        lines.push({ label: `${check.property} (catalog)`, status: o.status, evidence: o.evidence });
      }
    } finally {
      await db.close();
    }
  }
  if (config.verifyApp) {
    const app = await openAppSession(config.verifyApp);
    const o = await app.rlsProbe(table);
    lines.push({ label: "rls (behavioral)", status: o.status, evidence: o.evidence });
  }
  return lines;
}

export interface ReadResult { configured: boolean; denied: boolean; rows: unknown[] }

/** Read a sample of rows from a table as the test user (default) or anonymously — the agent inspecting data. */
export async function readTable(config: OperatorConfigLite, table: string, opts?: { anon?: boolean }): Promise<ReadResult> {
  if (!config.verifyApp) return { configured: false, denied: false, rows: [] };
  const app = await openAppSession(config.verifyApp);
  const r = await app.read(table, { anon: opts?.anon });
  return { configured: true, denied: r.denied, rows: r.rows };
}
