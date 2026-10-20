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
const result = await serverHarness(mode === "default" ? {} : { mode });
try {
  const state = Object.keys(globalThis).filter((key) => /^__opWorkflow(?:OwnerSlots|RunSlots|Leases|Signals)$/.test(key));
  console.log(JSON.stringify({ loaded: loaded.map((path) => path.slice(resolve(".").length + 1)).sort(), state: state.sort(),
    list: await result.tools.find((tool) => tool.name === "list")!.execute({}, { sessionID: "ses_mode_fixture" } as Parameters<(typeof result.tools)[number]["execute"]>[1]),
    tools: result.tools.map((tool) => `${tool.options?.namespace}_${tool.name}`),
    hooks: result.hooks, rpcs: result.rpcs, skills: result.skills.length, commands: result.commands.length }));
} finally { if (typeof result.dispose === "function") await result.dispose(); }
