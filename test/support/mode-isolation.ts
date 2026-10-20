import { plugin } from "bun";
import { resolve } from "node:path";

const loaded: string[] = [];
plugin({
  name: "record workflow loading",
  setup(build) {
    build.onLoad({ filter: /\/(?:workflows|workflow-[^/]+|heartbeat[^/]*)\.(?:ts|tsx)$/ }, async ({ path }) => {
      loaded.push(path);
      return { contents: await Bun.file(path).text(), loader: path.endsWith("tsx") ? "tsx" : "ts" };
    });
  },
});
const mode = process.argv[2];
const { serverHarness } = await import("./server-harness");
// A retained active journal is data, not a reason for Lite to load or migrate its engine.
const retained: [string, unknown][] = [["workflows/runs/synthetic", {
  version: 1, id: "synthetic", key: "synthetic", ownerID: "ses_synthetic", callerAgent: "build",
  model: { providerID: "fixture", id: "fixture" }, projectID: "fixture", directory: "/fixture",
  name: "synthetic", description: "retained workflow", script: "return true", args: null, fingerprint: "fixture",
  limits: { concurrency: 3, maxAgents: null, agentTimeoutMs: null, timeoutMs: null },
  status: "running", created: 0, updated: 0, phase: "starting", steps: [], logs: [], checkpoints: [],
  deliveryID: "msg_synthetic", delivered: false,
}]];
const before = JSON.stringify(retained);
const result = await serverHarness(mode === "default" ? {} : { mode }, retained);
try {
  const state = Object.keys(globalThis).filter((key) => /^__opWorkflow(?:OwnerSlots|RunSlots|Leases|Signals)$/.test(key));
  console.log(JSON.stringify({ loaded: loaded.map((path) => path.slice(resolve(".").length + 1)).sort(), state: state.sort(),
    snapshot: await result.rpcHandlers.get("threads")!.snapshot({ coordinatorIDs: [] }),
    list: await result.tools.find((tool) => tool.name === "list")!.execute({}, { sessionID: "ses_mode_fixture" } as Parameters<(typeof result.tools)[number]["execute"]>[1]),
    retainedUnchanged: JSON.stringify([...result.values]) === before,
    storageCalls: result.storageCalls,
    tools: result.tools.map((tool) => `${tool.options?.namespace}_${tool.name}`),
    hooks: result.hooks, rpcs: result.rpcs, skills: result.skills.length, commands: result.commands.length }));
} finally { if (typeof result.dispose === "function") await result.dispose(); }
