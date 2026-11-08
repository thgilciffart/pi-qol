# Questionnaire reference

Pi-qol bundles the `ask_user` tool from [pi-ask-questions](https://github.com/thgilciffart/pi-ask-questions), under the MIT license. The standalone package is not a dependency.

`ask_user` accepts single-choice, multiple-choice, and typed questions. Its terminal interface has one tab per question and a review tab when several questions are present.

## Modes

`mode: "background"` is the default. In Pi's terminal UI, the tool returns immediately while the questionnaire remains open. Submitted answers enter Pi's steering queue at the next model or tool boundary. They do not interrupt a running response or tool. Submission after the parent stops starts a new turn. Only one background questionnaire can be open.

`mode: "urgent"` waits for answers or cancellation. RPC (for example T3 Code, which runs Pi with `--mode rpc`) uses sequential selection and input dialogs and waits in either mode: each question is one dialog, a single-choice question submits as soon as an option is picked, and multi-select questions toggle `[x]`/`[ ]` markers across dialogs until Done. Print and JSON modes return the questions for the parent to ask as text.

The compatibility field `noWait` selects background mode when `true` and urgent mode when `false`. An explicit `mode` takes precedence. Switching or closing sessions cancels pending questionnaires so answers cannot reach another conversation.

## Controls

| Key | Action |
| --- | --- |
| Tab, Shift+Tab | Switch questions. |
| Up, Down, Home, End | Move through options. |
| Page Up, Page Down | Move by eight options. |
| Space, 1 through 9 | Select or clear an option. |
| A, C | Select all or clear multiple-choice options. |
| Enter | Confirm a question or submit from the review tab. |
| Backslash then Enter | Insert a newline in a typed answer. |
| Escape twice, Ctrl+C | Cancel. |

An option question also accepts one typed answer unless `allowOther` is false. Typed answers count toward multiple-choice selection limits.

## Parameters

```json
{
	"mode": "background",
	"questions": [
		{
			"id": "scope",
			"question": "Which packages should change?",
			"multiple": true,
			"min": 1,
			"options": [
				{ "label": "Core", "value": "core" },
				{ "label": "CLI", "value": "cli" }
			]
		}
	]
}
```

`questions` accepts 1 to 12 entries. Each requires `question` text.

| Field | Meaning |
| --- | --- |
| `id`, `label` | Result ID and tab label. Defaults are `q1` and `Q1`, increasing for each question. |
| `header` | Context below the question. |
| `options` | Choices with `label` and optional `value`, `description`, and `selected`. Values default to labels. Omission creates a typed question. |
| `multiple` | Allows several listed choices. Default `false`. |
| `allowOther` | Allows one typed answer beside listed choices. Default `true`. |
| `required` | Requires an answer. Default `true`. |
| `min`, `max` | Selection limits for multiple-choice questions. |
| `placeholder`, `otherLabel` | Editor placeholder and typed-answer label. |

Top-level `title` and `submitLabel` customize the questionnaire title and submit entry.

## Results

Results include a text summary and `structuredContent` containing `cancelled`, optional `pending`, and `answers`. Each answer contains `id`, `question`, `skipped`, and an array of `{ value, label, custom }` selections.

While `pending` is true, answer arrays are empty. Completed background answers arrive as steering text. Cancellation does not submit preselected choices as answers.

## Configuration

Optional settings live in `<agent dir>/pi-qol/ask-questions.json` (default `~/.pi/agent/pi-qol/ask-questions.json`):

```json
{ "version": 1, "expose": "tui" }
```

- `"expose": "all"` (default): the tool is exposed in every mode.
- `"expose": "tui"`: the tool is only declared to the model in Pi's terminal UI. In RPC hosts such as T3 Code (which runs Pi with `--mode rpc`) and in print/JSON modes, `ask_user` is removed from the active tool set at session start, so the model asks in prose instead. The tool stays registered for direct/codemode calls and still uses the dialog fallback there.

To disable the questionnaire entirely (all modes), use `/qol off ask-questions` or set `"ask-questions": false` in `pi-qol/qol.json`.

## Migration

The question tool has no separate configuration file or credential store. Its pending state belongs to the current parent session.

Before loading the bundled version, remove the standalone installation. For a Git installation, the command is `pi remove git:github.com/thgilciffart/pi-ask-questions`. For an npm installation, it is `pi remove npm:pi-ask-questions`. Loading both versions creates an `ask_user` tool conflict.
