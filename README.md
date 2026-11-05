# pi-qol

Quality of life tools for [Pi](https://pi.dev), bundled in one extension.

## Included features

- [Answer interactive questions](#answer-questions) with single-choice, multiple-choice, and typed responses.
- [Name new threads automatically](#name-threads) with a configurable model, effort, and prompt.
- [Work toward a persistent goal](#work-toward-a-goal) across turns, with an optional token budget.
- [Toggle installed Pi extensions](#toggle-plugins) with a searchable `/plugins` picker.
- [See response statistics](docs/reference.md#response-statistics) for input and output tokens, tokens per second, time to first token, and cost in USD.
- [Customise the status line](#customise-the-status-line) with colour and your choice of modules, including status text from other plugins.
- [Continue interrupted work](#continue-interrupted-work) with `/continue` or Ctrl+Alt+C.
- Cycle supported thinking levels with `Alt+,` and `Alt+.`.
- [Start ephemeral chats](#start-an-ephemeral-chat) that keep session history in memory.
- [Open a saved thread](#open-a-thread) from a searchable picker with date and project groups, as an alternative to `/resume`.
- [Delete threads](#delete-threads) individually or through the same picker.
- [Export chats as HTML](#export-a-chat) with offline LaTeX, printing, and a redaction preview for sharing.

## Install

Requires Node.js 22.19 or later and Pi 1.3.x.

Before installing, remove any standalone packages that pi-qol replaces.

Run only the removal commands that match your installations:

```sh
pi remove git:github.com/thgilciffart/pi-ask-questions
pi remove npm:@thgilciffart/pi-ephemeral
pi remove npm:pi-better-export
```

If you installed `pi-ask-questions` from npm, use `pi remove npm:pi-ask-questions` instead. For extensions loaded through a local path or settings file, remove those entries.

Install pi-qol:

```sh
pi install git:github.com/thgilciffart/pi-qol
```

Run `/reload` in an open Pi session.

## Answer questions

The bundled `ask_user` tool from `pi-ask-questions` supports single-choice, multiple-choice, and typed answers.

Background mode lets Pi continue independent work while you answer. Urgent mode waits for your response. Use Tab to switch questions, Space or number keys to select options, and Enter to confirm. Press Escape twice or Ctrl+C to cancel.

See the [questionnaire reference](docs/questions.md) for modes, controls, and structured results.

## Name threads

Send the first message in a new chat. Pi generates a short thread name in the background using the current model with reasoning off. Existing threads and manual names stay unchanged.

Run `/auto-name` to configure the model, effort, and prompt. The model picker supports search. Tab switches between all and scoped models. Direct commands include:

```text
/auto-name model provider/model-id
/auto-name effort low
/auto-name prompt
/auto-name off
/auto-name now
```

Settings apply across chats. See the [automatic naming reference](docs/auto-name.md) for defaults and prompt editing.

## Work toward a goal

Use `/goal` to keep Pi working toward a verifiable outcome across turns:

```text
/goal Make the checkout tests pass without changing the public API
/goal --tokens 50000 Reduce benchmark latency below 120 ms and verify correctness
```

Pi starts work immediately. The editor shows the goal's status, elapsed time, and consumed tokens or token budget. The agent marks the goal complete after verifying the outcome.

Use `/goal pause`, `/goal resume`, and `/goal clear` to control it. Use `/goal edit` to revise the objective. Escape pauses an interrupted goal. Ordinary messages steer an active goal without pausing it.

Goals survive compaction and session restarts. Reopened sessions restore goals paused. Give directions to continue or run `/goal resume`.

See the [goal reference](docs/goals.md) for commands, budget accounting, and continuation guards.

## Toggle plugins

Run `/plugins` to enable or disable installed Pi extensions. Packages with one extension use a single row. Packages with several extensions show their files in a folder tree.

Type to search, use Up/Down to select an extension, and press Space to toggle it. Each toggle moves the selection to the next extension. Press Ctrl+S to save your changes and reload Pi. Escape or Ctrl+C discards unsaved changes.

The picker opens global settings. Press Tab to switch to project settings, or run `/plugins project`. Project settings can enable, disable, or inherit a global extension. Pi must trust the project before you can change its settings.

Plugin choices persist across sessions. The picker controls whole extensions, including their commands, tools, and event handlers. Features inside pi-qol remain bundled together.

See the [plugin reference](docs/plugins.md) for scope behavior and reload details.

## Customise the status line

Run `/statusline` to open the status line editor. Choose which modules appear, place them on the left or right of any row, change their order, and preview the result before saving. Use Left/Right to choose a side, `1`–`9` to choose a row, `+`/`-` to move between rows, and Shift+Up/Down or `[`/`]` to reorder. Colour separates the model, thinking level, context remaining, and other values. A monochrome option is available.

Select an external module and press `t` or `T` to cycle its colour forward or backward. Each module can use a named colour or keep the extension's original styling.

The editor also lists status text published by other plugins through Pi's `setStatus` API. New status keys appear automatically. Your choices persist across chats, including preferences for plugins that are temporarily inactive.

Values are spaced without automatic dot separators. Press `s` in the editor to add a separator item, then move it like any module. Delete removes a selected separator.

Use `/statusline off` to restore Pi's built-in footer, or `/statusline on` to enable the custom footer again. Plugins that replace the entire footer compete for the same Pi API. Their internal modules need an integration before this editor can display them separately.

See the [status line reference](docs/status-line.md) for controls, modules, and settings.

## Continue interrupted work

Press Ctrl+Alt+C or run `/continue` to resume an unfinished task after Escape. Pi starts a new model request using the existing conversation. Your editor draft stays intact.

The command does nothing while Pi is busy or input is queued. Use `/goal resume` for a paused goal.

## Start an ephemeral chat

Press Alt+P or run `/ephemeral` to start a chat with in-memory history. A footer badge marks the ephemeral session. The previous saved chat remains on disk.

Press Alt+P again before sending a message to return to the saved chat. After the ephemeral chat contains messages, the shortcut keeps it open.

Pi reserves Alt+P for previous-model cycling. To free the shortcut, add this entry to `~/.pi/agent/keybindings.json`, then run `/reload`:

```json
{
	"app.model.cycleBackward": "shift+ctrl+p"
}
```

Use `/ephemeral explain this repository` to include an initial prompt. Ephemeral mode controls session history. Exports and files created by tools still write to disk.

## Open a thread

Run `/open` to pick a saved thread and switch to it. Add search text to filter the list as it opens, for example `/open login bug`. Pi's `/resume` still works and is unchanged.

The picker has the same search, scopes, grouping, sort order, and Ctrl+T transcript viewer as `/delete-threads`. Press Enter to open the highlighted thread, or Escape to cancel. Open mode has no selection or deletion keys, so Space goes to the search box.

The list excludes the current thread. If Pi or another extension cancels the switch, or the file has gone since the picker opened, pi-qol reports it and you stay in the current thread.

## Delete threads

Deletion permanently removes session files. There is no undo. Close a thread in other Pi processes before deleting it.

Run `/delete` to delete the current thread after confirmation. To delete several threads:

1. Run `/delete-threads` and type to search.
2. Press Space or Enter to select threads.
3. Press Ctrl+D to review the selection.
4. Press Enter to confirm, or N to return to the list.

The top-right of the picker header shows the current scope, grouping, sort order, and number of selected threads. On narrow terminals this state moves to the line below the title.

Tab switches between the current project and all projects. Both tabs start grouped. Ctrl+G changes grouping, and Shift+Up or Shift+Down sets ascending or descending order. Ctrl+T opens the highlighted thread in a read-only transcript viewer that draws messages the way Pi does. In Pi fullscreen mode, the viewer fills the screen. Escape returns to the picker. Ctrl+A selects all matching threads. Escape in the picker exits without deleting unconfirmed selections.

The picker excludes the current thread and stays open after deletion. See the [thread picker reference](docs/reference.md#thread-picker-keys) for all controls.

## Export a chat

Run `/better-export` to save the session as HTML. Pi asks before replacing a file and offers to open the export in your browser.

```text
/better-export
/better-export "exports/My session.html"
/better-export --share --redact-text "Acme Internal" sharing.html
```

Exports include the current theme, offline LaTeX, equation copying, search, code highlighting, and a Print / PDF button. You can export during a running turn. The file captures recorded messages at export time.

Use `--share` to export the active conversation with a redaction preview. Review the HTML before sharing it. Detection uses text patterns and does not scan images.

See the [export reference](docs/reference.md#export-flags) for flags and limits. Pi handles its built-in `/export` before extension commands, so this exporter uses `/better-export`.

## Develop from a checkout

Development requires Bun in addition to Node.js and Pi.

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

The tests use temporary session files and local model fixtures. They do not delete saved chats or make paid model requests.

Run `pi install .` to install this checkout, then `/reload` in an open session. To try it without installing, run `pi -e ./index.ts`.

See the [codebase map](docs/architecture.md) for feature boundaries, persistence, and tests.

See [Publish to npm](docs/publishing.md) for release commands and package discovery.

[MIT license](LICENSE). Embedded KaTeX assets retain their upstream license notices.
