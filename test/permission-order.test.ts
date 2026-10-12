import { expect, test } from "bun:test";
import type { Permission } from "@opencode/schema/permission";
import { workerRestrictions } from "../src/external-access";
import { workflowPermissions } from "../src/threads";
import { nativeEvaluate } from "./permission-oracle";

// Execute the native evaluator and wildcard implementation, not our local matcher.
const nativeTest = nativeEvaluate ? test : test.skip;
const evaluate = (action: string, resource: string, ...rules: Permission.Ruleset[]) => {
  if (!nativeEvaluate) throw new Error("Set OPENCODE_SOURCE to run the native oracle");
  return nativeEvaluate(action, resource, ...rules);
};
const rule = (action: string, resource: string, effect: Permission.Effect): Permission.Rule => ({ action, resource, effect });
const parent = [rule("*", "*", "allow"), rule("external_directory", "*", "ask"), rule("read", "*.env", "ask"), rule("read", "*.env.*", "ask"), rule("read", "*.env.example", "allow")];
const role = [rule("*", "*", "deny"), rule("read", "*", "allow"), rule("external_directory", "/refs/*", "allow")];

nativeTest("native oracle: inherited env exceptions survive without widening role or caller boundaries", () => {
  for (const access of ["read", "write"] as const) {
    const session = workflowPermissions(parent, { access, role });
    for (const file of ["/project/.env", "/project/.env.production"]) expect(evaluate("read", file, role, session).effect).toBe("deny");
    expect(evaluate("read", "/project/.env.example", role, session).effect).toBe("allow");
    for (const action of ["shell", "edit", "mcp_test", "subagent", "threads_spawn", "workflows_start"]) expect(evaluate(action, "*", role, session).effect).toBe("deny");
    const scoped = [...parent, rule("read", "*.env.*", "deny"), rule("read", "*.env.example", "allow")];
    expect(evaluate("read", "/project/.env.example", role, workflowPermissions(scoped, { access, role })).effect).toBe("allow");
    const denied = [...parent, rule("read", "*.env.example", "deny")];
    expect(evaluate("read", "/project/.env.example", role, workflowPermissions(denied, { access, role })).effect).toBe("deny");
  }
});

nativeTest("native oracle: ordered external restrictions keep caller asks and later shared allows", () => {
  const decide = (caller: Permission.Ruleset, profile = role) => evaluate("external_directory", "/refs/a", profile, workerRestrictions(caller, profile)).effect;
  expect(decide(parent)).toBe("ask");
  expect(evaluate("external_directory", "/elsewhere/a", role, workerRestrictions(parent, role)).effect).toBe("deny");
  const shared = [...parent, rule("external_directory", "/refs/*", "allow")];
  expect(decide(shared)).toBe("allow");
  expect(decide([...shared, rule("external_directory", "/refs/private/*", "deny")])).toBe("allow");
  expect(decide([...shared, rule("external_directory", "/refs/*", "deny")])).toBe("deny");
  expect(decide(shared, [...role, rule("external_directory", "/refs/*", "deny")])).toBe("deny");
  expect(decide(shared, [...role, rule("*", "*", "deny")])).toBe("deny");
  expect(evaluate("external_directory", "/refs/a", role, workflowPermissions(parent, { access: "write", role, paths: ["/refs"] })).effect).toBe("allow");
});

nativeTest("native oracle: coordinator and role tool denies survive all scoped restoration", () => {
  const profile = [rule("*", "*", "allow"), rule("shell", "*", "deny"), rule("edit", "*", "deny"), rule("mcp_*", "*", "deny"), rule("read", "*.env.example", "deny")];
  for (const access of ["read", "write"] as const) {
    const caller = [...parent, rule("grep", "private*", "deny")];
    const session = workflowPermissions(caller, { access, role: profile });
    for (const action of ["shell", "edit", "mcp_test"]) expect(evaluate(action, "*", profile, session).effect).toBe("deny");
    expect(evaluate("read", "/project/.env.example", profile, session).effect).toBe("deny");
    expect(evaluate("grep", "private-key", profile, session).effect).toBe("deny");
  }
});

nativeTest("native oracle: scoped external asks retain the existing read exemption but write still asks", () => {
  const caller = [rule("*", "*", "allow"), rule("external_directory", "/refs/*", "ask")];
  const profile = [rule("*", "*", "deny"), rule("read", "*", "allow"), rule("external_directory", "*", "allow")];
  expect(evaluate("external_directory", "/refs/a", profile, workflowPermissions(caller, { access: "read", role: profile })).effect).toBe("allow");
  expect(evaluate("external_directory", "/refs/a", profile, workflowPermissions(caller, { access: "write", role: profile })).effect).toBe("ask");
  const denied = [...caller, rule("external_directory", "/refs/private/*", "deny")];
  for (const access of ["read", "write"] as const) expect(evaluate("external_directory", "/refs/private/a", profile, workflowPermissions(denied, { access, role: profile })).effect).toBe("deny");
});

nativeTest("native oracle: explicit grants override baselines, not explicit external or role tool denies", () => {
  const profile = [...role, rule("external_directory", "/refs/private/*", "deny")];
  const caller = [...parent, rule("external_directory", "/refs/secret/*", "deny")];
  for (const access of ["read", "write"] as const) {
    const session = workflowPermissions(caller, { access, role: profile, paths: ["/refs"] });
    expect(evaluate("external_directory", "/refs/a", profile, session).effect).toBe("allow");
    for (const resource of ["/refs/private/a", "/refs/secret/a", "/outside/a"]) expect(evaluate("external_directory", resource, profile, session).effect).toBe("deny");
    for (const action of ["shell", "edit", "mcp_test", "subagent", "workflows_start"]) expect(evaluate(action, "/refs/a", profile, session).effect).toBe("deny");
  }
});

nativeTest("native oracle: non-nested intersections may overdeny but never broaden", () => {
  const effects = ["deny", "ask", "allow"] as const;
  const weight = { deny: 0, ask: 1, allow: 2 };
  const patterns = ["*", "a*", "*b", "a?", "*.env", "*.env.*", "*.env.example", "rm *", "rm ?", "a.b", "a\\b"];
  const resources = ["", "a", "b", "ab", "aab", "ac", "a\nb", "a.env", "a.env.b.env", "a.env.example", "rm", "rm x", "a.b", "a/b"];
  for (const left of patterns) for (const right of patterns) for (const p of effects) for (const r of effects) {
    const caller = [rule("*", "*", "allow"), rule("read", left, p)];
    const profile = [rule("*", "*", "deny"), rule("read", right, r)];
    const session = workerRestrictions(caller, profile);
    for (const resource of resources) {
      const parentEffect = evaluate("read", resource, caller).effect;
      const bound = Math.min(weight[parentEffect === "ask" ? "deny" : parentEffect], weight[evaluate("read", resource, profile).effect]);
      expect(weight[evaluate("read", resource, profile, session).effect]).toBeLessThanOrEqual(bound);
    }
  }
  const caller = [rule("read", "a*", "allow")];
  const profile = [rule("*", "*", "deny"), rule("read", "*b", "allow")];
  expect(evaluate("read", "ab", caller).effect).toBe("allow");
  expect(evaluate("read", "ab", profile).effect).toBe("allow");
  expect(evaluate("read", "ab", profile, workerRestrictions(caller, profile)).effect).toBe("deny");
});
