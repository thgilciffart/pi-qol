# Bundle settings reference

`/qol` controls the bundled features. Its terminal editor groups them into domain tabs.

## Domains and feature IDs

| Domain | Feature IDs |
| --- | --- |
| Threads | `threads`, `auto-name`, `ephemeral` |
| Agent | `goal`, `continue`, `thinking`, `ask-questions` |
| Display | `status-line`, `metrics` |
| Tools | `export`, `plugins` |

Disabling a feature removes its commands, tools, event handlers, and shortcuts on the next extension load. Saved conversations and feature-specific settings remain on disk. `/qol` itself cannot be disabled through this editor.

The automatic naming, status line, and plugin manager settings rows open their existing editors. A feature must be loaded for its settings editor to be available. Enabling it and saving reloads Pi, which makes its editor available the next time `/qol` opens.

## Commands

| Command | Effect |
| --- | --- |
| `/qol` | Opens the terminal editor, or reports saved settings in other modes. |
| `/qol status` | Reports saved feature states and the configuration path. |
| `/qol on <feature>` | Enables a bundled feature. `enable` is an alias for `on`. |
| `/qol off <feature>` | Disables a bundled feature. `disable` is an alias for `off`. |
| `/qol on domain:<domain>` | Enables every feature in a domain. |
| `/qol off domain:<domain>` | Disables every feature in a domain. |
| `/qol reset` | Enables every bundled feature. It preserves settings owned by individual features. |

The bare ID `threads` means the thread management feature. `domain:threads` means the entire Threads domain.

Saving changed feature switches reloads Pi when it is idle and has no queued input. During active work, Pi reports that a manual `/reload` is needed. A failed reload leaves the saved file intact for a later retry. `/qol status` reports saved choices, which can differ from the loaded features while a reload is pending.

## Editor keys

| Key | Effect |
| --- | --- |
| Tab, Right | Selects the next domain. |
| Shift+Tab, Left | Selects the previous domain. |
| Up, Down | Selects a row. |
| Home, End | Selects the first or last row. |
| Page Up, Page Down | Moves through a page of rows. |
| Space | Toggles a feature row. |
| Enter | Toggles a feature row or opens a settings row. |
| `s`, Ctrl+S | Saves feature switches and applies the reload rules above. |
| Escape | Closes the editor. When feature switches have changed, a second Escape confirms discarding them. |
| Ctrl+C | Discards feature switches and closes the editor. |

Feature switches remain pending while a settings row's editor is open. Those nested editors save their own settings independently. Cancelling `/qol` discards only its pending feature switches. A reload requested by the plugin manager waits until `/qol` closes.

## Storage

Choices apply globally and live at `<agent directory>/pi-qol/qol.json`, normally `~/.pi/agent/pi-qol/qol.json`.

```json
{
	"version": 1,
	"features": {
		"auto-name": false,
		"metrics": false
	}
}
```

Missing feature keys default to enabled. A missing file enables the whole bundle. The main editor writes disabled features only.

Invalid settings produce a warning and use defaults without changing the file. An explicit save or reset preserves the invalid file in a `.invalid-<timestamp>` backup before writing the replacement. `/qol reset` repairs invalid settings.

Automatic naming and status line settings keep their existing `auto-name.json` and `status-line.json` files. The plugin manager continues to use Pi's global and trusted project settings.
