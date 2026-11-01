# Statistics and command reference

## Response statistics

The footer shows the current request's TTFT during streaming and the last response's statistics after completion. Each completed assistant turn adds a statistics row to the transcript. A turn with tool calls places its row after the tool results.

| Value | Definition |
| --- | --- |
| Input tokens | Provider-reported input, cache-read, and cache-write tokens added together. |
| Output tokens | Provider-reported output tokens, including reasoning tokens when the provider counts them. |
| Total tokens | Input tokens plus output tokens for that response. |
| TTFT | Time from Pi's `before_provider_request` event to the first nonempty text, thinking, or tool-call delta. |
| Tokens per second | Output tokens divided by the elapsed seconds after the first delta and before `message_end`. |

The clock is monotonic. TTFT includes request and network latency. Stream chunks can contain several tokens, so TTFT and token rate are approximations of provider generation timing. The rate uses the full output count because Pi does not report the token count of the first chunk.

Missing first-delta timing or a zero generation interval produces `n/a`. A legacy stream without a request event starts timing at `message_start`. Token counts use provider usage reports rather than local tokenization.

Statistics rows persist as custom session entries and never enter model context. Pi restores those rows when you resume a session. The extension does not reconstruct timing for messages created before installation. Ephemeral sessions keep statistics in memory.

## Commands

| Command | Behavior |
| --- | --- |
| `/delete` | Confirms deletion, starts a new chat, then removes the previous session file. For an unsaved chat, discards the chat. |
| `/delete-threads [search text]` | Lists matching saved threads in the current session directory. Supports selection toggles, select all, clear selection, and cancellation. |
| `/delete-threads --all-projects [search text]` | Lists matching saved threads across Pi's default session storage. |
| `/ephemeral [prompt]` | Starts a new in-memory chat after confirmation. Sends the optional prompt into the new chat. An already ephemeral chat remains active. |
| `/better-export [flags] [file.html]` | Saves an HTML export of a file-backed session. |

Deletion requires an interactive UI and waits for the agent to become idle. Bulk deletion excludes the current session file. A failed file removal does not stop the remaining removals. The command reports failed paths separately.

Deletion removes only the selected JSONL session files. Forked sessions, exports, and project files remain on disk. The extension cannot detect whether another Pi process has a selected thread open. Global searches do not scan custom session directories outside Pi's default storage.

## Export flags

| Flag | Behavior |
| --- | --- |
| `--conversation` | Keeps active-branch user and assistant text and images. Removes tools, thinking, other branches, summaries, system prompts, tool definitions, and local header paths. |
| `--redact` | Replaces detected credentials, private keys, bearer headers, email addresses, home paths, and the current project path. Requires an interactive preview. |
| `--redact-text "literal"` | Adds an exact text replacement and enables redaction. Accepts repeated uses. |
| `--share` | Combines `--conversation` and `--redact`. Writes a local file without uploading it. |
| `--` | Treats subsequent arguments as a filename, including filenames beginning with `--`. |

The default filename is `pi-session-<timestamp>.html`. Relative paths use the chat's working directory. Paths beginning with `~/` expand to your home directory. The exporter creates missing parent directories and accepts `.html` and `.htm` files.

Without an interactive UI, export saves new files but refuses overwrites and redaction previews. In-memory sessions cannot be exported through this command. Filtering and redaction affect the export only.

Inline math accepts `$...$` and `\(...\)`. Display math accepts `$$...$$` and `\[...\]`. Code remains literal. Unsupported LaTeX remains visible. Equation copying depends on the browser's clipboard permissions for local files.

Printing uses the displayed branch and current thinking and tool visibility settings. Code wraps, and the printed page omits navigation and controls. KaTeX, CSS, and fonts are embedded for offline use.

## Compatibility

The extension targets Pi 1.3.x and has been checked against 1.3.0. It uses the public [extension API](https://pi.dev/docs/latest/extensions) for events, commands, statistics entries, and UI.

Ephemeral mode changes private `SessionManager` fields because the new-session API has no persistence option. The plugin verifies that persistence is disabled before sending an initial prompt. If verification fails, it reports that the replacement chat will be saved and sends no prompt.

HTML export uses Pi's internal exporter and theme helpers. An unsupported HTML template produces an error before the exporter replaces the destination file. Custom tools use Pi's fallback HTML rendering.

The combined package owns the `/ephemeral` and `/better-export` commands. Loading their standalone plugins at the same time can cause command conflicts.
