import { test, expect, describe } from "bun:test";
import { createSweepSupervisor, type SweepSupervisorDeps } from "../src/daemon/sweep-supervisor.ts";
import type { SweepJob } from "../src/shared/types.ts";

const job = (id: string): SweepJob => ({ id } as unknown as SweepJob);
const fakeStore = (queued: SweepJob[]): SweepSupervisorDeps["store"] => ({
  listSweepJobs: (filter = {}) => (filter.state === "queued" ? queued : []),
});
const flush = () => new Promise((r) => setTimeout(r, 0)); // let .finally microtasks run

describe("createSweepSupervisor (PRD §4-§5, §12)", () => {
  test("pickup starts a run for each queued job, exactly once, and tracks them in flight", async () => {
    const started: string[] = [];
    const resolvers: Array<(v: unknown) => void> = [];
    const run = (j: SweepJob): Promise<unknown> => {
      started.push(j.id);
      return new Promise((res) => resolvers.push(res));
    };
    const sup = createSweepSupervisor({ store: fakeStore([job("a"), job("b")]), run });

    expect(sup.pickup().sort()).toEqual(["a", "b"]);
    expect(started.sort()).toEqual(["a", "b"]);
    expect(sup.running().sort()).toEqual(["a", "b"]);

    // a re-pickup while they're in flight must not double-start
    expect(sup.pickup()).toEqual([]);
    expect(started.length).toBe(2);

    resolvers.forEach((r) => r("ready"));
    await flush();
    expect(sup.running()).toEqual([]);
  });

  test("concurrency is unbounded — all queued jobs start together", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    const run = (): Promise<unknown> => new Promise((res) => resolvers.push(res));
    const sup = createSweepSupervisor({ store: fakeStore([job("a"), job("b"), job("c")]), run });
    expect(sup.pickup().length).toBe(3);
    expect(sup.running().length).toBe(3); // no cap holds any back
    resolvers.forEach((r) => r(null));
    await flush();
  });

  test("a rejecting run calls onError and still clears from the in-flight set", async () => {
    const errors: string[] = [];
    const run = (): Promise<unknown> => Promise.reject(new Error("engine blew up"));
    const sup = createSweepSupervisor({
      store: fakeStore([job("x")]),
      run,
      onError: (j, err) => errors.push(`${j.id}:${(err as Error).message}`),
    });
    sup.pickup();
    await flush();
    expect(errors).toEqual(["x:engine blew up"]);
    expect(sup.running()).toEqual([]);
  });

  test("after a job completes it is no longer in flight (a later pickup could run it again)", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    const run = (): Promise<unknown> => new Promise((res) => resolvers.push(res));
    const sup = createSweepSupervisor({ store: fakeStore([job("a")]), run });
    sup.pickup();
    expect(sup.running()).toEqual(["a"]);
    resolvers.forEach((r) => r(null));
    await flush();
    expect(sup.running()).toEqual([]);
    expect(sup.pickup()).toEqual(["a"]); // still queued in the fake store → picked up again
  });
});
