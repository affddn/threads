# Capability preflight for delegated work

Access is part of the brief, not an assumption. Before substantive work, the worker proves the capabilities the task needs in its actual session. This protocol uses existing tools and report verdicts. It does not add startup orchestration or require another agent.

## Brief template

The coordinator includes the selected profile, assigned absolute directory, scope, and a task-specific table:

| Required capability | Authorized target | Available route to check | Safe proof |
| --- | --- | --- | --- |
| Repository read | Assigned checkout and named files | Direct read, or an available CodeMode filesystem tool | Read one named non-secret file |
| Local verification | Assigned checkout | Direct shell, or an available execution tool | Runtime version, then the specified checks |
| External reference read, if needed | Named absolute reference path | Read tool plus explicit `paths` grant when needed | Read a named non-secret reference file |
| Service read, if needed | Named project and record | Direct service tool, or CodeMode discovery and call | Fetch one authorized non-sensitive record |

The rows are examples, not universal dependencies. A tool name in a brief does not make that tool available. A direct tool and a CodeMode route are alternatives, not interchangeable names: discover the available route and execute its safe read. CodeMode discovery alone proves discovery, not access.

For example, a **read-only Linear review** might require the configured read-only profile, the assigned checkout, and read access to one specified Linear issue. The worker discovers the installed Linear read tool, directly or through CodeMode, and fetches that authorized issue. A repository-only review does not need Linear. Neither check asks for secrets or makes production writes.

## Worker check

1. Identify the actual worker/session, selected profile, and assigned directory from available session context. Distinguish a requested profile from one confirmed by the returned worker view or host context. If identity cannot be confirmed, state that limit rather than inventing it.
2. Check each required tool route and perform its safe authorized read or runtime version check. Check required external paths separately. `paths` grants do not override explicit denies or profile restrictions.
3. Return a brief receipt: profile and identity evidence, directory, required capability, tool route used, exact non-secret target, result, and coverage limits. Do this before substantive work.
4. If required access is missing, stop with status **BLOCKED** and report verdict **INCONCLUSIVE**. Name the unavailable coverage and blocker. Unavailable access is not zero findings. Do not infer a clean review from work that could not run.

Never repair access by expanding permissions, changing profiles, extracting credentials, or substituting an unapproved service. Ask the coordinator to resolve the blocker. Keep secrets out of receipts. A follow-up can reuse the existing worker once authorized access is restored.

## Coordinator acceptance policy

> Before substantive delegated work, require a capability preflight in the actual worker session: confirm the worker/profile and assigned directory, identify an available direct-tool or CodeMode route for every required capability, and prove it with a safe authorized read or local runtime check. Review the receipt against the brief before treating the result as review coverage. Missing required access means BLOCKED with an INCONCLUSIVE report and explicitly unavailable coverage, never zero findings. Do not expand permissions automatically. External path grants never override denies. Keep successful access proof separate from substantive verification and review the latter independently.

The coordinator's existing agent instructions or delegation skill can adopt this policy after owner review. Confirm the actual configuration owner and path before editing. This skill's contract is in `references/capability-preflight.md`. No specific coordinator profile or global installation is required.

Documentation tests can check that this contract ships. They cannot prove that a model follows it.
