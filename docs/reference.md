# Statistics and command reference

## Response statistics

Each final assistant reply adds a statistics row to the transcript. Messages that call tools have no statistics row. The footer contains no response statistics. Each row labels input and output separately and uses spaces between values, without dot separators or a combined token total.

| Value | Definition |
| --- | --- |
| Input | Provider-reported input, cache-read, and cache-write tokens for this response, added together. |
| Output | Provider-reported output tokens for this reply, including reasoning tokens when the provider counts them. |
| TTFT | Time from Pi's `before_provider_request` event to the first nonempty text, thinking, or tool-call delta. |
| Tokens per second | Output tokens divided by the elapsed seconds after the first delta and before `message_end`. |
| Cost | Pi's `usage.cost.total` for this response in USD, rounded to four decimal places. Includes input, output, cache-read, and cache-write costs. Missing or invalid values display `n/a`. |

The clock is monotonic. TTFT includes request and network latency. Stream chunks can contain several tokens, so TTFT and token rate are approximations of provider generation timing. The rate uses the full output count because Pi does not report the token count of the first chunk.

Missing first-delta timing or a zero generation interval produces `n/a`. A legacy stream without a request event starts timing at `message_start`. Token counts use provider usage reports rather than local tokenization.

Statistics rows persist as custom session entries and never enter model context. Pi restores those rows when you resume a session. The renderer hides legacy rows attached to tool-call messages and displays legacy final-reply rows with separate input and output counts. If a statistics entry lacks input usage or cost, the renderer reads the original assistant message when available. Missing values display `n/a`. Cost uses Pi's model pricing and usage data, rather than an account billing total. The extension does not reconstruct timing for messages created before installation. Ephemeral sessions keep statistics in memory.

## Commands

| Command | Behavior |
| --- | --- |
| `/continue` | Continues an interrupted task using a hidden cue. Ctrl+Alt+C is the equivalent editor shortcut. |
| `/auto-name [option]` | Configures automatic first-message thread names. See the [automatic naming reference](auto-name.md). |
| `/statusline [option]` | Opens the status line editor or changes footer settings. See the [status line reference](status-line.md). |
| `/goal [objective]` | Shows the current goal, or sets an objective and starts work. See the [goal reference](goals.md) for lifecycle and budget commands. |
| `/delete` | Confirms deletion, starts a new chat, then removes the previous session file. For an unsaved chat, discards the chat. |
| `/delete-threads [search text]` | Opens a searchable picker for saved threads. Starts in the current project. Tab switches between project and all projects. |
| `/ephemeral [prompt]` | Immediately starts an in-memory chat and sends the optional prompt. With no prompt, an empty, idle ephemeral chat returns to the previous saved chat. Chats that contain messages remain private. |
| `/better-export [flags] [file.html]` | Saves an HTML export of a file-backed session. |

`/continue` and Ctrl+Alt+C start a new model request from the active conversation using a hidden continuation cue. They do not add a user message, clear the editor draft, or reconnect the cancelled stream. They leave goal status unchanged. Empty conversations, busy sessions, and sessions with queued input are not continued.

Deletion requires an interactive UI and waits for the agent to become idle. The picker requires the terminal UI. Bulk deletion excludes the current session file. A failed file removal does not stop the remaining removals. The command reports failed paths separately.

Deletion removes only the selected JSONL session files. Forked sessions, exports, and project files remain on disk. The extension cannot detect whether another Pi process has a selected thread open. The All scope includes Pi's default session storage and the active project's session directory. It does not scan other custom session directories.

## Thread picker keys

The list contains thread rows and a search box. The current project starts grouped by date. All projects starts grouped by project. Each tab remembers its grouping choice. Project groups show the last-message date at the far right. Date groups show the project path there. Each row shows elapsed time since the last message immediately after the thread name. Dates use the system locale and timezone through `Intl.DateTimeFormat`. Invalid dates display `Unknown date`. Selection persists when the search, scope, grouping, or sort order changes. Group headings are not selectable. Changing grouping or sort order keeps the same thread highlighted.

