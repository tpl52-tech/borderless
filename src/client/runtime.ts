/**
 * Shared client runtime for the Ink surfaces (`ao` dashboard + `ao console`).
 *
 * One home for the bootstrap (auto-start + connect the daemon), list-navigation key decoding, opening a URL,
 * and the render → attach → re-render loop — so both surfaces behave identically and neither drifts. The
 * loop keeps the `session.openUrl` subscription live across a raw attach (an agent can block on the very
 * Tailscale re-auth that event unblocks, design §8.4/§9.3) — a safety net both surfaces need.
 */

import { connectDaemon, type DaemonClient } from "./daemon-client.ts";
import { attachSession } from "./attach.ts";
import { paths } from "../shared/paths.ts";

// Raw arrow escape sequences — matched directly because Ink's parser under Bun doesn't always turn them
// into key.upArrow/key.downArrow. Each arrow has four forms: CSI/SS3 (`\x1b[A` / `\x1bOA`) and the same
// ESC-stripped (`[A` / `OA`), since the ESC can arrive in a separate chunk under Bun.
const UP_KEYS = new Set(["\x1b[A", "\x1bOA", "[A", "OA"]);
const DOWN_KEYS = new Set(["\x1b[B", "\x1bOB", "[B", "OB"]);

/**
 * List-navigation direction from an Ink key event. Accepts Ink's parsed arrow flags, vim j/k, and — for
 * robustness under Bun, where Ink sometimes fails to turn arrows into key.upArrow/downArrow — the raw
 * escape sequences themselves (whole, ESC-stripped, or application-cursor mode). Pure + testable.
 */
export function navDirection(input: string, key: { upArrow?: boolean; downArrow?: boolean }): "up" | "down" | null {
  if (key.upArrow || input === "k" || UP_KEYS.has(input)) return "up";
  if (key.downArrow || input === "j" || DOWN_KEYS.has(input)) return "down";
  return null;
}

/** Connect to the daemon, auto-starting it if it isn't listening yet (design §3.1). */
export async function ensureDaemon(): Promise<DaemonClient> {
  const socket = paths().socket;
  try {
    return await connectDaemon(socket);
  } catch {
    const daemonEntry = new URL("../daemon/index.ts", import.meta.url).pathname;
    Bun.spawn([process.execPath, "run", daemonEntry], { stdio: ["ignore", "ignore", "ignore"] }).unref();
    const deadline = Date.now() + 5000;
    for (;;) {
      await Bun.sleep(150);
      try { return await connectDaemon(socket); }
      catch { if (Date.now() > deadline) throw new Error("daemon failed to start within 5s"); }
    }
  }
}

/** Open a URL in the OS browser (design §9.3: the client opens the Tailscale re-auth link). */
export function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try { Bun.spawn([cmd, url], { stdio: ["ignore", "ignore", "ignore"] }).unref(); } catch { /* best effort */ }
}

export type SurfaceAction = { type: "quit" } | { type: "attach"; sessionId: string };

/** A rendered Ink app handle (just the bit the loop awaits). */
interface AppHandle { waitUntilExit(): Promise<void> }

/**
 * Run an Ink surface: render → on quit stop, on attach suspend for the raw PTY then re-render — looping
 * until quit. `openUrl` stays subscribed throughout (incl. during a raw attach). `renderApp` mounts the
 * component wired to the `onAction` the loop reads; the caller owns the client (and closes it).
 */
export async function runSurface(client: DaemonClient, renderApp: (onAction: (a: SurfaceAction) => void) => AppHandle): Promise<void> {
  // One render pass; returns the action the component asked for (typed, so the loop isn't narrowed to quit).
  const once = async (): Promise<SurfaceAction> => {
    let action: SurfaceAction = { type: "quit" };
    const app = renderApp((a) => { action = a; });
    await app.waitUntilExit();
    return action;
  };
  const offOpenUrl = client.on((ev) => {
    if (ev.type === "session.openUrl") openUrl((ev.data as { url: string }).url);
  });
  try {
    for (;;) {
      const action = await once();
      if (action.type === "quit") return;
      if (action.type === "attach") {
        await Bun.sleep(20); // let Ink restore the terminal before attach takes raw stdin
        await attachSession(client, action.sessionId);
        await Bun.sleep(20); // let attach's reset settle before Ink re-renders
      }
    }
  } finally {
    offOpenUrl();
  }
}
