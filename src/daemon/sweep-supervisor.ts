/**
 * Sweep supervisor — picks up queued sweep_jobs and runs the engine on each (lead-console PRD §4-§5, §12).
 *
 * `pickup()` starts `run` (normally `runSweepJob`) for every queued job that isn't already in flight, and
 * tracks it in a running set so a re-pickup can't double-start the same job (the engine moves a job off
 * `queued` as soon as it starts, but the set closes the race window). Concurrency is unbounded by design
 * (PRD §12: no concurrency cap — rebase + re-gate before merge makes it safe). No I/O of its own, so the
 * dispatch/dedup is unit-tested with a fake runner; the daemon passes the live `run`.
 */

import type { Store } from "./store.ts";
import type { SweepJob } from "../shared/types.ts";

export interface SweepSupervisor {
  /** Start a run for each queued job not already in flight; returns the ids newly started. */
  pickup(): string[];
  /** Ids currently in flight. */
  running(): string[];
}

export interface SweepSupervisorDeps {
  store: Pick<Store, "listSweepJobs">;
  run: (job: SweepJob) => Promise<unknown>;
  /** Called if a run rejects (the engine itself catches and marks jobs failed; this is a last resort). */
  onError?: (job: SweepJob, err: unknown) => void;
}

export function createSweepSupervisor(deps: SweepSupervisorDeps): SweepSupervisor {
  const inFlight = new Set<string>();
  return {
    pickup(): string[] {
      const started: string[] = [];
      for (const job of deps.store.listSweepJobs({ state: "queued" })) {
        if (inFlight.has(job.id)) continue;
        inFlight.add(job.id);
        started.push(job.id);
        // Start the run now (synchronously), tracking it until it settles; a throw routes to onError.
        void (async () => {
          try { await deps.run(job); }
          catch (err) { deps.onError?.(job, err); }
          finally { inFlight.delete(job.id); }
        })();
      }
      return started;
    },
    running: () => [...inFlight],
  };
}