| Key | Behavior |
| --- | --- |
| Tab | Switches between the current project and all projects. |
| Ctrl+G | Cycles none and date for the current project, or none, date, and project for all projects. |
| Shift+Up or Shift+Down | Sets ascending or descending order. |
| Ctrl+T | Opens the highlighted thread in a full-screen transcript viewer. |
| Up or Down | Moves the highlighted row. |
| Page Up or Page Down | Moves by one page. |
| Home or End | Moves to the first or last matching thread. |
| Space or Enter | Toggles the highlighted thread and advances to the next row. The last row stays highlighted. |
| Ctrl+A | Selects all matching threads in the current scope. |
| Ctrl+D | Asks to delete the selected threads. With no selection, asks to delete the highlighted thread. |
| Escape | Exits the picker without deleting unconfirmed selections. |

Date groups use the last-modified calendar date in the local timezone, with the newest date first. Project groups use the full working directory path, with Z–A order by default. Within each group, threads appear newest first. Shift+Up sorts dates oldest first and projects A–Z. Shift+Down restores descending order. Group headings repeat when you scroll within a group.

The transcript viewer includes all saved messages, thinking, tool calls, and tool results. Images appear as placeholders. Up and Down scroll, Page Up and Page Down move a page, and Home and End jump to the start or end. Escape, Ctrl+T, or Ctrl+C returns to the picker.

In the confirmation view, Enter confirms deletion, N returns to the list, and Escape exits. Confirmation includes selections hidden by the current search or scope. The picker remains open after deletion and retains threads whose files could not be removed.

## Export flags

| Flag | Behavior |
| --- | --- |
| `--conversation` | Keeps active-branch user and assistant text and images. Removes tools, thinking, other branches, summaries, system prompts, tool definitions, and local header paths. |
| `--redact` | Replaces detected credentials, private keys, bearer headers, email addresses, home paths, and the current project path. Requires an interactive preview. |
| `--redact-text "literal"` | Adds an exact text replacement and enables redaction. Accepts repeated uses. |
| `--share` | Combines `--conversation` and `--redact`. Writes a local file without uploading it. |
| `--` | Treats subsequent arguments as a filename, including filenames beginning with `--`. |

The default filename is `pi-session-<timestamp>.html`. Relative paths use the chat's working directory. Paths beginning with `~/` expand to your home directory. The exporter creates missing parent directories and accepts `.html` and `.htm` files.

Export runs immediately during an active turn without waiting for or interrupting the agent. It captures the session entries recorded when the HTML is generated. A reply still streaming and unfinished tool output are included only after Pi records them. Later messages do not update an existing export.

Without an interactive UI, export saves new files but refuses overwrites and redaction previews. In-memory sessions cannot be exported through this command. Filtering and redaction affect the export only.

Inline math accepts `$...$` and `\(...\)`. Display math accepts `$$...$$` and `\[...\]`. Code remains literal. Unsupported LaTeX remains visible. Equation copying depends on the browser's clipboard permissions for local files.

Printing uses the displayed branch and current thinking and tool visibility settings. Code wraps, and the printed page omits navigation and controls. KaTeX, CSS, and fonts are embedded for offline use.

## Compatibility

The extension targets Pi 1.3.x and has been checked against 1.3.0. It uses the public [extension API](https://pi.dev/docs/latest/extensions) for events, commands, statistics entries, and UI.

Ephemeral mode changes private `SessionManager` fields because the new-session API has no persistence option. The plugin verifies that persistence is disabled before sending an initial prompt. If verification fails, it reports that the replacement chat will be saved and sends no prompt.

HTML export uses Pi's internal exporter and theme helpers. An unsupported HTML template produces an error before the exporter replaces the destination file. Custom tools use Pi's fallback HTML rendering.

The combined package owns the `ask_user` tool and the `/ephemeral` and `/better-export` commands. Loading their standalone plugins at the same time can cause conflicts.
