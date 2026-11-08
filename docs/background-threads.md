# Background thread architecture

Assessment against Pi 1.3.0, the SDK version used by this checkout. Background execution is not implemented in pi-qol.

pi-qol keeps the standard `pi` command. A companion launcher is outside the agreed scope. Background execution therefore remains a documented limitation until Pi provides a compatible way to separate its terminal from the running session.

## Fit of Pi Durable

[Pi Durable](https://earendil.com/posts/pi-durable/) supports persistent conversations, concurrent runs, checkpoints, and reconnecting clients. Those capabilities fit an agent whose terminal is a client of a separate process.

It uses its own conversation storage and extension registry. Pi's `ExtensionAPI` modules and existing session files need adapters or a migration. Adding the dependency alone cannot keep the standard Pi CLI's agent running after that CLI exits. The [Durable reference](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) also marks its API experimental.

For pi-qol, a persistent process running the existing Pi runtime offers better compatibility with installed extensions and saved threads. Pi Durable is a candidate for a separate frontend with its own runtime and storage.

## Limits of an extension

Pi 1.3.0 owns the active runtime in the CLI process. In `AgentSessionRuntime.teardownCurrent`, switching sessions awaits `session.abort()`, emits `session_shutdown`, and disposes the old session. The `session_before_switch` hook can cancel a switch but cannot transfer a running model request or tool call to another process.

Terminal shutdown also disposes the runtime and exits the process. An extension's asynchronous callbacks cannot outlive that process. Abrupt termination can bypass cleanup entirely.

Starting another Pi process on the same file does not solve ownership. `SessionManager` keeps its own history in memory and appends to the session file without a shared session lock. Concurrent writers can create inconsistent branches. An extension guard also cannot prevent an unmodified Pi process from opening the file directly.

## Recommended design

A persistent host owns each managed session from the first prompt. The terminal connects as a client. Closing a terminal or changing the displayed thread only detaches that client, so model requests and tool calls keep running in their original process.

The host can supervise a matching Pi CLI in RPC mode for each active thread. Using the installed CLI preserves more initialization behavior than constructing a bare SDK session, including MCP and codemode. Compatibility with interactive extensions still needs verification.

The implementation needs these guarantees:

- Exactly one writer owns each session file. Every supported open path goes through the host, including startup, `/new`, `/resume`, `/open`, and forks.
- Reconnecting clients receive the current transcript, running tools, queued input, and pending questions before later events.
- Each submitted request has a stable ID. A retry after a lost connection does not submit the prompt twice.
- Explicit abort stops a run. Detach leaves it running. Host shutdown stops its children and records their state.
- Background questions remain pending until a client answers. The host does not invent approval or questionnaire answers.
- Each thread retains its working directory, model, thinking level, tools, and trusted extension configuration.
- Process launch uses the same Pi installation as the foreground. It does not silently choose another version from `PATH`.
- The local transport and registry are private to the user. Stale process records cannot grant ownership to a second writer while the first is alive.

The standard Pi 1.3.0 TUI has no exported remote-session client interface. Preserving its UI requires upstream support or an adapter; a companion launcher with an RPC client is another option. This choice affects the installation and user workflow.

## Resuming after handoff

A smaller extension-only approach can stop the current run, release its file, and ask a separate process to continue from saved history. That approach interrupts the active request or tool call. It cannot guarantee uninterrupted execution, and a model may repeat an operation whose external effects already happened.

This behavior needs an explicit description as resume after interruption. Starting a new fork also changes the thread's identity and is unsuitable for transparent continuation of the original thread.

## Verification before release

Process tests must disconnect a client during a model response and during a tool call, then reconnect to the same session. Switching threads must preserve both runs. Tests must also cover duplicate submission retries, concurrent open attempts, cancellation, pending questions, host failure, project trust, and Pi version selection.

A host that survives terminal exit does not automatically survive its own crash. Safe recovery from a crash needs checkpoints and tool replay rules. Pi Durable provides machinery for that stronger guarantee; a host around the existing Pi runtime must describe its narrower recovery behavior.
