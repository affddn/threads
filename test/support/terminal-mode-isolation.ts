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
const h = await refreshHarness(0, { mode: process.argv[2] === "lite" ? "lite" : "full" }, entry);
try {
  h.event("session.idle");
  await settle();
  console.log(JSON.stringify({ loaded: loaded.length, rpcs: h.rpcIDs, slots: h.slotIDs, commands: h.commandIDs, counts: h.counts, errors: h.errors }));
} finally { h.dispose(); }
