/**
 * Local status hook (design §7.2, §10.2). Registered in claude's `--settings` as a Notification/Stop
 * hook command: `<bun> <this file> <event>`. It appends `<epochMs> <event>` to the session's
 * events.log, which the daemon's status tracker polls by byte offset.
 *
 * The session dir comes from the AO_SESSION_DIR env var set at spawn. Kept tiny and synchronous:
 * claude runs this on every notification, so it must be cheap and never block the agent.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.AO_SESSION_DIR;
const event = process.argv[2];

if (dir && event) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "events.log"), `${Date.now()} ${event}\n`);
  } catch {
    // A hook must never fail the agent; swallow.
  }
}
