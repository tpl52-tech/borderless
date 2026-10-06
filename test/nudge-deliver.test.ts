import { test, expect, describe } from "bun:test";
import { deliverToPty, createNudgeDelivery } from "../src/daemon/nudge/index.ts";
import { spawnPty } from "../src/daemon/pty.ts";
import type { PtySession } from "../src/daemon/pty.ts";
import type { Store } from "../src/daemon/store.ts";
import type { SessionManager } from "../src/daemon/session-manager.ts";
import type { SessionStatus } from "../src/shared/types.ts";

const dec = new TextDecoder();

describe("deliverToPty framing (design §10.5)", () => {
  test("delivers body then Enter as separate writes — a real program receives the line", async () => {
    const pty = spawnPty({
      sessionId: "t", cwd: "/tmp",
      argv: ["bash", "-c", 'read line; printf "GOT:%s" "$line"'],
    });
    const r = await deliverToPty(pty, "hello-nudge", "claude", { settleMs: 40 });
    expect(r).toBe("delivered");
    await pty.exited;
    expect(dec.decode(pty.replay())).toContain("GOT:hello-nudge");
  });

  test("cancellation sends ESC (clear), not Enter (§10.6)", async () => {
    const writes: number[][] = [];
    const fakePty = { write: (b: Uint8Array) => writes.push([...b]) } as unknown as PtySession;
    const r = await deliverToPty(fakePty, "hello", "claude", { settleMs: 1, cancelled: () => true });
    expect(r).toBe("cancelled");
    expect(writes.at(-1)).toEqual([0x1b]); // ESC, never CR (0x0d)
    expect(writes.some((w) => w[0] === 0x0d)).toBe(false);
  });
});

describe("idle gating (design §10.5)", () => {
  test("holds while the agent is working; delivers on the transition to idle", async () => {
    let status: SessionStatus = "working";
    const writes: string[] = [];
    const pty = { write: (b: Uint8Array) => writes.push(dec.decode(b)) } as unknown as PtySession;

    const store = {
      getSession: () => ({ tool: "claude", planning: false }),
      listSessions: () => [{ id: "s" }],
    } as unknown as Store;
    const manager = {
      status: () => status,
      live: () => pty,
    } as unknown as SessionManager;

    let statusCb: ((sessionId: string) => void) | null = null;
    const nudge = createNudgeDelivery({
      store, manager, subscribeStatus: (cb) => { statusCb = cb; return () => {}; },
    });

    nudge.enqueue({ sessionId: "s", body: "do it", manual: true });
    await Bun.sleep(60);
    expect(writes.length).toBe(0); // gate closed while working

    status = "done";
    statusCb!("s"); // status change -> drain
    await Bun.sleep(260); // body write + 150ms settle + CR
    const all = writes.join("");
    expect(all).toContain("do it");
    expect(writes.some((w) => w.includes("\r"))).toBe(true);

    nudge.stop();
  });
});
