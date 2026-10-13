import { Plugin } from "@opencode/plugin";
import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const Probe = Rpc.define({ id: "native_load", methods: {
  counts: { input: z.object({}), output: z.any(), errors: {} },
  seed: { input: z.object({ owners: z.array(z.string()), directory: z.string(), count: z.number().int().nonnegative() }), output: z.any(), errors: {} },
}, events: {} });

export default Plugin.define({
  id: "op-threads",
  async setup(ctx) {
    const target = z.string().parse(ctx.options.target);
    const plugin = (await import(pathToFileURL(join(target, "index.ts")).href)).default;
    const { WorkflowRun } = await import(pathToFileURL(join(target, "src/workflow-types.ts")).href);
    const counts = { rpc: {} as Record<string, { calls: number; elapsedMs: number }>, scans: 0, entries: 0, bytes: 0, scanMs: 0, gets: 0, getMs: 0, sets: 0, setMs: 0 };
    const storage: Plugin.Context["storage"] = {
      ...ctx.storage,
      async scan(input) {
        const start = performance.now();
        const result = await ctx.storage.scan(input);
        if (input.prefix?.startsWith("workflows/")) {
          counts.scans++;
          counts.scanMs += performance.now() - start;
          counts.entries += result.entries.length;
          counts.bytes += result.entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.value)), 0);
        }
        return result;
      },
      async get(key) {
        const start = performance.now();
        const result = await ctx.storage.get(key);
        if (key.startsWith("workflows/")) { counts.gets++; counts.getMs += performance.now() - start; }
        return result;
      },
      async set(key, value) {
        const start = performance.now();
        await ctx.storage.set(key, value);
        if (key.startsWith("workflows/")) { counts.sets++; counts.setMs += performance.now() - start; }
      },
    };
    await plugin.setup({ ...ctx, storage, rpc: { ...ctx.rpc,
      register: async (definition: { id: string }, handlers: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
        const wrapped = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (...args: unknown[]) => {
          const key = `${definition.id}.${name}`;
          const record = counts.rpc[key] ??= { calls: 0, elapsedMs: 0 };
          record.calls++;
          const start = performance.now();
          try { return await handler(...args); }
          finally { record.elapsedMs += performance.now() - start; }
        }]));
        return ctx.rpc.register(definition as never, wrapped as never);
      },
    }});
    await ctx.rpc.register(Probe, {
      counts: async () => structuredClone(counts),
      seed: async ({ owners, directory, count }) => {
        for (let index = 0; index < count; index++) {
          const id = `native-load-${index}`;
          const run = WorkflowRun.parse({
            version: 1, id, key: id, ownerID: owners[index % owners.length], callerAgent: "build",
            model: { providerID: "fixture", id: "fixture" }, projectID: "native-load", directory,
            name: id, description: "Seeded native journal population", script: "return true", args: null,
            fingerprint: id, limits: { maxAgents: null, agentTimeoutMs: null, timeoutMs: null },
            status: "completed", created: index, updated: index, phase: "completed", steps: [], logs: [],
            checkpoints: [], deliveryID: id, delivered: true, result: true,
          });
          await storage.set(`workflows/runs/${id}`, run);
        }
        return { count };
      },
    });
  },
});
