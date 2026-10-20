---
name: Workflow authoring
description: Author and run durable dynamic JavaScript workflows in OpenCode with parallel agents, structured handoffs, and resumable progress.
---

# Workflow authoring

Use a workflow for broad independent work or a pipeline whose later steps consume earlier results. Keep small, tightly coupled tasks with one owner.

For work across repositories, put the coordinator session in a directory that contains the intended sources, then set each step's `directory` to its repository. The worker uses that repository's OpenCode project for worktree isolation. Choose the scoped common ancestor before starting the run; a prompt mentioning another absolute path does not grant directory access.

When a step needs a directory outside its location, such as a reference repository, list it in the step's `paths`. The worker can then use that directory and its subdirectories without asking, within its `access`: a read step still cannot edit files or run commands there. A step's `directory` may also be inside a granted path if its whole project, meaning its git worktree or the directory itself outside a repository, is granted and no explicit `external_directory` deny matches anything in it. Explicit `external_directory` denies from the coordinator or the role still win. Without a grant, a directory that the coordinator would have to approve raises an approval request in a write worker's tab, and the step waits for the answer. Read steps follow their role's `external_directory` rules.

1. Define the result, named slices, and verification predicate. Retain the task's authorization, delegation limits, and evidence requirements.
2. Read [the runtime contract](references/runtime.md), including its [capability preflight](references/runtime.md#capability-preflight). Write a script with a literal `export const meta` first, named agent steps, and a final JSON result.
3. Call `workflows_start` with a unique task key, `script` or saved `name`, JSON `args`, and suitable concurrency. Omit task budgets unless the user requested them. It returns immediately.
4. Continue independent work. The runner delivers a final notification. Use `workflows_inspect` for evidence and `workflows_control` for pause, stop, resume, and checkpoint responses. Never infer success from an idle worker.
5. Inspect the result and the affected artifacts before giving the final verdict. Save a useful script with `workflows_save`; its arguments and transcripts are not saved with it.

Every `agent()` step requires an explicit configured `agent` ID; omission does not inherit the caller's profile. Naming a role in the prompt does not select a profile. Confirm an existing profile's capabilities and the coordinator's permission to select it in the step's directory. The caller's profile can be selected explicitly if suitable and permitted. Threads requires no custom profiles. Selected profiles supply their real prompts, model preferences, and permissions; a profile without a model uses the caller's resolved model. Model choices remain in profiles. Workflow workers are leaves. Any user-supplied run budgets also cover nested workflows.

If a required profile or capability is unavailable, stop BLOCKED/INCONCLUSIVE and name the missing coverage. Do not install profiles, invent IDs, or widen permissions automatically. The coordinator can choose an existing permitted profile in a new workflow request with a new key. Do not change a retained run's script or arguments to bypass its identity checks.

Budgets are opt-in. Do not estimate or invent `tokenBudget`, `maxAgents`, `agentTimeoutMs`, `timeoutMs`, helper `attempts` or `maxRounds`, heartbeat wake caps, or monitoring deadlines. Leave those fields unset unless the user supplies a limit. If the user asks for a budget without giving a value, ask for the value instead of estimating it. An omitted budget means no task budget, not an estimated fallback. Preserve explicitly configured user limits. Concurrency and worker capacity are separate settings.

Use `access: "read"` for investigations. It denies edits and shell commands. Real command-based verification needs a suitably permitted worker with `access: "write"`, even when its intended task is only running tests. Use `isolation: "worktree"` for independent implementations and return the retained directory and changed paths. Give subsequent verification the same directory. The root owns integration. When the run ends, Threads removes step worktrees that hold no uncommitted changes and no commits outside a branch, so ask writers whose work outlives the run to commit to a named branch and return its name.

Verification evidence is part of the handoff. `FAIL` and `INCONCLUSIVE` cannot establish a passing step. Do not replace execution evidence with reviewer votes. A workflow does not expand the user's authorization for external actions.

Workers finish required commands and inspect their results before reporting or ending their execution. Keep dependent checks in a foreground tool call; if a tool backgrounds them, collect its completion before finishing. A missing-report reminder asks the worker to complete the handoff, not cancel unfinished checks. Native idle while a command is still running is not task completion.

For requested unattended monitoring, use the packaged `workflows_heartbeat_*` tools and shared runner described in [heartbeat monitoring](references/runtime.md#heartbeat-monitoring). Enroll the recorded run instead of creating a project-specific monitor. Heartbeat reminders ask for inspection; they do not answer checkpoints or establish completion. Mark an authorized coordinator review with `checkpoint(prompt, { key, reviewer: "coordinator" })`; checkpoints default to human review.

## Example

```javascript
export const meta = {
  name: "module-audit",
  description: "Audit named modules and return source-backed findings",
};

if (!args || typeof args.reviewerAgent !== "string" || !args.reviewerAgent.trim()) {
  throw new Error("Supply args.reviewerAgent as a confirmed, permitted configured agent ID");
}
if (!Array.isArray(args.modules) || !args.modules.length ||
    args.modules.some(module => typeof module !== "string" || !module.trim()) ||
    typeof args.check !== "string" || !args.check.trim()) {
  throw new Error("Supply non-empty args.modules and args.check");
}

await phase("Audit");
const findings = await pipeline(args.modules, module => agent(
  `Audit ${module} for ${args.check}. Before substantive work, confirm your profile and directory and prove authorized source-read access. If blocked, report INCONCLUSIVE with unavailable coverage, not zero findings. Read the actual source. Return concrete findings with paths and line numbers.`,
  {
    key: `audit:${module}`,
    agent: args.reviewerAgent,
    access: "read",
    schema: {
      type: "object",
      properties: { findings: { type: "array", items: { type: "string" } } },
      required: ["findings"],
      additionalProperties: false,
    },
  },
));
return findings;
```

Before invoking, set `confirmedReviewerAgentID` to an existing configured ID confirmed through authorized host or configuration evidence in the step's directory. It can be the caller's profile if suitable and permitted. The variable is not a built-in agent name. Set `moduleAuditScript` to the example script above:

```javascript
workflows_start({
  key: "module-audit-1",
  script: moduleAuditScript,
  args: {
    reviewerAgent: confirmedReviewerAgentID,
    modules: ["src/auth", "src/billing"],
    check: "missing authorization checks",
  },
});
```

The script checks argument shape, not profile availability or permissions; the production dispatcher still checks those. The default concurrency is three; plugin options can override it. The `workflows_start` schema shows explicitly configured limits. Do not derive a `maxAgents` budget from the planned slices.

The example returns candidate findings. Add an independent confirmation stage when the task requires a verified report.
