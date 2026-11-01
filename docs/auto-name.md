# Automatic naming reference

Automatic naming generates a thread title from the first user message in a new, unnamed chat. It runs in the background while the conversation proceeds. Each new thread gets one automatic naming attempt.

## Defaults

| Setting | Default |
| --- | --- |
| Enabled | On |
| Model | Current chat model |
| Effort | Off |
| Prompt | Built-in instructions for a specific, 3-to-7-word title in the user's language |

Naming makes a separate request through Pi's configured model provider. It does not change the conversation's model or effort, inject chat messages, or call tools. Only text from the first user message is sent, limited to 12,000 characters. An image-only message uses a generic attachment description.

## Commands

`/auto-name` opens the settings menu in an interactive UI. Changes return to the menu. Escape from the model picker, effort picker, or prompt editor goes back to settings. Escape at the settings menu closes it. Without a UI, the command displays current settings.

The terminal model picker uses Pi's built-in search and model list. Type to search and press Tab to switch between All and Scoped when scoped models are configured. Enter or Ctrl+S saves the selected naming model. This does not change the chat model or its default. `/auto-name model current` restores following the chat model.

| Command | Behavior |
| --- | --- |
| `/auto-name status` | Shows enabled state, model, effort, and a prompt preview. |
| `/auto-name on` | Enables automatic naming for new threads. |
| `/auto-name off` | Disables automatic naming and cancels a pending naming request. |
| `/auto-name model` | Opens Pi's searchable model picker with All/Scoped switching in the terminal UI. |
| `/auto-name model provider/model-id` | Selects a model registered with Pi. Model IDs can contain additional slashes. |
| `/auto-name model current` | Uses the chat model selected when the first message arrives. |
| `/auto-name effort` | Opens the effort picker. |
| `/auto-name effort <level>` | Sets `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Provider support depends on the selected model. |
| `/auto-name prompt` | Opens an editor with the current prompt. Without a UI, shows the full prompt. |
| `/auto-name prompt <text>` | Sets custom naming instructions. The first user message is supplied separately; no placeholder is needed. |
| `/auto-name prompt default` | Restores the built-in prompt. |
| `/auto-name now` | Generates a new name for the current thread from its first recorded user message, even if automatic naming is off. Replaces the current name. |
| `/auto-name reset` | Restores all defaults and repairs malformed settings. |

The prompt accepts 1 to 8,000 characters. The prompt editor preserves multiple lines. Cancelling a picker or editor leaves settings unchanged.

## Persistence and lifecycle

Settings are saved to `pi-qol-auto-name.json` in Pi's agent directory, normally `~/.pi/agent`. They apply across sessions and survive reloads. Configuration changes apply to future naming requests and cancel pending requests.

Generated names use Pi's session metadata and appear in the thread picker. Ephemeral thread names remain in memory. Existing conversations, resumed sessions, and forks with conversation history are not renamed automatically. Enabling naming after a thread's first message does not rename it; `/auto-name now` handles existing threads.

A manual name set before the first message prevents automatic naming. A manual name set while a request runs takes precedence. Switching or closing sessions, reloading, and navigating the session tree cancel pending requests. Late responses cannot rename another session.

Names are cleaned to one line and limited to 80 characters. Failed requests leave the thread name unchanged and display a warning. They do not retry automatically. `/auto-name now` retries after configuration or authentication issues are resolved. Naming requests have a 60-second timeout.
