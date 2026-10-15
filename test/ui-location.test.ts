import { expect, test } from "bun:test";
import { ClientError } from "@opencode/client/promise";
import type { Plugin } from "@opencode/plugin/tui";
import { applyWorkerSnapshot, transportGrace, uiErrorMessage, uiState } from "../src/ui-location";

function context(focused: string | undefined, fallback: string, sessions: Record<string, string> = {}) {
  return {
    location: focused ? { directory: focused } : undefined,
    data: {
      location: { default: () => ({ directory: fallback }) },
      session: { get: (id: string) => sessions[id] ? { location: { directory: sessions[id] } } : undefined },
    },
  } as unknown as Plugin.Context;
}
const missing = (directory: string) => ({ _tag: "LocationNotFoundError", location: { directory }, message: `Location not found: ${directory}` });

test("native RPC errors retain their message or typed Location in terminal notices", () => {
  expect(uiErrorMessage({ type: "rpc.unavailable", message: "RPC is unavailable: threads" })).toBe("RPC is unavailable: threads");
  expect(uiErrorMessage({ _tag: "LocationNotFoundError", location: { directory: "/removed" }, name: "LocationNotFoundError" })).toBe("Location not found: /removed");
  expect(uiErrorMessage(new Error("Request failed"))).toBe("Request failed");
  expect(uiErrorMessage({ _tag: "ForbiddenError" })).toBe("ForbiddenError");
  expect(uiErrorMessage("Connection closed")).toBe("Connection closed");
  expect(uiErrorMessage({ payload: "unrelated private context" })).toBe("Unknown RPC error");
});

test("missing focused Location retries default, not session relocation", async () => {
  const calls: string[] = [];
  const ctx = context("/missing", "/live");
  expect(await uiState(ctx, [], async ({ directory }) => {
    calls.push(directory);
    if (directory === "/missing") throw missing(directory);
    return 42;
  })).toBe(42);
  expect(calls).toEqual(["/missing", "/live"]);
  expect(ctx.location?.directory).toBe("/missing");
});

test("valid focused Location wins over stale default; successful cold load never falls back", async () => {
  const calls: string[] = [];
  await uiState(context("/cold-valid", "/stale"), [], async ({ directory }) => { calls.push(directory); return 1; });
  expect(calls).toEqual(["/cold-valid"]);
});

test("both stale candidates recover through an observed coordinator, deduplicated", async () => {
  const calls: string[] = [];
  await uiState(context("/gone", "/gone", { A: "/gone", B: "/live" }), ["A", "B"], async ({ directory }) => {
    calls.push(directory);
    if (directory !== "/live") throw missing(directory);
    return 1;
  });
  expect(calls).toEqual(["/gone", "/live"]);
});

test("untyped, mismatched Location, permission and abort errors are not suppressed", async () => {
  for (const error of [new Error("LocationNotFoundError"), missing("/other"), { _tag: "ForbiddenError" }, new DOMException("aborted", "AbortError")]) {
    let calls = 0;
    await expect(uiState(context("/gone", "/live"), [], async () => { calls++; throw error; })).rejects.toBe(error);
    expect(calls).toBe(1);
  }
});

test("all missing candidates expose the last typed error without erasing cache", async () => {
  const last = missing("/default");
  await expect(uiState(context("/focused", "/default"), [], async ({ directory }) => {
    throw directory === "/default" ? last : missing(directory);
  })).rejects.toBe(last);
});

test("successful snapshot prunes only requested coordinator memberships, including deleted workers", () => {
  const cache = new Map([
    ["deleted", { workerID: "deleted", coordinatorID: "A" }],
    ["retained", { workerID: "retained", coordinatorID: "A" }],
    ["unrequested", { workerID: "unrequested", coordinatorID: "B" }],
  ]);
  applyWorkerSnapshot(cache, ["A"], [{ workerID: "retained", coordinatorID: "A" }]);
  expect([...cache.keys()]).toEqual(["retained", "unrequested"]);
  applyWorkerSnapshot(cache, [], [{ workerID: "restored", coordinatorID: "A" }]);
  expect([...cache.keys()]).toEqual(["retained", "unrequested", "restored"]);
  applyWorkerSnapshot(cache, ["A"], []);
  expect([...cache.keys()]).toEqual(["unrequested"]);
});

test("failed snapshot routing leaves cached memberships intact", async () => {
  const worker = { workerID: "retained", coordinatorID: "A" };
  const cache = new Map([[worker.workerID, worker]]);
  try {
    const values = await uiState(context("/gone", "/gone"), ["A"], async (): Promise<typeof worker[]> => { throw missing("/gone"); });
    applyWorkerSnapshot(cache, ["A"], values);
  } catch {}
  expect([...cache.values()]).toEqual([worker]);
});

test("background transport failures are reported only after the grace period", () => {
  let clock = 0;
  const grace = transportGrace(15_000, () => clock);
  const dropped = new ClientError("Transport", { cause: new Error("The socket connection was closed unexpectedly.") });
  expect(dropped.message).toBe("Transport: The socket connection was closed unexpectedly.");
  expect(grace.shouldReport(dropped)).toBe(false);
  clock = 14_999;
  expect(grace.shouldReport(dropped)).toBe(false);
  clock = 15_000;
  expect(grace.shouldReport(dropped)).toBe(true);
  grace.clear();
  clock = 20_000;
  expect(grace.shouldReport(dropped)).toBe(false);
});

test("non-transport failures are reported immediately and restart the transport grace", () => {
  let clock = 0;
  const grace = transportGrace(15_000, () => clock);
  const dropped = new ClientError("Transport");
  for (const error of [new ClientError("UnexpectedStatus", { detail: "500" }), missing("/gone"), new Error("Transport: lookalike"), "Transport"])
    expect(grace.shouldReport(error)).toBe(true);
  expect(grace.shouldReport(dropped)).toBe(false);
  clock = 15_000;
  expect(grace.shouldReport(new Error("Request failed"))).toBe(true);
  expect(grace.shouldReport(dropped)).toBe(false);
});
