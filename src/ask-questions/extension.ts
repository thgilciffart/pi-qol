/**
 * pi-ask-questions
 *
 * Registers the `ask_user` tool: an interactive questionnaire with tabs,
 * single- and multi-select options, free-form typing, validation, and
 * structured answers.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runFallbackSurvey } from "./fallback.ts";
import {
	type AskResult,
	type NormalizedQuestion,
	type QuestionAnswer,
	DEFAULT_SUBMIT_LABEL,
	buildResult,
	formatAnswersText,
	normalizeQuestions,
	toStructuredOutput,
} from "./questions.ts";
import {
	AskUserOutputSchema,
	AskUserParamsSchema,
} from "./schema.ts";
import { runQuestionnaire, type QuestionnaireContext, type RunQuestionnaireOptions } from "./ui/ask-questionnaire.ts";

/** Structured details stored with the tool result for rendering. */
export interface AskToolDetails {
	cancelled: boolean;
	/** True while a background questionnaire is still open. */
	pending?: boolean;
	answers: QuestionAnswer[];
	questions: NormalizedQuestion[];
}

const TOOL_DESCRIPTION = `Ask the user one or more questions, either blocking for answers or continuing in the background. Use it when you need a decision, preference, or piece of information that only the user can provide.

The interactive UI supports:
- Tabs: every question gets its own tab (Tab / Shift+Tab and arrow keys switch).
- Single-select and multi-select questions (set multiple: true).
- Free-form typing: a question with no options is a text prompt. Option questions can also hold one typed answer alongside the selected option(s) unless allowOther is false, and the answer is edited inline.
- Optional questions (required: false) that can be skipped, preselected options (selected: true), and min/max selection counts.
- Space or number keys 1-9 select or clear options without submitting; Enter confirms. A selects all; C clears a multi-select.
- Set mode: "urgent" to wait for the user before proceeding with any further work.
- Use mode: "background" (default) to continue independent work while the questionnaire stays open. Answers are injected as steering at the next model/tool boundary, before further work; they do not wait until the agent finishes. This does not abort an in-flight response or running tool.
- noWait is a compatibility alias: true means background, false means urgent. An explicit mode takes precedence.

Guidelines:
- Prefer this tool over asking questions in prose when you actually need the answer to proceed.
- Group related questions into one call (2-6 questions) instead of asking repeatedly.
- Provide concrete, labeled options whenever you can; use a free-form question only when the answer space is open.
- Put recommended options first.
- Choose urgent when an answer is required before any further work; choose background only when you can continue independent work. In non-TUI interactive modes, background falls back to waiting for answers.`;

const NO_UI_TEXT = "Interactive UI is not available in this mode. Ask the user the following questions directly in your reply instead:";

/** Human-readable list used when no UI exists (print/JSON mode). */
function questionsAsText(questions: NormalizedQuestion[]): string {
	return questions
		.map((question, index) => {
			const options =
				question.options.length > 0
					? `\n   Options: ${question.options.map((option) => option.label).join(", ")}`
					: "";
			const optional = question.required ? "" : " (optional)";
			return `${index + 1}. ${question.question}${optional}${options}`;
		})
		.join("\n");
}

function resultContent(result: AskResult): string {
	const text = formatAnswersText(result);
	return result.cancelled ? text : `User answered:\n${text}`;
}

function resultDetails(result: AskResult, questions: NormalizedQuestion[]): AskToolDetails {
	return { cancelled: result.cancelled, answers: result.answers, questions };
}

/** Identifies the session behind a context; undefined once the context is stale. */
function sessionOrigin(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
	try {
		const manager = ctx.sessionManager;
		return JSON.stringify([manager?.getSessionId?.() || null, manager?.getSessionFile?.() || null]);
	} catch {
		return undefined;
	}
}

interface BackgroundSurvey {
	controller: AbortController;
	/** Session epoch and origin the answers belong to. */
	epoch: number;
	origin: string | undefined;
	/** Set when another prompt closed the survey before the user answered. */
	closedBy?: string;
}

