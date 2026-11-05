# Codebase map

`index.ts` registers each feature once. Feature modules export a registration function that receives Pi's `ExtensionAPI`. Commands and events use the context supplied by Pi rather than a shared global context.

## Feature modules

| Feature | Entry point | Supporting code | Interface |
| --- | --- | --- | --- |
| Goals | [`src/goal/index.ts`](../src/goal/index.ts) | `model.ts` defines persisted data and validation. `state.ts` defines transient run state. `commands.ts` parses commands, `prompts.ts` holds agent instructions, `format.ts` formats values, and `ui.ts` wraps the composer. | `/goal`, `create_goal`, `get_goal`, `update_goal` |
| Automatic names | [`src/auto-name.ts`](../src/auto-name.ts) | [`auto-name-picker.ts`](../src/auto-name-picker.ts) adapts Pi's model selector. | `/auto-name` |
| Plugins | [`src/plugins/index.ts`](../src/plugins/index.ts) | Discovers installed extensions, preserves configured discovery paths, saves Pi resource settings, and reloads. `draft.ts` keeps edits in memory until Ctrl+S. `native-picker.ts` adapts Pi's resource selector. `compact-list.ts` renders single-row packages and folder trees and advances selection after toggles. | `/plugins` |
| Thread deletion | [`src/threads.ts`](../src/threads.ts) | [`thread-picker.ts`](../src/thread-picker.ts) owns the interactive list. [`thread-transcript.ts`](../src/thread-transcript.ts) reads a saved session and shows it with Pi's message components. [`threads/search.ts`](../src/threads/search.ts) defines searchable fields. | `/delete`, `/delete-threads` |
| Ephemeral chats | [`src/ephemeral.ts`](../src/ephemeral.ts) | Contains the isolated adapter for Pi's private session-persistence fields. | `/ephemeral`, Alt+P |
| Response statistics | [`src/metrics.ts`](../src/metrics.ts) | Computes per-response timing and renders persisted transcript entries. | Final assistant reply statistics |
| Interrupted turns | [`src/continue.ts`](../src/continue.ts) | Checks the active branch before sending a hidden continuation. | `/continue`, Ctrl+Alt+C |
| Thinking effort | [`src/thinking.ts`](../src/thinking.ts) | Uses Pi's supported levels for the current model. | Alt+, and Alt+. |
| Status line | [`src/status-line/index.ts`](../src/status-line/index.ts) | Settings, command parsing, footer lifecycle, data snapshots, rendering, sanitization, and the editor have separate modules. | `/statusline` |
| HTML export | [`src/export/index.ts`](../src/export/index.ts) | Target resolution and HTML transformation are separate from command orchestration. `native-export.ts` adapts Pi's exporter. Other modules handle the theme, session data, redaction, math, and printing. | `/better-export` |
| Questionnaires | [`src/ask-questions/index.ts`](../src/ask-questions/index.ts) | `extension.ts` owns tool registration and background lifecycle. `questions.ts` and `schema.ts` define answers and validation. `fallback.ts` supports dialog-only modes. `ui/state.ts`, `ui/render.ts`, and `ui/ask-questionnaire.ts` separate answer operations, drawing, and input handling. | `ask_user` |

[`src/shared.ts`](../src/shared.ts) contains small helpers used by several features: atomic JSON writes, error messages, command completions, model references, and conversation detection. Feature-specific state and validation stay in their own modules.

`src/goal.ts` and `src/goal-ui.ts` retain the original import paths for consumers. The implementation lives in `src/goal/`.

## Persistence

| Owner | Data | Storage |
| --- | --- | --- |
| Goals | Objective, status, budget, token usage, elapsed time, and turn count | `pi-qol-goal` custom session entries |
| Goal continuation | Hidden requests to continue the active goal | `pi-qol-goal-continuation` custom messages |
| Response statistics | Input, output, cost, TTFT, duration, and token rate | `pi-qol-metrics` custom session entries |
| Ephemeral return | The saved chat to return to from an empty private chat | `pi-qol-ephemeral-return` custom entries in memory |
| Interrupted turns | Hidden request to continue an unfinished reply | `pi-qol-continue` custom messages |
| Automatic names | Enabled state, model, effort, and naming prompt | `<agent directory>/pi-qol/auto-name.json` |
| Status line | Visibility, colour mode, module order, row, and side | `<agent directory>/pi-qol/status-line.json` |
| Plugins | Global extension filters and project overrides | Pi's global and project `settings.json` files |
| Questionnaires | Completed or cancelled background answers delivered to the agent | `ask_user:answers` custom messages |

Session entries retain their existing names and formats. Restoring a goal pauses it until fresh user direction. Ephemeral chats keep their entries in memory. Exports create files without changing the session history.

## Tests and development

`npm run check` type-checks the entry point and TypeScript source. `npm test` runs the tests with Bun. Test fixtures are not part of the source type check.

[`test/index.test.ts`](../test/index.test.ts) loads the actual bundled extension and checks registration. Feature tests cover pure functions and command behavior. Goal and continuation tests also drive a real Pi session with local model fixtures. Export tests execute the generated viewer in JSDOM. Status-line tests check terminal widths, external status keys, persistence, and editor controls.

`npm pack --dry-run` checks package contents. Packaging includes `index.ts`, `src/`, `docs/`, the README, and the license. Tests and development dependencies are excluded.

Pi compatibility adapters stay close to the feature that needs them. A Pi version change requires checking session persistence, the HTML template and exporter, theme helpers, editor wrapping, the resource picker, and footer APIs against the feature tests.
