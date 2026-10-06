/**
 * Mac <-> box federation (design §17.3, §17.4).
 *
 * The Mac pushes the manifest (atomic temp+mv over ssh) every 60s when changed + forced on setPlanning,
 * and pulls the box report every 15s (cached so the 1s snapshot never waits on ssh; unreachable keeps the
 * last payload and flips a flag). The manifest/report SHAPES are pure + tested (manifest.ts / report.ts);
 * this module is the live ssh wiring.
 */

import { runRemote } from "../ssh.ts";
import { buildManifest } from "./manifest.ts";
import { parseReport, reportStale, type BoxReport } from "./report.ts";
import { shellQuote } from "../../shared/remote.ts";
import type { Store } from "../store.ts";

export const MANIFEST_PUSH_MS = 60_000;
export const REPORT_PULL_MS = 15_000;
const REMOTE_MANIFEST = "$HOME/.agent-orchestrator-monitor/roster-policy.json";
const REMOTE_REPORT = "$HOME/agent-orchestrator-monitor/deploy/box/report.sh";

export interface BoxFederation {
  report(): { report: BoxReport | null; stale: boolean; reachable: boolean };
  pushNow(): Promise<void>;
  stop(): void;
}

export interface BoxFederationDeps {
  store: Store;
  dest: string; // config.devbox
  now?: () => number;
}

export function startBoxFederation(deps: BoxFederationDeps): BoxFederation {
  const now = deps.now ?? Date.now;
  let cached: BoxReport | null = null;
  let reachable = false;
  let lastJson = "";

  const pushNow = async (): Promise<void> => {
    const manifest = JSON.stringify(buildManifest(deps.store.listSessions({ includeClosed: true }), now()));
    if (manifest === lastJson) return; // push only when changed
    lastJson = manifest;
    // Atomic temp+mv so the box never reads a half-written manifest.
    const tmp = `${REMOTE_MANIFEST}.tmp`;
    await runRemote(deps.dest, `cat > ${tmp} && mv ${tmp} ${REMOTE_MANIFEST}`, { input: manifest, timeoutMs: 30_000 })
      .catch(() => { lastJson = ""; }); // force a retry next tick on failure
  };

  const pullNow = async (): Promise<void> => {
    const r = await runRemote(deps.dest, `sh ${REMOTE_REPORT}`, { timeoutMs: 25_000 }).catch(() => null);
    if (!r || r.code !== 0) { reachable = false; return; } // keep the last payload, flip the flag
    const parsed = parseReport(r.stdout);
    if (parsed) { cached = parsed; reachable = true; }
    else reachable = false;
  };

  const pushT = setInterval(() => void pushNow(), MANIFEST_PUSH_MS);
  const pullT = setInterval(() => void pullNow(), REPORT_PULL_MS);

  return {
    report: () => ({ report: cached, stale: reportStale(cached, now()), reachable }),
    pushNow,
    stop() { clearInterval(pushT); clearInterval(pullT); },
  };
}

// re-export the quoting helper used by callers that build remote paths.
export { shellQuote };
