# Configuration

Threads has two parts, and each has its own config entry:

- The **server plugin** runs workers and workflows. It lives in `~/.config/opencode/opencode.json` or `opencode.jsonc`.
- The **terminal plugin** draws the footer indicator, the Threads list, the workflow panel, and the sidebar's Workflows section. It lives in `~/.config/opencode/cli.json`.

Both entries use the same package, `@op1/threads`.

## Server plugin

The smallest entry is the package name:

```jsonc
{
  "plugins": ["@op1/threads"]
}
```

To set options, use an object:

```jsonc
{
  "plugins": [
    {
      "package": "@op1/threads",
      "options": { "maxWorkers": 8, "workflowConcurrency": 8 }
    }
  ]
}
```

Keep your other plugin entries in the list.

### Server options

| Option | Default | Range | What it controls |
| --- | --- | --- | --- |
| `mode` | `"full"` | `"lite"` or `"full"` | Lite registers only managed-worker features. See [lite worker mode](lite-worker-mode.md). |
| `maxWorkers` | 4 | 1–32 | Unfinished workers per conversation. Workflow steps owned by that conversation count against the same limit. |
| `workflowConcurrency` | 3 | 1–8 | Steps that one new workflow runs at the same time. |
| `workflowMaxAgents` | Unset | 1–1,000 when supplied | Optional user-selected total-step budget for new workflows. |
| `workflowWorktreeCleanup` | `true` | `true` or `false` | Whether a workflow removes its clean step worktrees when it ends. |

A worker stops counting against `maxWorkers` when it reports, or when its run fails or is interrupted. A worker whose run ends without a report keeps its slot until you deal with it.

Values passed to `workflows_start` override configured workflow values. Task budgets have no built-in defaults; agents leave them unset unless requested. Existing runs keep the limits they started with. A run never has more active steps than `maxWorkers` allows. To run eight steps at once, set `maxWorkers` and `workflowConcurrency` to at least 8.

With `workflowWorktreeCleanup` set to `false`, finished runs keep all their step worktrees until you run `workflows_prune`. The setting affects only runs that end while it applies. See [clean up worktrees](workflows.md#clean-up-worktrees).

## Terminal plugin

```json
{
  "plugins": [{ "package": "@op1/threads" }]
}
```

The terminal plugin accepts `mode: "lite" | "full"`, defaulting to `"full"`. Server options don't reach it. To use lite mode, set `"options": { "mode": "lite" }` on **both** plugin entries. Invalid modes fail before plugin registration.

Keep existing workflow locations in full mode. Lite is not a migration and does not resume workflows or heartbeat monitors. A mismatch leaves workflow UI without its server RPC, or a full server without workflow UI. See [lite worker mode](lite-worker-mode.md) for the feature boundary.

The terminal warns on mismatched worker-snapshot metadata, labeling the actual responding directory. Fallback snapshots verify neither the primary nor focused location; legacy servers without metadata remain unconfirmed. Warnings do not disable workers or guard active workflow migrations.

## Pin a version

Add the version to the package name in both files, for example `@op1/threads@0.3.2`.

## Use a local checkout

1. Clone the repository and run `bun install`.
2. In both files, replace `@op1/threads` with the absolute path of the clone.
3. Restart OpenCode.

Local and published installs share the plugin ID `op-threads`, so switching between them keeps your worker records.

## Commands

| Command | Action |
| --- | --- |
| `/activities` or `ctrl+x j` | Open the Threads list for the current conversation. |
| `/threads` | Bring back hidden and dismissed workers, then open the Threads list. |
| `/workflow-run <task>` | Ask the agent to write and start a workflow. |
| `/workflows` | Open the workflow navigator. |
| `/workflow-<name>` | Run a saved workflow with new input. |
| `/workflow-refresh` | Reload saved workflow commands after you edit their files. |

`ctrl+x` is OpenCode's default leader key, so the list shortcut is `<leader>j`.

## Shortcuts

In the Threads list:

| Key | Action | Command ID |
| --- | --- | --- |
| Type | Search | |
| **Up**, **Down**, **Ctrl+P**, **Ctrl+N** | Move the highlight | |
| **Enter** | Open the highlighted conversation | |
| **Ctrl+D** | Dismiss the row, or bring a closed row back | `threads.activity.choose.dismiss` |
| **Esc** | Close the list | |

In the workflow panel:

| Key | Action | Command ID |
| --- | --- | --- |
| **Up**, **Down** | Select a step | `workflows.previous-step`, `workflows.next-step` |
| **Enter** | Open the step's worker | `workflows.open-step` |
| `p` | Pause | `workflows.pause` |
| `r` | Resume | `workflows.resume` |
| `x` | Stop | `workflows.stop` |
| `s` | Save the script | `workflows.save` |
| `f` | Toggle full screen | `workflows.fullscreen` |
| **Esc** | Close the panel | `workflows.close` |

To change a shortcut, set its command ID under `keybinds` in `cli.json`. The list's own ID is `threads.activity.choose`:

```json
{
  "keybinds": { "threads.activity.choose": "<leader>t" }
}
```

## Skills

The plugin loads the `workflow-authoring` skill by itself. `/workflow-run` uses it.

The `managed-sessions` skill is optional. To use it, copy [`skills/managed-sessions`](../skills/managed-sessions) into `~/.config/opencode/skills/`.
