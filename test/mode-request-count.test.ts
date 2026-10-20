import { afterEach, expect, jest, test } from "bun:test";
import terminal from "../tui";
import { refreshHarness, streams } from "./support/refresh-harness";

afterEach(() => jest.useRealTimers());

async function drain() {
  for (let hop = 0; hop < 20; hop++) await Promise.resolve();
}
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 500) {
    jest.advanceTimersByTime(500);
    await drain();
  }
}
const worker = {
  workerID: "worker", coordinatorID: "A", key: "fixture", title: "Fixture worker", directory: "/fixture",
  agent: "fixture", model: null, outcome: null, report: null, hidden: false,
};

for (const mode of [undefined, "full", "lite"] as const) {
  for (const tabsEnabled of [false, true]) {
    test(`${mode ?? "default"}, tabs ${tabsEnabled}: diagnostics preserve snapshot counts and polling cadence`, async () => {
      jest.useFakeTimers();
      const serverMode = mode === "lite" ? "full" : "lite";
      const h = await refreshHarness(0, { mode }, terminal, { tabsEnabled, workers: [worker], configuration: { mode: serverMode, directory: "/fixture" } });
      try {
        await drain();
        expect(h.counts.workerSnapshots).toBe(tabsEnabled ? 2 : 1);
        expect(h.errors).toHaveLength(1);
        h.active(true);
        for (let index = 0; index < 10; index++) for (const type of streams) h.event(type);
        await drain();
        expect(h.counts.workerSnapshots).toBe(tabsEnabled ? 2 : 1);
        // Activity lifecycle events coalesce into one request at one second; root's
        // immediate path remains present only when native tab management is enabled.
        h.event("session.idle");
        await drain();
        const immediate = h.counts.workerSnapshots;
        expect(immediate).toBe(tabsEnabled ? 3 : 1);
        for (let index = 0; index < 10; index++) h.event("session.status");
        await drain();
        const afterBurst = h.counts.workerSnapshots;
        expect(afterBurst).toBe(immediate + (tabsEnabled ? 2 : 0));
        await advance(500);
        expect(h.counts.workerSnapshots).toBe(afterBurst);
        await advance(500);
        expect(h.counts.workerSnapshots).toBe(afterBurst + 1);
        const afterEvent = h.counts.workerSnapshots;
        await advance(2000);
        expect(h.counts.workerSnapshots).toBe(afterEvent + (tabsEnabled ? 1 : 0));
        await advance(26_500);
        expect(h.counts.workerSnapshots).toBe(afterEvent + (tabsEnabled ? 9 : 0));
        await advance(500);
        expect(h.counts.workerSnapshots).toBe(afterEvent + (tabsEnabled ? 11 : 1));
        expect(h.errors).toHaveLength(1);
        expect(h.commandIDs).toContain("threads.reopen");
      } finally { h.dispose(); }
    });
  }
}

test("activity diagnostics retain request-time directories across an in-flight focus change", async () => {
  jest.useFakeTimers();
  const h = await refreshHarness(0, { mode: "lite" }, terminal, { tabsEnabled: false, configuration: null });
  try {
    h.errors.length = 0;
    h.primary("/request-A");
    const release = h.pauseWorkerSnapshots();
    h.event("session.idle");
    await advance(1000);
    expect(h.workerRequests.at(-1)).toBe("/request-A");
    h.primary("/request-B");
    release();
    await drain();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ message: expect.stringContaining("server mode unknown at requested directory /request-A") });
    expect(JSON.stringify(h.errors)).not.toContain("/request-B");
    expect(JSON.stringify(h.errors)).not.toContain("Fallback global worker snapshot");
  } finally { h.dispose(); }
});

test("disposing while activity metadata is in flight prevents the diagnostic callback", async () => {
  jest.useFakeTimers();
  const h = await refreshHarness(0, { mode: "lite" }, terminal, { tabsEnabled: false, configuration: null });
  try {
    h.errors.length = 0;
    h.primary("/pending");
    const release = h.pauseWorkerSnapshots();
    h.event("session.idle");
    await advance(1000);
    expect(h.counts.workerSnapshots).toBe(2);
    h.dispose();
    release();
    await drain();
    expect(h.errors).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  } finally { h.dispose(); }
});
