import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

test("the packaged capability protocol retains required boundaries (not model compliance)", async () => {
  const doc = await Bun.file("skills/managed-sessions/references/capability-preflight.md").text();
  const skill = await Bun.file("skills/managed-sessions/SKILL.md").text();
  for (const text of [doc, skill]) {
    for (const term of ["before substantive work", "CodeMode", "safe authorized read", "BLOCKED", "INCONCLUSIVE", "zero findings", "Linear", "coordinator", "coverage"])
      expect(text).toContain(term);
  }
  expect(doc).toContain("| Required capability | Authorized target | Available route to check | Safe proof |");
  expect(doc).toContain("paths` grants do not override explicit denies");
  expect(doc).toContain("They cannot prove that a model follows it.");
  expect(skill).toContain("references/capability-preflight.md");
  const index = await Bun.file("docs/capability-preflight.md").text();
  expect(index).toContain("../skills/managed-sessions/references/capability-preflight.md#coordinator-acceptance-policy");
  expect(index).not.toContain("| Required capability |");
});

test("copying only the managed-sessions skill preserves its supporting references", async () => {
  const artifacts = resolve(".audit/lite-followups");
  await mkdir(artifacts, { recursive: true });
  const isolated = await mkdtemp(join(artifacts, "copied-skill-"));
  try {
    const copied = join(isolated, "skills/managed-sessions");
    await cp("skills/managed-sessions", copied, { recursive: true });
    const skill = await Bun.file(join(copied, "SKILL.md")).text();
    const links = [...skill.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const [path, anchor] = link.split("#");
      const target = resolve(copied, path);
      const within = relative(copied, target);
      expect(isAbsolute(within) || within.startsWith("..")).toBe(false);
      expect((await stat(target)).isFile()).toBe(true);
      if (anchor) expect(await Bun.file(target).text()).toContain("## Coordinator acceptance policy");
    }
    expect(await Bun.file(join(copied, "references/capability-preflight.md")).text()).toContain("Missing required access means BLOCKED with an INCONCLUSIVE report");
    expect(await Bun.file(join(isolated, "docs/capability-preflight.md")).exists()).toBe(false);
  } finally { await rm(isolated, { recursive: true, force: true }); }
});
