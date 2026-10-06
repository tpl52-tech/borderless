import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";

function freshStore(): Store {
  return new Store(":memory:");
}

describe("tasks", () => {
  test("create, list (open first), update, close, reopen", () => {
    const s = freshStore();
    const a = s.createTask({ name: "alpha" });
    const b = s.createTask({ name: "beta", description: "d" });
    expect(a.status).toBe("open");
    expect(b.orderIdx).toBeGreaterThan(a.orderIdx);

    let list = s.listTasks();
    expect(list.map((t) => t.name)).toEqual(["alpha", "beta"]);

    s.updateTask(a.id, { name: "alpha-2" });
    expect(s.getTask(a.id)!.name).toBe("alpha-2");

    s.closeTask(a.id);
    // closed sorts after open
    list = s.listTasks();
    expect(list.map((t) => t.status)).toEqual(["open", "closed"]);
    expect(s.listTasks(false).map((t) => t.name)).toEqual(["beta"]);

    s.reopenTask(a.id);
    expect(s.getTask(a.id)!.status).toBe("open");
  });
});

describe("sessions", () => {
  test("create, list, update, close (COALESCE closedAt), remove", async () => {
    const s = freshStore();
    const task = s.createTask({ name: "t" });
    const sess = s.createSession({
      taskId: task.id, tool: "claude", location: "local", cwd: "/tmp", model: "auto",
      permissions: "full-access", usesWorktree: false,
    });
    expect(sess.tool).toBe("claude");
    expect(sess.planning).toBe(false);
    expect(sess.closed).toBe(false);

    expect(s.listSessions({ taskId: task.id }).length).toBe(1);

    s.updateSession(sess.id, { title: "impl", planning: true, resumeHandle: "uuid-1" });
    const updated = s.getSession(sess.id)!;
    expect(updated.title).toBe("impl");
    expect(updated.planning).toBe(true);
    expect(updated.resumeHandle).toBe("uuid-1");

    s.closeSession(sess.id);
    const closed1 = s.getSession(sess.id)!;
    expect(closed1.closed).toBe(true);
    const firstClosedAt = closed1.closedAt;
    expect(firstClosedAt).not.toBeNull();

    await Bun.sleep(5);
    s.closeSession(sess.id); // redundant close must not push the deadline (COALESCE)
    expect(s.getSession(sess.id)!.closedAt).toBe(firstClosedAt);

    // default listSessions excludes closed
    expect(s.listSessions({ taskId: task.id }).length).toBe(0);
    expect(s.listSessions({ taskId: task.id, includeClosed: true }).length).toBe(1);

    s.removeSession(sess.id);
    expect(s.getSession(sess.id)).toBeNull();
  });

  test("cascade delete: closing the task's row removes its sessions via FK", () => {
    const s = freshStore();
    const task = s.createTask({ name: "t" });
    s.createSession({ taskId: task.id, tool: "codex", location: "local", cwd: "/tmp" });
    s.db.run("DELETE FROM tasks WHERE id = ?", [task.id]);
    expect(s.listSessions({ taskId: task.id, includeClosed: true }).length).toBe(0);
  });
});
