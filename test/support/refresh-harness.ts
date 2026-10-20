import type { Plugin as ServerPlugin } from "@opencode/plugin";
import type { Plugin } from "@opencode/plugin/tui";
import plugin from "../../tui";
import { workflowStore } from "../../src/workflow-store";
import { WorkflowRun, workflowSummary } from "../../src/workflow-types";

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
export const streams = ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta", "session.compaction.delta", "session.step.streamed", "session.tool.progress"];

// Host boundaries only: production plugin setup/listeners, UI refresh and journal parsing run unchanged.
export async function refreshHarness(savedRuns = 0, options: { mode?: "lite" | "full" } = {}, entry = plugin) {
  let owner = "A";
  let panel: { name: string; sessionID: string } | undefined;
  const records = new Map<string, Parameters<ServerPlugin.Context["storage"]["set"]>[1]>();
  const counts = { workflowSnapshots: 0, workerSnapshots: 0, inspections: 0, scans: 0, journalEntries: 0, journalBytes: 0 };
  const inspected: WorkflowRun[] = [];
  const storage: ServerPlugin.Context["storage"] = {
    get: async (key) => records.get(key),
    set: async (key, value) => { records.set(key, structuredClone(value)); },
    remove: async (key) => { records.delete(key); },
    scan: async ({ prefix, after, limit }) => {
      counts.scans++;
      const keys = [...records.keys()].filter((key) => key.startsWith(prefix) && (!after || key > after)).sort();
      const page = keys.slice(0, limit);
      counts.journalEntries += page.length;
      const entries = page.map((key) => ({ key, value: structuredClone(records.get(key)!) }));
      counts.journalBytes += entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.value)), 0);
      return { entries, ...(keys.length > page.length ? { next: page.at(-1) } : {}) };
    },
  };
  const store = workflowStore(storage);
  for (let index = 0; index < savedRuns; index++) {
    await store.create(WorkflowRun.parse({
      version: 1, id: `run-${index}`, key: `run-${index}`, ownerID: index % 2 ? "B" : "A",
      callerAgent: "build", model: { providerID: "fixture", id: "fixture" }, projectID: "fixture",
      directory: "/fixture", name: `run-${index}`, description: "measurement", script: "return true", args: null,
      fingerprint: `fixture-${index}`, limits: { maxAgents: null, agentTimeoutMs: null, timeoutMs: null },
      status: "running", created: index, updated: index, phase: "starting", steps: [], logs: [], checkpoints: [],
      deliveryID: `delivery-${index}`, delivered: false,
    }));
  }
  const listeners = new Set<(event: { details: { type: string; data: { sessionID: string } } }) => void>();
  const commands = new Map<string, () => unknown>();
  const slots: (() => unknown)[] = [];
  const rpcIDs: string[] = [];
  const slotIDs: string[] = [];
  const errors: unknown[] = [];
  let workerFailure: unknown;
  let holdWorkers: (() => unknown) | undefined;
  const ctx = {
    options,
    client: {
      rpc: (definition: { id: string }) => { rpcIDs.push(definition.id); return definition.id === "workflows" ? {
        snapshot: async ({ ownerID }: { ownerID: string }) => {
          counts.workflowSnapshots++;
          return { runs: (await store.list(ownerID)).map(workflowSummary) };
        },
        inspect: async ({ runID }: { runID: string }) => {
          counts.inspections++;
          const run = await store.get(runID);
          inspected.push(run);
          return run;
        },
      } : {
        snapshot: async (_input: unknown, options?: { signal?: AbortSignal }) => {
          counts.workerSnapshots++;
          if (holdWorkers) {
            const abort = holdWorkers;
            await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(abort()), { once: true }));
          }
          if (workerFailure !== undefined) throw workerFailure;
          return { workers: [] };
        },
        restore: async () => ({ workers: [] }),
      }; },
      session: { list: async () => ({ data: [] }), get: async () => undefined },
    },
    storage: { store: (_key: string, { initial }: { initial: unknown }) => [initial, async () => {}] },
    data: {
      location: { default: () => ({ directory: "/fixture" }) },
      session: { get: () => undefined, status: () => "idle", permission: { list: () => [] }, form: { list: () => [] } },
      listen: (listener: typeof listeners extends Set<infer T> ? T : never) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: owner }) },
      panel: { current: () => panel, open: (name: string) => { panel = { name, sessionID: owner }; } },
      tabs: { enabled: () => true, list: () => [] },
      slot: ({ append, render }: { append: string; render: () => unknown }) => { slotIDs.push(append); if (append === "app") slots.push(render); return () => {}; },
      dialog: { select: async () => savedRuns ? `run-${owner === "A" ? 0 : 1}` : undefined, show: () => {}, set: () => {} },
      toast: { show: (error: unknown) => errors.push(error) },
    },
    keymap: { layer: (build: () => { commands: { id: string; run: () => unknown }[] }) => {
      for (const command of build().commands) commands.set(command.id, command.run);
    } },
  };
  const dispose = await entry.setup(ctx as unknown as Plugin.Context);
  for (const render of slots) render();
  await settle();
  return {
    counts, errors, store, inspected, rpcIDs, slotIDs, commandIDs: [...commands.keys()],
    event: (type: string) => { for (const listener of listeners) listener({ details: { type, data: { sessionID: owner } } }); },
    owner: (id: string) => { owner = id; },
    panel: (name?: string) => { panel = name ? { name, sessionID: owner } : undefined; },
    command: (id: string) => commands.get(id)?.(),
    failWorkerSnapshots: (error?: unknown) => { workerFailure = error; },
    holdWorkerSnapshots: (abortError?: () => unknown) => { holdWorkers = abortError; },
    dispose: () => { if (typeof dispose === "function") dispose(); },
  };
}
