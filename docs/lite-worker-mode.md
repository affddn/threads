# Lite worker mode

Lite is an opt-in runtime boundary for managed workers, not a new plugin or a migration. Both entry points default to full mode. The plugin ID and storage keys stay unchanged.

The server and terminal read their own `options.mode`. Neither entry configures the other. Both accept only `"lite"` and `"full"` and validate the mode before registration. [Configuration](configuration.md) describes the entries. Existing workflow locations must remain full. No installation or configuration changes are part of this implementation.

## Keep, omit, and optional

| Boundary | Lite behavior |
| --- | --- |
| Keep | All six `threads_*` tools, worker RPC, prompt and context hooks, native permission checks, worker identities, keyed retries, explicit reports, follow-up recovery, worker list and footer, and worker commands. |
| Omit | Workflow engine and heartbeat initialization; workflow and heartbeat tools and RPC; workflow skill and server commands; workflow navigator, panels, sidebar, and workflow refresh. |
| Optional | Full mode retains all existing workflow features. Workflow options apply only there. |

A full terminal with a lite server can request unavailable workflow RPC. A lite terminal with a full server hides workflow controls but does not stop the engine. There is no cross-entry mode negotiation.

Lite uses the same worker implementation and unchanged briefing and report contracts. `threads.ts` still contains workflow helpers and execution-grant bookkeeping. Its workflow project assertion loads `workflow-worker.ts` only in the workflow worker path. Shared path schemas live in `granted-paths.ts`, with compatible exports from `workflow-types.ts`.

Workflow modules load lazily in full mode, including in Solid-compiled `tui.js`. This is runtime isolation, not a smaller tarball. The package still contains workflow source, skills, and the compiled workflow UI. Installed-package rendering and keyboard verification remain separate release requirements.

## Ownership with OpenBot

OpenCode remains the executor: sessions, prompts, outcomes, permissions, and interruption. OpenBot can own high-level policy and coordination. Threads owns its managed-worker identity, coordinator ownership, keyed retries, reports, and recovery. This is a boundary sketch, not an integration shipped by this change.

The bounded OpenBot evidence is `open-bot/src/opencode.ts:98–150` in the sibling checkout: its adapter directly calls native session create, prompt, get, and interrupt, and reads native inspection data. That evidence does not establish an existing Threads integration or a need to replace the executor.

## Static registration overhead

With no saved workflow commands, the production registration harness reports:

| Measure | Full (also default) | Lite |
| --- | ---: | ---: |
| Tools | 19 | 6 |
| Tool description UTF-8 bytes | 4,721 | 1,564 |
| Tool input and output JSON schema bytes | 58,705 | 7,179 |
| Session hooks | 4 | 2 |
| Injected skills | 1 | 0 |
| Server commands | 2 | 0 |

Reproduce with `XDG_CONFIG_HOME="$PWD/.audit/lite-empty-config" bun scripts/measure-mode-overhead.ts full` and the same command with `lite`. The directory must have no saved workflows. Schemas are Zod JSON-schema exports with transformed inputs represented by their input schemas. Counts exclude host-provided tools and commands. Saved workflows add server commands in full mode. These are static bytes, not token counts, latency, memory, or paid-model measurements.

## Ranked follow-ons

1. Add cross-entry mode diagnostics before considering wider rollout.
2. Verify a packed lite installation in an isolated native terminal, including worker list keyboard input and full-mode regression coverage.
3. Measure native idle and active overhead before making performance claims.
4. Consider a separate worker-only package only if runtime isolation is insufficient. Keep briefing and report contract changes out of that packaging decision.
