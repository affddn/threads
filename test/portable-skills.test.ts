import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { Spawn } from "../src/threads";
import { WorkflowAgentInput } from "../src/workflow-types";
import { executeWorkflow, parseWorkflow, type WorkflowHost } from "../src/workflow-runtime";

test("current shipped guidance contains no dependency on named custom profiles", async () => {
  const historical = new Set(["docs/dynamic-workflows-plan.md", "docs/workflows-verification.md"]);
  const files = ["README.md", ...new Bun.Glob("docs/**/*.md").scanSync("."), ...new Bun.Glob("skills/**/*.md").scanSync(".")];
  for (const path of files) {
    if (historical.has(path)) continue;
    const text = await Bun.file(path).text();
    expect({ path, matches: text.match(/\bVERA\b|\bvera-[a-z-]+\b/gi) }).toEqual({ path, matches: null });
    expect({ path, matches: text.match(/agent:\s*["'](?:build|engineer|reviewer)["']/g) }).toEqual({ path, matches: null });
  }
});

test("both copied skills retain all local resources and anchors without a sibling docs tree", async () => {
  const artifacts = resolve(".audit/portable-skills");
  await mkdir(artifacts, { recursive: true });
  const isolated = await mkdtemp(join(artifacts, "copied-"));
  try {
    for (const id of ["managed-sessions", "workflow-authoring"]) {
      const copied = join(isolated, id);
      await cp(`skills/${id}`, copied, { recursive: true });
      for (const file of new Bun.Glob("**/*.md").scanSync(copied)) {
        const source = join(copied, file);
        for (const match of (await Bun.file(source).text()).matchAll(/\]\(([^)]+)\)/g)) {
          const link = match[1];
          if (/^https?:\/\//.test(link)) continue;
          const [path, anchor] = link.split("#");
          const target = path ? resolve(source, "..", path) : source;
          const within = relative(copied, target);
          expect(isAbsolute(within) || within.startsWith("..")).toBe(false);
          expect((await stat(target)).isFile()).toBe(true);
          if (anchor) {
            const headings = [...(await Bun.file(target).text()).matchAll(/^#+ (.+)$/gm)]
              .map((heading) => heading[1].toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-"));
            expect(headings).toContain(anchor);
          }
        }
      }
    }
    expect(await Bun.file(join(isolated, "docs/heartbeat.md")).exists()).toBe(false);
  } finally { await rm(isolated, { recursive: true, force: true }); }
});

const Registration = z.object({
  tools: z.array(z.object({ name: z.string(), description: z.string(), namespace: z.string() })),
  skills: z.array(z.object({ id: z.string(), description: z.string(), content: z.string() })),
});

test("production registration advertises portable profiles and injects the real skill only in full", async () => {
  for (const mode of ["lite", "full"]) {
    const proc = Bun.spawn([process.execPath, "test/support/portable-registration.ts", mode], {
      env: { ...process.env, XDG_CONFIG_HOME: resolve(".audit/portable-skills/empty-config") }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ stderr, exit }).toEqual({ stderr: "", exit: 0 });
    const result = Registration.parse(JSON.parse(stdout));
    expect(result.tools.filter((tool) => tool.namespace === "threads")).toHaveLength(6);
    const spawn = result.tools.find((tool) => tool.namespace === "threads" && tool.name === "spawn");
    expect(spawn?.description).toContain("Omit agent to inherit your active agent and resolved model");
    for (const entry of [...result.tools, ...result.skills]) expect(entry.description).not.toMatch(/\bVERA\b|\bvera-[a-z-]+\b/i);
    expect(result.skills).toHaveLength(mode === "lite" ? 0 : 1);
    if (mode === "full") {
      expect(result.skills[0].id).toBe("workflow-authoring");
      expect(result.skills[0].content).toBe((await Bun.file("skills/workflow-authoring/SKILL.md").text()).replace(/^---\n[\s\S]*?\n---\n/, ""));
    }
  }
}, 15000);

async function sample() {
  const text = await Bun.file("skills/workflow-authoring/SKILL.md").text();
  const script = text.match(/```javascript\n([\s\S]*?)\n```/)?.[1];
  if (!script) throw new Error("The shipped workflow example is missing");
  return script;
}

test("the shipped workflow example dispatches the supplied configured ID through real CodeMode", async () => {
  const script = await sample();
  expect(parseWorkflow(script).meta.name).toBe("module-audit");
  const agentID = "configured-in-test-only";
  const calls: z.infer<typeof WorkflowAgentInput>[] = [];
  const host: WorkflowHost = {
    agent: async (input) => { const step = WorkflowAgentInput.parse(input); calls.push(step); return { findings: [] }; },
    phase: async () => {}, log: async () => {}, checkpoint: async () => null, workflow: async () => null,
  };
  expect(await executeWorkflow({ script, args: { reviewerAgent: agentID, modules: ["src/auth", "src/billing"], check: "missing authorization checks" },
    signal: new AbortController().signal, host })).toEqual([{ findings: [] }, { findings: [] }]);
  expect(calls.map(({ key, agent, access }) => ({ key, agent, access }))).toEqual([
    { key: "audit:src/auth", agent: agentID, access: "read" }, { key: "audit:src/billing", agent: agentID, access: "read" },
  ]);
});

test("missing workflow profile is rejected without fallback while worker Spawn still permits omission", async () => {
  const script = await sample();
  let dispatched = 0;
  const host: WorkflowHost = { agent: async () => { dispatched++; return null; }, phase: async () => {},
    log: async () => {}, checkpoint: async () => null, workflow: async () => null };
  for (const reviewerAgent of [undefined, null, "", " "]) {
    const args = { modules: ["src/auth"], check: "authorization", ...(reviewerAgent === undefined ? {} : { reviewerAgent }) };
    await expect(executeWorkflow({ script, args, host, signal: new AbortController().signal })).rejects.toThrow("Supply args.reviewerAgent");
  }
  expect(dispatched).toBe(0);
  expect(WorkflowAgentInput.safeParse({ key: "audit", prompt: "inspect" }).success).toBe(false);
  expect(Spawn.parse({ key: "worker", title: "Review", directory: "/fixture", task: "Inspect" }).agent).toBeUndefined();
});

test("the shipped example rejects invalid audit inputs before dispatch", async () => {
  const script = await sample();
  let dispatched = 0;
  const host: WorkflowHost = { agent: async () => { dispatched++; return null; }, phase: async () => {},
    log: async () => {}, checkpoint: async () => null, workflow: async () => null };
  for (const input of [{ modules: [] }, { modules: "src/auth" }, { modules: [42] }, { modules: ["src/auth"], check: "" }]) {
    await expect(executeWorkflow({ script, args: { reviewerAgent: "configured-in-test-only", check: "authorization", ...input },
      host, signal: new AbortController().signal })).rejects.toThrow("Supply non-empty args.modules and args.check");
  }
  expect(dispatched).toBe(0);
});
