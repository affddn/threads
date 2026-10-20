import type { Plugin } from "@opencode/plugin";
import type { Info } from "@opencode/plugin/promise/tool";
import plugin from "../../index";

// Substitute host registration/storage only; all plugin setup and schemas are production code.
export async function serverHarness(options: Record<string, unknown> = {}) {
  const tools: Info[] = [];
  const hooks: string[] = [];
  const rpcs: string[] = [];
  const skills: unknown[] = [];
  const commands: unknown[] = [];
  const values = new Map();
  const ctx = {
    options,
    location: { directory: process.cwd(), project: { canonical: process.cwd() } },
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => { values.set(key, value); },
      remove: async (key: string) => { values.delete(key); },
      scan: async () => ({ entries: [] }),
    },
    session: { hook: async (name: string) => { hooks.push(name); } },
    rpc: { register: async ({ id }: { id: string }) => { rpcs.push(id); return { events: { emit: async () => {} } }; } },
    tool: { transform: async (transform: (editor: unknown) => void) => transform({ namespace: () => {}, add: (tool: Info) => tools.push(tool) }) },
    skill: { transform: async (transform: (editor: unknown) => void) => transform({ add: (skill: unknown) => skills.push(skill) }) },
    command: { transform: async (transform: (editor: unknown) => void) => transform({ add: (command: unknown) => commands.push(command) }) },
  };
  const dispose = await plugin.setup(ctx as unknown as Plugin.Context);
  return { tools, hooks, rpcs, skills, commands, dispose };
}
