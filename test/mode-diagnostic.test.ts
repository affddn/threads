import { expect, test } from "bun:test";
import { modeDiagnostics } from "../src/mode-diagnostic";
import { ThreadsRpc } from "../src/rpc";
import { refreshHarness, settle } from "./support/refresh-harness";
import terminal from "../tui";

test("matching metadata is quiet; legacy snapshots remain schema-compatible, not confirmed", () => {
  const input = { requestedDirectory: "/project", primaryDirectory: "/project" };
  const diagnostic = modeDiagnostics("full");
  expect(diagnostic({ ...input, configuration: { mode: "full", directory: "/project" } })).toBeUndefined();
  const unknown = diagnostic(input);
  expect(unknown).toContain("server mode unknown at requested directory /project");
  expect(unknown).toContain("Compatibility is unconfirmed");
  expect(diagnostic(input)).toBeUndefined();
  // Existing RPC output schemas are deliberately not strict: legacy clients strip additions.
  expect(ThreadsRpc.methods.snapshot.output.parse({ workers: [] })).toEqual({ workers: [] });
  const legacy = ThreadsRpc.methods.snapshot.output.omit({ configuration: true });
  expect(legacy.parse({ workers: [], configuration: { mode: "lite", directory: "/project" } })).toEqual({ workers: [] });
});

test("fallback metadata describes only the actual responding directory", () => {
  const diagnostic = modeDiagnostics("lite");
  const message = diagnostic({ configuration: { mode: "lite", directory: "/actual" },
    requestedDirectory: "/fallback", primaryDirectory: "/primary", focusedDirectory: "/focused" });
  expect(message).toContain("server lite at responding directory /actual");
  expect(message).toContain("Fallback global worker snapshot only");
  expect(message).toContain("primary directory /primary and focused directory /focused remain unverified");
  expect(message).not.toContain("mismatch");
  expect(diagnostic({ configuration: { mode: "lite", directory: "/primary" },
    requestedDirectory: "/fallback", primaryDirectory: "/primary" })).toContain("primary directory /primary remain unverified");
});

for (const terminalMode of ["lite", "full"] as const) {
  test(`production terminal ${terminalMode} warns once on mismatch without losing worker UI`, async () => {
    const serverMode = terminalMode === "lite" ? "full" : "lite";
    const h = await refreshHarness(0, { mode: terminalMode }, terminal, { configuration: { mode: serverMode, directory: "/fixture" } });
    try {
      for (let index = 0; index < 3; index++) { h.event("session.idle"); await settle(); }
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toMatchObject({ variant: "warning", message: expect.stringContaining(`terminal ${terminalMode}; server ${serverMode} at responding directory /fixture`) });
      expect(h.commandIDs).toContain("threads.reopen");
      await h.command("threads.reopen");
      expect(h.counts.workerSnapshots).toBeGreaterThan(1);
      expect(h.errors).toHaveLength(1);
      expect(h.commandIDs.includes("workflows.open")).toBe(terminalMode === "full");
    } finally { h.dispose(); }
  });
}

test("production fallback and legacy notices are labeled and deduplicated", async () => {
  for (const configuration of [null, { mode: "lite" as const, directory: "/fixture" }]) {
    const h = await refreshHarness(0, { mode: "lite" }, terminal, { primaryDirectory: "/removed", fallbackDirectory: "/fixture", configuration });
    try {
      for (let index = 0; index < 3; index++) { h.event("session.idle"); await settle(); }
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toMatchObject({ message: expect.stringContaining("primary directory /removed remain unverified") });
      expect(h.counts.workerSnapshots).toBeGreaterThan(1);
      await h.command("threads.reopen");
    } finally { h.dispose(); }
  }
});

test("mode mismatch diagnostics do not depend on native tab management being enabled", async () => {
  const h = await refreshHarness(0, { mode: "lite" }, terminal, { tabsEnabled: false, configuration: { mode: "full", directory: "/fixture" } });
  try {
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ message: expect.stringContaining("Threads mode mismatch") });
    h.event("session.idle");
    await settle();
    expect(h.errors).toHaveLength(1);
    expect(h.commandIDs).toContain("threads.reopen");
  } finally { h.dispose(); }
});
