import { mkdir } from "node:fs/promises";
await mkdir("bin", { recursive: true });
const result = await Bun.build({ entrypoints: ["scripts/heartbeat-cli.ts"], outdir: "bin", naming: "op-threads-heartbeat.mjs", target: "node", packages: "external" });
if (!result.success) throw new Error(result.logs.join("\n"));
