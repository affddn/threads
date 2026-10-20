import { expect, test } from "bun:test";
import { z } from "zod";
import type { Plugin } from "@opencode/plugin";
import server from "../index";
import terminal from "../tui";
import { Mode } from "../src/mode";
import { refreshHarness, settle, streams } from "./support/refresh-harness";

async function registration(mode: string) {
  const proc = Bun.spawn([process.execPath, "test/support/mode-isolation.ts", mode], {
    cwd: process.cwd(), env: { ...process.env, XDG_CONFIG_HOME: `${process.cwd()}/.audit/lite-empty-config` },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return JSON.parse(stdout);
}

test("mode defaults full and rejects invalid options before either entry has host effects", async () => {
  expect(Mode.parse(undefined)).toBe("full");
  for (const mode of ["worker", null, 0, false]) {
    const ctx = { options: { mode } };
    await expect(server.setup(ctx as unknown as Plugin.Context)).rejects.toBeInstanceOf(z.ZodError);
    await expect(terminal.setup(ctx as unknown as Parameters<typeof terminal.setup>[0])).rejects.toBeInstanceOf(z.ZodError);
  }
});

test("fresh production server lite registers workers without loading workflow or heartbeat modules", async () => {
  const lite = await registration("lite");
  expect(lite.loaded).toEqual([]);
  expect(lite.state).toEqual([]);
  expect(lite.tools).toEqual(["threads_spawn", "threads_list", "threads_send", "threads_interrupt", "threads_hide", "threads_report"]);
  expect(lite.hooks).toEqual(["prompt", "context"]);
  expect(lite.rpcs).toEqual(["threads"]);
  expect(lite.skills).toBe(0);
  expect(lite.commands).toBe(0);
  expect(lite.list).toEqual({ content: '{"workers":[]}', output: { workers: [] } });
  const full = await registration("full");
  expect(full).toEqual(await registration("default"));
  expect(full.loaded).toContain("src/workflow-engine.ts");
  expect(full.loaded).toContain("src/heartbeat.ts");
  expect(full.state.length).toBe(4);
  expect(full.tools.slice(0, 6)).toEqual(lite.tools);
  expect(full.rpcs).toEqual(["threads", "workflows-heartbeat", "workflows"]);
  expect(full.hooks).toEqual(["prompt", "context", "prompt", "context"]);
  expect(full.skills).toBe(1);
  expect(full.commands).toBeGreaterThanOrEqual(2);
}, 20000);

test("lite terminal retains worker refresh and commands without workflow surfaces", async () => {
  const h = await refreshHarness(0, { mode: "lite" });
  try {
    expect(h.counts.workerSnapshots).toBeGreaterThan(0);
    expect(h.rpcIDs).toEqual(["threads", "threads"]);
    expect(h.commandIDs).toEqual(["threads.activity.choose", "threads.reopen"]);
    expect(h.slotIDs).toEqual(["app", "prompt.footer.status", "home.footer.status", "app"]);
    const before = { ...h.counts };
    for (const type of [...streams, "rpc.workflows.updated"]) { h.event(type); await settle(); }
    expect(h.counts).toEqual(before);
    h.event("session.idle");
    await settle();
    expect(h.counts.workerSnapshots).toBeGreaterThan(before.workerSnapshots);
    expect(h.counts.workflowSnapshots).toBe(0);
    expect(h.counts.inspections).toBe(0);
    await h.command("threads.reopen");
    expect(h.errors).toEqual([]);
  } finally { h.dispose(); }
});

test("fresh source and Solid-compiled terminal keep workflow initialization behind full mode", async () => {
  const build = Bun.spawn([process.execPath, "scripts/build-tui.ts"], { stdout: "pipe", stderr: "pipe" });
  expect(await build.exited).toBe(0);
  const compiled = await Bun.file("tui.js").text();
  expect(compiled).toContain('mode === "full" ? (await Promise.resolve().then(() => (init_workflow_ui()');
  expect(compiled).toContain('from "solid-js"');
  expect(compiled).toContain('from "@opencode/plugin/tui"');
  for (const target of ["source", "compiled"]) {
    for (const mode of ["lite", "full"]) {
      const proc = Bun.spawn([process.execPath, "test/support/terminal-mode-isolation.ts", mode, target], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.errors).toEqual([]);
      expect(result.counts.workerSnapshots).toBeGreaterThan(0);
      if (mode === "lite") {
        expect(result.loaded).toBe(0);
        expect(result.rpcs.every((id: string) => id === "threads")).toBe(true);
        expect(result.commands).toEqual(["threads.activity.choose", "threads.reopen"]);
        expect(result.slots).toEqual(["app", "prompt.footer.status", "home.footer.status", "app"]);
        expect(result.counts.workflowSnapshots).toBe(0);
      } else {
        expect(result.loaded).toBe(target === "source" ? 1 : 0);
        expect(result.rpcs).toContain("workflows");
        expect(result.commands).toContain("workflows.open");
        expect(result.counts.workflowSnapshots).toBeGreaterThan(0);
      }
    }
  }
}, 20000);
