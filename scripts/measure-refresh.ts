import { resolve } from "node:path";
import { refreshHarness, settle, streams } from "../test/support/refresh-harness";

const output = resolve(process.argv[2] ?? ".audit/refresh-fix/measurement.json");
if (await Bun.file(output).exists()) throw new Error(`Evidence already exists: ${output}. Choose a fresh output path.`);
const measurements = [];
for (const savedRuns of [0, 120]) {
  const h = await refreshHarness(savedRuns);
  try {
    for (const owner of ["A", "B"]) {
      h.owner(owner);
      h.event("session.metadata.updated");
      await settle();
      for (const panel of [undefined, "threads.workflows"]) {
        h.panel(panel);
        if (panel && savedRuns) await h.command("workflows.open");
        const before = { ...h.counts };
        const start = performance.now();
        for (const type of streams) for (let index = 0; index < 100; index++) {
          h.event(type);
          await settle();
        }
        // Include the activity listener's one-second delayed reload, if scheduled.
        await Bun.sleep(1100);
        measurements.push({ savedRuns, owner, panel: panel ?? "closed", events: streams.length * 100,
          elapsedMs: performance.now() - start,
          work: Object.fromEntries(Object.entries(h.counts).map(([key, value]) => [key, value - before[key as keyof typeof before]])) });
      }
    }
    const before = { ...h.counts };
    // A phase change in storage emits neither native session events nor a workflow RPC event.
    if (savedRuns) await h.store.update("run-1", (run) => { run.phase = "external progress"; });
    await Bun.sleep(3100);
    measurements.push({ savedRuns, owner: "B", panel: "threads.workflows", events: 0, source: "open-panel periodic fallback",
      work: Object.fromEntries(Object.entries(h.counts).map(([key, value]) => [key, value - before[key as keyof typeof before]])) });
    if (h.errors.length) throw new Error(JSON.stringify(h.errors));
  } finally { h.dispose(); }
}
await Bun.write(output, JSON.stringify({
  implementation: "Actual terminal plugin setup and all production event callbacks; production workflowStore scan/parse. Host RPC/storage transport and session delivery substituted; not a live server load profile.",
  journalBytes: "JSON bytes returned by instrumented in-memory storage scans, not physical disk IO",
  checkpointPolling: "Unchanged; separate engine one-second checkpoint polling is not exercised by this UI harness.",
  measurements,
}, null, 2));
console.log(output);
