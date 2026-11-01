# Goal reference

Goals attach an objective to the current Pi session. An active goal can continue across turns until the agent verifies completion, the user pauses it, a budget is exhausted, or a continuation guard stops it.

## Commands

| Command | Behavior |
| --- | --- |
| `/goal` | Shows the objective, status, tokens used, optional token budget, and active execution time. |
| `/goal <objective>` | Creates or replaces the session goal and starts work when idle. Resets usage and removes any previous budget. |
| `/goal --tokens N <objective>` | Creates or replaces a goal with a positive integer token budget. |
| `/goal pause` | Pauses the goal and interrupts its running operation. |
| `/goal resume` | Resumes an active, paused, or blocked goal when its token budget permits. Resets the blocked audit. |
| `/goal clear` | Removes the current goal and prevents further automatic continuation. |
| `/goal edit` | Opens an editor for the objective. Requires an interactive UI. |
| `/goal edit <objective>` | Updates the objective while retaining usage and budget. A paused or blocked goal stays stopped. A completed goal becomes active when budget remains. |
| `/goal budget N` | Sets the current goal's total token budget. Does not automatically resume a stopped goal. |

Objectives contain 1 to 4000 Unicode characters after trimming whitespace. `pause`, `resume`, `clear`, `edit`, and `budget` are reserved command words. Goals have no token budget unless one is explicitly supplied.

When a budget is exhausted, increasing it and resuming requires two commands:

```text
/goal budget 100000
/goal resume
```

## Model tools

The extension registers `get_goal`, `create_goal`, and `update_goal` with Pi.

`get_goal` returns the current goal and remaining tokens. `create_goal` accepts an `objective` and optional `token_budget`. Its instructions permit creation only on an explicit user request. It refuses to replace an unfinished goal.

`update_goal` accepts `complete`, `blocked`, or `paused`. Its instructions require evidence for every requirement before completion. Blocking requires the same genuine blocker to persist for at least three consecutive goal turns with no useful action available. The extension enforces a minimum of three turns; the model audits whether the blocker remained the same. Pausing requires an explicit user request. The tool cannot resume a goal or change its budget.

Goal tools return usage so the agent can report consumed tokens after completing a budgeted goal. Completion and blocker assessments depend on the model's evidence audit.

## Continuation and interruption

The extension requests continuation at Pi's `agent_before_settle` boundary. It appends a hidden context message and requests one more model turn. Existing boundary entries from other extensions are retained.

Queued messages and continuations from other extensions take priority. A new user message steers the goal. The latest goal state enters model context on every request, including after compaction or an objective edit. Goal text is encoded as user-provided data.

An automatic turn with no tool calls suppresses the next goal continuation. The goal remains active; `/goal resume` explicitly retries it. A provider or execution error that reaches final settlement blocks the goal. Escape pauses it. The extension uses no timer or background worker.

`/goal clear` prevents further automatic turns but lets a running operation finish. `/goal pause` interrupts the running operation. Clearing or pausing does not undo tool actions.

## Usage and persistence

Token usage is Pi's uncached input plus cache-write input plus output, including reasoning when the provider includes it in output. Cache-read tokens are excluded, matching Codex's goal accounting. Usage counts responses whose provider request started while this goal was active. The request that creates a goal through `create_goal` precedes activation and is not charged.

The budget is a soft limit checked after each assistant response. A response can exceed it. Once exhausted, the extension blocks substantive goal tools and requests one summary turn. Summary requests after exhaustion are not charged to the goal. Later unrelated user requests can still use tools normally. Raising the budget does not reset consumed tokens.

Time usage counts active execution in this Pi process. It excludes paused time and time while a saved session is closed. Tokens and time persist in custom session entries. Ephemeral sessions retain those entries only in memory.

History restoration uses the active branch. Opening a session, navigating the session tree, or reloading restores an active goal as paused. This prevents history restoration from starting work without a resume command.

## Codex implementation sources

This is an independent TypeScript implementation of Codex's goal behavior, adapted to Pi 1.3.0 extension hooks. The research used [OpenAI's goal guide](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) and the public [`openai/codex` source at revision `67f0994`](https://github.com/openai/codex/tree/67f0994b532b8740f14b5b738af7b7b2a915b1d6).

The relevant upstream files are:

- [Model tool contracts](https://github.com/openai/codex/blob/67f0994b532b8740f14b5b738af7b7b2a915b1d6/codex-rs/ext/goal/src/spec.rs).
- [Continuation and completion audit](https://github.com/openai/codex/blob/67f0994b532b8740f14b5b738af7b7b2a915b1d6/codex-rs/ext/goal/templates/goals/continuation.md).
- [Idle continuation dispatcher](https://github.com/openai/codex/blob/67f0994b532b8740f14b5b738af7b7b2a915b1d6/codex-rs/ext/goal/src/runtime.rs).
- [Token accounting](https://github.com/openai/codex/blob/67f0994b532b8740f14b5b738af7b7b2a915b1d6/codex-rs/ext/goal/src/accounting.rs).
- [Terminal goal summary](https://github.com/openai/codex/blob/67f0994b532b8740f14b5b738af7b7b2a915b1d6/codex-rs/tui/src/chatwidget/goal_menu.rs).

Pi stores goals in session entries instead of Codex's thread database. This port supports in-memory chats, adds `--tokens` and `budget` command syntax, and requires explicit resume after history restoration. It does not implement Codex-specific plan mode admission, account usage-limit detection, descendant-agent accounting, or goal attachments. Errors use the `blocked` status because Pi does not expose Codex's account-limit classification.
