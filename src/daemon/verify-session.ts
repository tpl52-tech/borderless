/**
 * Live app session for the behavioral RLS check (PRD §13, phase V2b) — signs in as the test user (Firebase
 * REST, mirroring the app's Firebase→Supabase identity bridge) and reads PostgREST row counts as anon vs. as
 * that user, so the pure interpreter (shared/verify-rls.ts) can judge whether RLS gates access.
 *
 * Read-only: HEAD requests with an exact count, no writes, no new accounts — residue-free on prod. No logic
 * here beyond the HTTP; the verdict is shared/verify-rls.ts.
 */

import type { VerifyAppConfig } from "../shared/config.ts";
import { rlsBehavioralOutcome, type TableAccess } from "../shared/verify-rls.ts";
import type { CheckOutcome } from "../shared/verify-catalog.ts";

export interface AppSession {
  /** Behavioral RLS probe for one table: anon vs. signed-in read access → an outcome. `isPublic` (from the
   *  catalog) lets an anon read resolve to pass when the schema declares the table anon-readable. */
  rlsProbe: (table: string, isPublic?: boolean) => Promise<CheckOutcome>;
  /** Read a small sample of rows from a table — as the signed-in test user (RLS-bounded) or anonymously.
   *  Read-only (GET, capped limit); `denied` when the role may not read the table at all. */
  read: (table: string, opts?: { anon?: boolean; limit?: number }) => Promise<{ denied: boolean; rows: unknown[] }>;
}

/** Firebase email/password sign-in → the ID token the app sends to Supabase as the bearer. */
async function firebaseIdToken(c: VerifyAppConfig): Promise<string> {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(c.firebaseApiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: c.testEmail, password: c.testPassword, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`firebase sign-in failed (${res.status})`);
  const token = ((await res.json()) as { idToken?: unknown }).idToken;
  if (typeof token !== "string" || !token) throw new Error("firebase sign-in returned no idToken");
  return token;
}

/** PostgREST exact row count for a table (HEAD, no rows fetched). `denied` when the role may not read it at all. */
async function tableAccess(c: VerifyAppConfig, table: string, token?: string): Promise<TableAccess> {
  const res = await fetch(`${c.supabaseUrl}/rest/v1/${encodeURIComponent(table)}?select=*`, {
    method: "HEAD",
    headers: { apikey: c.anonKey, ...(token ? { Authorization: `Bearer ${token}` } : {}), Prefer: "count=exact", Range: "0-0" },
  });
  if (res.status === 401 || res.status === 403) return { denied: true, count: 0 };
  const total = res.headers.get("content-range")?.split("/")[1]; // "0-0/N" | "*/N"
  const count = total && total !== "*" ? Number(total) : 0;
  return { denied: false, count: Number.isFinite(count) ? count : 0 };
}

/** Sign in once, then expose a per-table behavioral RLS probe over that session. Throws if sign-in fails. */
export async function openAppSession(c: VerifyAppConfig): Promise<AppSession> {
  const token = await firebaseIdToken(c);
  return {
    async rlsProbe(table, isPublic = false) {
      const [anon, authed] = await Promise.all([tableAccess(c, table), tableAccess(c, table, token)]);
      return rlsBehavioralOutcome(anon, authed, table, isPublic);
    },
    async read(table, opts) {
      const limit = Math.max(1, Math.min(opts?.limit ?? 5, 50)); // bounded sample
      const res = await fetch(`${c.supabaseUrl}/rest/v1/${encodeURIComponent(table)}?select=*&limit=${limit}`, {
        headers: { apikey: c.anonKey, ...(opts?.anon ? {} : { Authorization: `Bearer ${token}` }) },
      });
      if (res.status === 401 || res.status === 403) return { denied: true, rows: [] };
      const body = await res.json().catch(() => []);
      return { denied: false, rows: Array.isArray(body) ? body : [] };
    },
  };
}
