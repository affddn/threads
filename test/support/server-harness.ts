import type { Plugin } from "@opencode/plugin";
import type { Info } from "@opencode/plugin/promise/tool";
import plugin from "../../index";

// Substitute host registration/storage only; all plugin setup and schemas are production code.
export async function serverHarness(options: Record<string, unknown> = {}, initialRecords: [string, unknown][] = []) {
  const tools: Info[] = [];
  const hooks: string[] = [];
  const rpcs: string[] = [];
  const skills: unknown[] = [];
  const commands: unknown[] = [];
  const rpcHandlers = new Map<string, Record<string, (input: { coordinatorIDs: string[] }) => Promise<unknown>>>();
  const values = new Map(initialRecords);
  const storageCalls: string[] = [];
  const ctx = {
    options,
    location: { directory: process.cwd(), project: { canonical: process.cwd() } },
    storage: {
      get: async (key: string) => { storageCalls.push(`get:${key}`); return values.get(key); },
      set: async (key: string, value: unknown) => { storageCalls.push(`set:${key}`); values.set(key, value); },
      remove: async (key: string) => { storageCalls.push(`remove:${key}`); values.delete(key); },
      scan: async ({ prefix }: { prefix: string }) => { storageCalls.push(`scan:${prefix}`); return { entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }; },
    },
    session: { hook: async (name: string) => { hooks.push(name); } },
    rpc: { register: async ({ id }: { id: string }, handlers: Parameters<typeof rpcHandlers.set>[1]) => { rpcs.push(id); rpcHandlers.set(id, handlers); return { events: { emit: async () => {} } }; } },
    tool: { transform: async (transform: (editor: unknown) => void) => transform({ namespace: () => {}, add: (tool: Info) => tools.push(tool) }) },
    skill: { transform: async (transform: (editor: unknown) => void) => transform({ add: (skill: unknown) => skills.push(skill) }) },
    command: { transform: async (transform: (editor: unknown) => void) => transform({ add: (command: unknown) => commands.push(command) }) },
  };
  const dispose = await plugin.setup(ctx as unknown as Plugin.Context);
  return { tools, hooks, rpcs, skills, commands, dispose, rpcHandlers, values, storageCalls };
}
