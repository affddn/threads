import { plugin } from "bun";

const loaded: string[] = [];
plugin({ name: "record UI loading", setup(build) {
  build.onLoad({ filter: /\/workflow-ui\.tsx$/ }, async ({ path }) => {
    loaded.push(path);
    return { contents: await Bun.file(path).text(), loader: "tsx" };
  });
} });
const { refreshHarness, settle } = await import("./refresh-harness");
const entry = (await import(process.argv[3] === "compiled" ? "../../tui.js" : "../../tui.ts")).default;
const mode = process.argv[2] === "lite" ? "lite" : "full";
const scenario = process.argv[4];
const snapshotOptions: Parameters<typeof refreshHarness>[3] = scenario === "legacy" ? { configuration: null }
  : scenario === "fallback" ? { primaryDirectory: "/missing", fallbackDirectory: "/fixture", configuration: { mode, directory: "/fixture" } }
  : scenario === "mismatch" ? { configuration: { mode: mode === "lite" ? "full" as const : "lite" as const, directory: "/fixture" } }
  : {};
const h = await refreshHarness(0, { mode }, entry, snapshotOptions);
try {
  for (let index = 0; index < 3; index++) { h.event("session.idle"); await settle(); }
  console.log(JSON.stringify({ loaded: loaded.length, rpcs: h.rpcIDs, slots: h.slotIDs, commands: h.commandIDs, counts: h.counts, errors: h.errors }));
} finally { h.dispose(); }
