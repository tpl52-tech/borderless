/**
 * Live catalog DB client (PRD §13, phase V2b) — the thin Bun-native Postgres wrapper the verify runner uses to
 * execute a CatalogProbe's parameterized query over the SELECT-only / catalog-only role (config.verifyDbUrl).
 * Read-only use; the daemon opens one per `verify.run` and closes it after. No logic here — the SQL + the
 * interpretation live in shared/verify-catalog.ts; this just runs the bytes.
 */

import { SQL } from "bun";
import type { CatalogProbe, CatalogRow } from "../shared/verify-catalog.ts";

export interface CatalogDb {
  /** Run a probe's parameterized SQL ($1…) and return its rows. */
  run(probe: CatalogProbe): Promise<CatalogRow[]>;
  /** The public-schema table names — lets the runner target a check from the ticket text when no PR path did. */
  tables(): Promise<string[]>;
  close(): Promise<void>;
}

/** Open a catalog connection over the read-only role. Session-pooler friendly; an 8s connect timeout so a bad
 *  host fails fast instead of hanging the on-demand run. */
export function openCatalogDb(url: string): CatalogDb {
  const db = new SQL(url, { connectionTimeout: 8 });
  return {
    async run(probe) {
      return (await db.unsafe(probe.sql, probe.params)) as CatalogRow[]; // $1-bound params; never string-spliced
    },
    async tables() {
      const rows = (await db`select c.relname as name from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','p') and n.nspname = 'public' order by 1`) as { name: string }[];
      return rows.map((r) => r.name);
    },
    async close() {
      try { await db.end(); } catch { /* already closed */ }
    },
  };
}
