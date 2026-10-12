import { expect, test } from "bun:test";
import { heartbeatLocked, heartbeatStore } from "../src/heartbeat-store";
import { Json } from "../src/workflow-types";
import type { Schema } from "effect";

test("process-global owner serialization also covers separately constructed stores", async () => {
  const values = new Map<string, Schema.Json>();
  const storage = { get: async (key: string) => values.get(key), set: async (key: string, value: Schema.Json) => { values.set(key, structuredClone(value)); }, remove: async () => {}, scan: async () => ({ entries: [] }) };
  const a = heartbeatStore(storage), b = heartbeatStore(storage);
  const order: string[] = [];
  await Promise.all([heartbeatLocked("owner", async () => {
    order.push("a-start"); await Bun.sleep(10); await a.write(await a.read("owner")); order.push("a-end");
  }), heartbeatLocked("owner", async () => { expect(await b.read("owner")).toEqual({ protocol: 1, ownerID: "owner", monitors: [], receipts: [] }); order.push("b"); })]);
  expect(order).toEqual(["a-start", "a-end", "b"]);
  expect(globalThis.opThreadsHeartbeatLocksV1?.size).toBe(0);
  await expect(heartbeatLocked("owner", async () => { throw new Error("failure"); })).rejects.toThrow("failure");
  await heartbeatLocked("owner", async () => {});
});

test("unsupported schema is retained and cannot be silently rewritten", async () => {
  const raw = { protocol: 2, ownerID: "owner", monitors: [], receipts: [] };
  let writes = 0;
  const store = heartbeatStore({ get: async () => raw, set: async () => { writes++; }, remove: async () => {}, scan: async () => ({ entries: [{ key: "heartbeat/v1/owners/owner", value: raw }] }) });
  await expect(store.read("owner")).rejects.toThrow();
  await expect(store.page()).rejects.toThrow();
  expect(writes).toBe(0);
});
