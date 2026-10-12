import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { HeartbeatRecord, HeartbeatView } from "./heartbeat-types";
import { Json, type WorkflowRun } from "./workflow-types";
import { workflowHash } from "./workflow-store";
const json = (value: unknown) => Json.parse(JSON.parse(JSON.stringify(value)));

declare global { var opThreadsHeartbeatLocksV1: Map<string, Promise<void>> | undefined; }
export async function heartbeatLocked<T>(ownerID: string, operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.opThreadsHeartbeatLocksV1 ??= new Map();
  const previous = locks.get(ownerID) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(ownerID, tail);
  await previous;
  try { return await operation(); }
  finally { release(); if (locks.get(ownerID) === tail) locks.delete(ownerID); }
}
export const OwnerState = z.object({
  protocol: z.literal(1), ownerID: z.string(), monitors: z.array(HeartbeatRecord),
  receipts: z.array(z.object({ fingerprint: z.string(), output: HeartbeatView }).strict()),
}).strict();
export type OwnerState = z.infer<typeof OwnerState>;
export function heartbeatStore(storage: Plugin.Context["storage"]) {
  const key = (ownerID: string) => `heartbeat/v1/owners/${ownerID}`;
  return {
    async read(ownerID: string): Promise<OwnerState> {
      const value = await storage.get(key(ownerID));
      return value === undefined ? { protocol: 1, ownerID, monitors: [], receipts: [] } : OwnerState.parse(value);
    },
    async write(state: OwnerState) {
      const previousRaw = await storage.get(key(state.ownerID));
      const previousState = previousRaw === undefined ? undefined : OwnerState.parse(previousRaw);
      for (const receipt of previousState?.receipts ?? []) await storage.set(`heartbeat/v1/receipts/${state.ownerID}/${receipt.fingerprint}`, json(receipt.output));
      for (const record of state.monitors) {
        const prefix = `heartbeat/v1/archive/${state.ownerID}/${record.monitorID}`;
        for (const admission of record.admissions) await storage.set(`${prefix}/admissions/${admission.sequence}`, json(admission));
        for (const binding of record.bindings) {
          await storage.set(`${prefix}/bindings/${binding.epoch}`, json(binding));
        }
        for (let index = 0; index < record.history.length; index++) {
          const item = record.history[index];
          await storage.set(`${prefix}/history/${heartbeatFingerprint("history", item)}`, json(item));
        }
        record.admissions = record.admissions.slice(-16);
        record.bindings = record.bindings.slice(-16);
        record.history = record.history.slice(-16);
      }
      state.receipts = state.receipts.slice(-16);
      const value = json(OwnerState.parse(state));
      await storage.set(key(state.ownerID), value);
      for (const record of state.monitors) for (const binding of record.bindings) {
        const runKey = `heartbeat/v1/run-index/${state.ownerID}/${binding.runID}`;
        const previous = await storage.get(runKey);
        const identity = { monitorID: record.monitorID, enrollmentFingerprint: record.enrollmentFingerprint };
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(identity)) throw new Error("Run already enrolled, including archived bindings");
        await storage.set(runKey, identity);
      }
    },
    async receipt(ownerID: string, fingerprint: string) {
      const raw = await storage.get(`heartbeat/v1/receipts/${ownerID}/${fingerprint}`);
      return raw === undefined ? undefined : HeartbeatView.parse(raw);
    },
    async usedRun(ownerID: string, runID: string) { return storage.get(`heartbeat/v1/run-index/${ownerID}/${runID}`); },
    async page(after?: string, limit = 100) {
      const page = await storage.scan({ prefix: "heartbeat/v1/owners/", after: after && key(after), limit });
      return { owners: page.entries.map((entry) => OwnerState.parse(entry.value)), next: page.next?.slice("heartbeat/v1/owners/".length) };
    },
  };
}
export function requireRevision(record: HeartbeatRecord, expected: number) {
  if (record.revision !== expected) throw new Error("Heartbeat revision conflict; inspect before retry");
}
export function heartbeatBinding(run: WorkflowRun, epoch: number) {
  return { epoch, runID: run.id, projectID: run.projectID, directory: run.directory, runFingerprint: run.fingerprint };
}
export function heartbeatFingerprint(operation: string, input: unknown) { return workflowHash(json({ operation, input })); }
