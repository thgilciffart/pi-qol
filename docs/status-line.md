# Status line reference

The custom status line is enabled by default in Pi's terminal UI. It displays session information in colour and includes status text from other plugins. It does not install a footer in RPC or print mode.

## Commands

| Command | Behavior |
| --- | --- |
| `/status-line` | Opens an editor with a preview, module selection, and module ordering. |
| `/status-line on` | Enables the custom footer. |
| `/status-line off` | Restores Pi's built-in footer. |
| `/status-line reset` | Restores the default configuration. |
| `/status-line status` | Shows the current settings and settings file path. |
| `/status-line colorful` | Selects the colourful mode. `colourful` is also accepted. |
| `/status-line theme` | Selects the restrained theme mode. |
| `/status-line mono` | Selects monochrome. |

`/status-line color <mode>` and `/status-line colour <mode>` also select a colour mode. Outside the terminal UI, `/status-line` reports the configuration instead of opening the editor.

The `color` and `colour` forms require a mode. Other actions, such as `on` and `reset`, use the direct commands in the table.

## Editor keys

The editor has a live preview and a sample preview. Changes remain in the draft until saved. The first three settings control the custom footer, colour mode, and visibility of newly discovered plugin statuses.

If saved settings change while the editor is open, the save reports a conflict and leaves the file unchanged. Reopening the editor loads the latest settings.

| Key | Behavior |
| --- | --- |
| Up or Down, `j` or `k` | Moves the selection. |
| Home or End | Selects the first or last item. |
| Page Up or Page Down | Moves the selection by one page. |
| Space | Toggles a module or changes the selected setting. |
| Shift+Up or Shift+Down, Alt+Up or Alt+Down, `[` or `]` | Moves the selected module earlier or later within its side. Crossing a row boundary moves it into the other row on the same side. |
| Left or Right | Assigns the selected module to the left or right side. |
| `1` or `2` | Assigns the selected module to row 1 or row 2. |
| `c` | Cycles the colour mode. |
| `p` | Switches between live and sample previews. |
| `r` | Restores defaults in the draft. |
| Enter or Ctrl+S | Saves the draft and closes the editor. |
| Escape | Closes the editor. Unsaved changes require a second Escape to discard. |
| Ctrl+C | Discards changes and closes the editor immediately. |

## Modules

Each module can be enabled, disabled, reordered, or assigned to either side of the first or second row. The editor groups modules by row and side. Within each side, list order determines display order from left to right. A right group ends at the terminal's right edge, with empty space between the two groups.

Empty values do not occupy space. Each side wraps between modules onto at most two terminal lines. When both sides have content, the renderer divides the available width between them. A short group leaves more room for the other side. A continuation line uses the full width when the opposite side has no content on that line. Overflow displays `+N` for the remaining modules. Every line fits the terminal width. A one-column terminal stacks the two sides.

By default, row 1 contains ready or working, model, thinking level, working directory, branch, and session name. Row 2 contains context remaining, token usage, cache usage, cost, and external statuses. Modules start on the left. Existing settings retain their layout until a module moves to the right.

| Module | Value |
| --- | --- |
| Ready / working | Whether Pi is idle or running. |
| Model | The current model. |
| Thinking level | The current reasoning effort, shown for models that support reasoning. |
| Working directory | The session's working directory, relative to the home directory when possible. Long paths retain their last characters. |
| Git branch | The branch supplied by Pi's footer data provider. |
| Session name | The current thread name, when present. |
| Context remaining | Remaining context based on Pi's context usage report, with warnings above 70% and 90% used. Unknown usage displays `?`. |
| Token usage | Cumulative session input and output tokens. |
| Cache reads/writes | Cumulative session cache usage. |
| Cost | Cumulative session cost from Pi's usage records, with `(sub)` when Pi reports OAuth authentication. |

Account quotas and permission settings are not available as built-in modules. A plugin can publish those values as external status text.

## Colour modes

| Mode | Behavior |
| --- | --- |
| `colorful` | Uses varied colours from the active theme, including reasoning effort colours. This is the default. |
| `theme` | Uses a restrained palette from the active theme, with accents and warning colours. |
| `mono` | Removes colour, including ANSI colours from external statuses. |

## External plugin modules

Pi's public `ctx.ui.setStatus(key, text)` API publishes a status value under a key. The editor discovers these keys through the footer data provider. It includes new keys by default and allows each key to be hidden or reordered. Saved preferences remain available when a plugin clears its status or is temporarily absent.

An external module appears when its plugin publishes a status. A plugin can publish several keys, or combine several values into one key. The editor controls each published key as one module. It cannot split values within a key or extract modules from a plugin's custom footer.

Discovery runs while the pi-qol footer is mounted, including while the editor is open. With the custom footer off, the editor retains saved keys but cannot discover new ones.

The new-status visibility setting applies to all keys not yet listed in saved settings, including keys present when the editor opens. Explicitly toggling a key overrides that policy for the key. Previously saved visibility choices stay unchanged.

External status text retains its ANSI colours in colour modes. Monochrome removes those colours. The renderer removes terminal control sequences and flattens multiline text to fit the footer.

Pi has one custom footer slot. If another plugin calls `setFooter`, the latest call determines which footer appears. `/status-line on` installs the pi-qol footer again. `/status-line off` restores Pi's built-in footer when pi-qol owns the footer. It leaves a footer installed by another plugin in place.

## Settings

Settings apply across chats and are stored in `<agent directory>/pi-qol/status-line.json`, normally `~/.pi/agent/pi-qol/status-line.json`.

Each command re-reads saved settings, including manual repairs and changes saved by another Pi process.

The JSON fields are `version`, `enabled`, `colorMode`, `showNewExtensionStatuses`, and `items`. Version is `1`. Each item contains an `id`, an `enabled` boolean, and `row` set to `1` or `2`. The optional `side` field is `left` or `right` and defaults to `left`. Array order determines module order within each row and side.

Built-in IDs are `state`, `model`, `thinking`, `cwd`, `git`, `session`, `context`, `tokens`, `cache`, and `cost`. External status IDs use `extension:<key>`. Missing built-in entries receive their default settings. Disabling a built-in module requires an entry with `enabled` set to `false`.

The configuration supports at most 200 modules including built-ins. External keys can contain at most 200 characters. Empty keys are ignored. New keys start in row 2, sorted alphabetically, with visibility determined by `showNewExtensionStatuses`.

Malformed settings produce a warning and defaults apply in memory. The original file stays unchanged until a save or reset. Before replacing an invalid file, the extension copies it to `<settings path>.invalid-<timestamp>`. Saves create missing directories and replace the settings file atomically.
