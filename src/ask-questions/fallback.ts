/**
 * Sequential fallback for modes that have dialogs but no custom terminal
 * components (currently RPC). The full tabbed UI is only available in TUI
 * mode; here every question is asked with `select`/`input` instead.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	type AnswerEntry,
	type AskResult,
	type NormalizedQuestion,
	type QuestionAnswer,
	answerError,
	buildResult,
	makeAnswer,
} from "./questions.ts";

type FallbackUI = Pick<ExtensionUIContext, "select" | "input" | "notify">;

/** Ask every question in sequence using the built-in dialogs. */
export async function runFallbackSurvey(
	ui: FallbackUI,
	questions: NormalizedQuestion[],
	signal?: AbortSignal,
): Promise<AskResult> {
	const answers = new Map<string, QuestionAnswer>();
	const dialogOptions = signal ? { signal } : undefined;
	const done = (cancelled: boolean): AskResult => buildResult(questions, answers, cancelled);

	for (const question of questions) {
		if (signal?.aborted) {
			return done(true);
		}
		let answered: boolean;
		if (question.options.length === 0) {
			answered = await askFreeForm(ui, question, answers, dialogOptions);
		} else {
			answered = await askOptions(ui, question, answers, dialogOptions);
		}
		if (!answered) {
			return done(true);
		}
	}
	return done(false);
}

type DialogOptions = { signal: AbortSignal } | undefined;

async function askFreeForm(
	ui: FallbackUI,
	question: NormalizedQuestion,
	answers: Map<string, QuestionAnswer>,
	options: DialogOptions,
): Promise<boolean> {
	while (true) {
		const typed = await ui.input(question.question, question.placeholder ?? "", options);
		if (typed === undefined) {
			return false;
		}
		const value = typed.trim();
		if (value.length === 0) {
			if (!question.required) {
				answers.set(question.id, makeAnswer(question, [], true));
				return true;
			}
			ui.notify("An answer is required.", "warning");
			continue;
		}
		answers.set(question.id, makeAnswer(question, [{ value, label: value, custom: true }]));
		return true;
	}
}

async function askOptions(
	ui: FallbackUI,
	question: NormalizedQuestion,
	answers: Map<string, QuestionAnswer>,
	options: DialogOptions,
): Promise<boolean> {
	const selected = new Set<number>();
	question.options.forEach((option, index) => {
		if (option.selected && (question.multiple || selected.size === 0)) {
			selected.add(index);
		}
	});
	let custom: AnswerEntry | undefined;
	const doneLabel = "Done";
	const customLabel = `${question.otherLabel} (type an answer)`;
	const skipLabel = "Skip this question";

	while (true) {
		const optionLabels = question.options.map((option, index) => {
			const marker = question.multiple
				? (selected.has(index) ? "[x]" : "[ ]")
				: (selected.has(index) ? "(•)" : "( )");
			return `${marker} ${index + 1}. ${option.label}`;
		});
		const choices = [...optionLabels, doneLabel];
		if (question.allowOther) {
			choices.push(customLabel);
		}
		if (!question.required) {
			choices.push(skipLabel);
		}
		const choice = await ui.select(question.question, choices, options);
		if (choice === undefined) {
			return false;
		}
		if (choice === skipLabel) {
			answers.set(question.id, makeAnswer(question, [], true));
			return true;
		}
		if (choice === customLabel) {
			const typed = await ui.input(question.question, question.placeholder ?? "", options);
			if (typed === undefined) {
				return false;
			}
			const value = typed.trim();
			// A question holds at most one typed answer; editing replaces it,
			// and clearing it preserves the listed selection.
			custom = value ? { value, label: value, custom: true } : undefined;
			continue;
		}
		if (choice === doneLabel) {
			const entries: AnswerEntry[] = [
				...question.options
					.filter((_, index) => selected.has(index))
					.map((option) => ({ value: option.value, label: option.label, custom: false })),
				...(custom ? [custom] : []),
			];
			const error = answerError(question, makeAnswer(question, entries));
			if (error) {
				ui.notify(error, "warning");
				continue;
			}
			answers.set(question.id, makeAnswer(question, entries, !question.required && entries.length === 0));
			return true;
		}
		const index = choices.indexOf(choice);
		if (index >= 0 && index < question.options.length) {
			if (!question.multiple) {
				const wasSelected = selected.has(index);
				selected.clear();
				if (!wasSelected) {
					selected.add(index);
				}
			} else if (selected.has(index)) {
				selected.delete(index);
			} else {
				selected.add(index);
			}
		}
	}
}
