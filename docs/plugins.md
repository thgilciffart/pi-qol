# Plugin reference

`/plugins` controls installed Pi extensions through Pi's resource settings. It lists enabled and disabled extension files from installed packages, configured paths, and automatic extension discovery. A package with several extension files has a separate toggle for each file.

Packages with one extension occupy one checkbox row, labelled with the package source. Packages with several extensions show a folder tree beneath the package source. Only extension files have checkboxes. Folder headings have no toggle. Filtering a package to one matching file preserves its tree layout.

## Commands

| Command | Behavior |
| --- | --- |
| `/plugins` | Opens the extension picker in global mode. |
| `/plugins global` | Opens the extension picker in global mode. |
| `/plugins project` | Opens the extension picker in project mode. Requires a trusted project. |

The command requires Pi's interactive terminal UI. It does not open while Pi is working or messages are queued.

## Picker controls

| Key | Behavior |
| --- | --- |
| Type | Searches extension names, paths, and package sources. |
| Up/Down | Moves between extensions. |
| Page Up/Page Down | Moves through longer lists. |
| Space or Enter | Toggles the selected extension and selects the next matching extension. In project mode, cycles its override. |
| Tab | Switches between global and project settings. Available in trusted projects. |
| Ctrl+S | Saves changes in both scopes, closes the picker, and reloads Pi. |
| Escape or Ctrl+C | Closes the picker and discards unsaved changes in both scopes. |

Pi's configured keybindings apply to navigation, search, and confirmation.

Selection skips package and folder headings. Toggling the last matching extension keeps it selected. Single-row packages remain searchable by their extension filename even though the row shows the package source.

Project overrides also advance after each toggle. To cycle the same extension again when another match follows, press Up to return to it.

## Settings scopes

Global mode writes to `<agent directory>/settings.json`, usually `~/.pi/agent/settings.json`. Project mode writes to `<project>/.pi/settings.json`.

Global mode changes global extensions. Project mode also lists inherited global extensions, with three states:

- Inherit uses the global choice.
- Load enables the extension for this project.
- Unload disables the extension for this project.

The picker uses Pi's resource override rules. Package toggles update the package's extension filters while preserving its other resources. Toggles keep explicitly configured files discoverable so disabled files can be enabled again.

## Applying changes

Toggles change an in-memory draft. The header shows `Unsaved changes` while the draft differs from saved settings. Switching scopes retains the draft and previews project inheritance using the draft's global choices.

Ctrl+S writes the draft to Pi's settings and reloads when settings have changed. Reload applies the choices to extension commands, tools, shortcuts, and event handlers. Saving without changes does not reload. Escape and Ctrl+C discard the draft without writing settings or reloading.

If work starts while the picker is open, Ctrl+S saves the draft and asks you to run `/reload` when Pi is idle. A reload failure also leaves settings saved for a later retry.

Other open Pi processes use the new settings after their next reload or restart.

## Scope limits

The picker controls extensions. Skills, prompt templates, themes, and individual features inside pi-qol have no separate toggles here. Pi's built-in extensions and extensions supplied only through `-e` or SDK factories are outside this picker.

Missing packages are skipped during discovery. The picker does not install or uninstall packages.

Disabling pi-qol removes `/plugins` after reload. Run `pi config` from a terminal to enable pi-qol again, then restart Pi or run `/reload`.
