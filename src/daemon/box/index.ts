/**
 * Box monitor daemon (devbox) — a cut-down daemon under `systemd --user` (design §3.1, §17).
 *
 * No PTYs, no socket server, no clients. Discovers agents from `tmux ls`, polls GitHub, runs the
 * SAME policy engine and actuator as the Mac, delivers nudges via `tmux send-keys`, raises alerts
 * into its OWN database (~/.agent-orchestrator-monitor). Federates with the Mac over ssh only.
 *
 * Why it exists (§17.1): running autonomy from the Mac cost ~450ms of ssh per step and stopped
 * whenever the laptop slept; every input autonomy needs already lives on the box.
 *
 * Refuses to start without AO_REPO (§17.2). Creates a placeholder task (sessions have a task FK),
 * writes a config-loaded marker using PROCESS START time, builds introspector/dwell-tracker/tmux
 * nudge queue/actuator/work-item monitor/optional alert dispatcher. A dummy 2^30 ms interval anchors
 * the event loop (unref'd tickers let Bun exit and Restart=always respawned it in a tight loop).
 */

export async function main(): Promise<void> {
  throw new Error("box.main: not implemented (design §17.2)");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