/** Start the questionnaire and wait for the user. */
export default function askQuestionsExtension(pi: ExtensionAPI): void {
	// A background questionnaire stays open after its tool call returns. It
	// reports its answers with a steering message instead of a tool result,
	// but only to the session that asked: session events bump the epoch, and
	// the origin check catches a session switch that fired no event.
	let backgroundSurvey: BackgroundSurvey | undefined;
	let shuttingDown = false;
	let sessionEpoch = 0;

	/** Release the background slot and abort its questionnaire. */
	function closeBackground(closedBy?: string): void {
		const survey = backgroundSurvey;
		if (!survey) {
			return;
		}
		backgroundSurvey = undefined;
		survey.closedBy = closedBy;
		survey.controller.abort();
	}

	function isCurrent(survey: BackgroundSurvey, ctx: ExtensionContext): boolean {
		return !shuttingDown
			&& survey.epoch === sessionEpoch
			&& survey.origin !== undefined
			&& sessionOrigin(ctx) === survey.origin;
	}

	/** Dispatch a blocking questionnaire to the right UI for the current mode. */
	function askQuestions(
		ctx: QuestionnaireContext,
		questions: NormalizedQuestion[],
		options: RunQuestionnaireOptions,
	): Promise<AskResult> {
		if (ctx.mode !== "tui") {
			return runFallbackSurvey(ctx.ui, questions, options.signal);
		}
		// Both questionnaires would share the editor slot, and the newer one
		// would hide the background one for good. Close it and tell the agent.
		closeBackground("an urgent questionnaire");
		return runQuestionnaire(ctx, questions, options);
	}

	function startBackground(
		ctx: ExtensionContext,
		questions: NormalizedQuestion[],
		options: { title?: string; submitLabel: string },
	): void {
		const survey: BackgroundSurvey = {
			controller: new AbortController(),
			epoch: sessionEpoch,
			origin: sessionOrigin(ctx),
		};
		backgroundSurvey = survey;
		runQuestionnaire(ctx, questions, {
			...options,
			signal: survey.controller.signal,
			onDisplaced: () => {
				if (backgroundSurvey === survey) {
					closeBackground("another dialog");
				}
			},
		})
			.then(
				(result) => {
					if (!isCurrent(survey, ctx)) {
						return;
					}
					const content = result.cancelled && survey.closedBy
						? `The background questionnaire closed before the user answered because ${survey.closedBy} replaced it. Ask again if you still need these answers.`
						: resultContent(result);
					try {
						pi.sendMessage(
							{ customType: "ask_user:answers", content, display: true, details: resultDetails(result, questions) },
							{ triggerTurn: true, deliverAs: "steer" },
						);
					} catch {
						// Ignore delivery failures when the parent session runtime was replaced.
					}
				},
				(error: unknown) => {
					if (!isCurrent(survey, ctx)) {
						return;
					}
					// The questionnaire could not be shown. The tool result already told
					// the model it was pending, so surface the failure to the user
					// instead of leaving everyone waiting for answers that never come.
					const reason = error instanceof Error ? error.message : String(error);
					try {
						ctx.ui.notify(`ask_user could not show the background questionnaire: ${reason}`, "error");
					} catch {
						// Reporting is best-effort; the background slot still clears.
					}
				},
			)
			.finally(() => {
				if (backgroundSurvey === survey) {
					backgroundSurvey = undefined;
				}
			});
	}

	pi.on("session_start", () => {
		sessionEpoch += 1;
		shuttingDown = false;
		closeBackground();
	});
	pi.on("session_shutdown", () => {
		sessionEpoch += 1;
		shuttingDown = true;
		closeBackground();
	});

	pi.registerTool<typeof AskUserParamsSchema, AskToolDetails>({
		name: "ask_user",
		label: "Ask User",
		description: TOOL_DESCRIPTION,
		promptSnippet:
			"ask_user: ask the user structured questions in an interactive questionnaire (tabs, multi-select, free-form).",
		promptGuidelines: [
			"Use ask_user when you need a decision or missing detail from the user; batch related questions into one call instead of asking repeatedly.",
			"Give ask_user questions labeled options where possible, keep them self-contained, and put recommended options first.",
			'Use mode: "urgent" when input is required before proceeding anywhere. Use mode: "background" (default) for independent work; answers steer the active run at the next model/tool boundary.',
		],
		parameters: AskUserParamsSchema,
		outputSchema: AskUserOutputSchema,
		executionMode: "sequential",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const questions = normalizeQuestions(params);
			if (questions.length === 0) {
				return {
					content: [{ type: "text", text: "No questions were provided." }],
					details: { cancelled: true, answers: [], questions },
					isError: true,
				};
			}
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: `${NO_UI_TEXT}\n${questionsAsText(questions)}` }],
					details: { cancelled: true, answers: [], questions },
					isError: true,
				};
			}

			const options = { title: params.title?.trim() || undefined, submitLabel: params.submitLabel?.trim() || DEFAULT_SUBMIT_LABEL };
			const mode = params.mode ?? (params.noWait === false ? "urgent" : "background");
			if (mode === "background" && ctx.mode === "tui") {
				if (backgroundSurvey && !isCurrent(backgroundSurvey, ctx)) {
					closeBackground();
				}
				if (backgroundSurvey) {
					return {
						content: [
							{
								type: "text",
								text: "Another background questionnaire is already open. Wait for the user to answer it before asking again.",
							},
						],
						details: { cancelled: true, pending: true, answers: [], questions },
						isError: true,
					};
				}
				startBackground(ctx, questions, options);
				return {
					content: [
						{
							type: "text",
							text: "Questionnaire shown to the user in the background. Continue with other work; the answers will be injected as steering at the next model/tool boundary. Incorporate them before continuing further work.",
						},
					],
					details: { cancelled: false, pending: true, answers: [], questions },
					structuredContent: toStructuredOutput(buildResult(questions, new Map(), false, true)),
				};
			}

			const result = await askQuestions(ctx, questions, { ...options, signal });
			return {
				content: [{ type: "text", text: resultContent(result) }],
				details: resultDetails(result, questions),
				structuredContent: toStructuredOutput(result),
			};
		},

		renderCall(args, theme, _context) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const count = questions.length;
			let text =
				theme.fg("toolTitle", theme.bold("ask_user ")) +
				theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
			const labels = questions
				.map((question, index) => question.label?.trim() || question.id?.trim() || `Q${index + 1}`)
				.join(", ");
			if (labels.length > 0) {
				text += theme.fg("dim", ` (${labels})`);
			}
			const first = questions[0]?.question;
			if (typeof first === "string" && first.length > 0) {
				text += `\n${theme.fg("dim", `  ${first}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details;
			const content = result.content[0];
			const contentText = content?.type === "text" ? content.text : undefined;
			if (!details) {
				return new Text(contentText ?? "", 0, 0);
			}
			if (details.pending) {
				return result.isError
					? new Text(contentText ?? "Background questionnaire busy", 0, 0)
					: new Text(theme.fg("muted", "Waiting for the user in the background"), 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((answer) => {
				const label = theme.fg("accent", answer.label);
				if (answer.skipped) {
					return `${label}${theme.fg("dim", ": skipped")}`;
				}
				if (answer.entries.length === 0) {
					return `${label}${theme.fg("dim", ": no answer")}`;
				}
				const values = answer.entries
					.map((entry) =>
						entry.custom
							? `${theme.fg("muted", "(typed) ")}${theme.fg("text", entry.value)}`
							: theme.fg("text", entry.label),
					)
					.join(theme.fg("dim", ", "));
				return `${label}${theme.fg("muted", ": ")}${values}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
