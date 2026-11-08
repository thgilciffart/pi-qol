/**
 * Sequential fallback for modes that have dialogs but no custom terminal
 * components (currently RPC). The full tabbed UI is only available in TUI
 * mode; here every question is asked with `select`/`input` instead.
 *
 * RPC hosts (for example T3 Code) render each dialog as a fresh, stateless
 * single-choice question, so single-choice questions use plain option labels
 * and submit as soon as an option is picked. Multi-select keeps selection
 * markers and a Done entry, because the markers are the only way to carry
 * the selection across independent dialogs.
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

/** Dialog title: the question text plus its optional header context. */
function titleFor(question: NormalizedQuestion): string {
	return question.header ? `${question.question}\n${question.header}` : question.question;
}

async function askFreeForm(
	ui: FallbackUI,
	question: NormalizedQuestion,
	answers: Map<string, QuestionAnswer>,
	options: DialogOptions,
): Promise<boolean> {
	while (true) {
		const typed = await ui.input(titleFor(question), question.placeholder ?? "", options);
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

	const choices = (): string[] => {
		const optionLabels = question.options.map((option, index) =>
			question.multiple
				? `${selected.has(index) ? "[x]" : "[ ]"} ${index + 1}. ${option.label}`
				: option.label,
		);
		return [
			...optionLabels,
			doneLabel,
			...(question.allowOther ? [customLabel] : []),
			...(!question.required ? [skipLabel] : []),
		];
	};

	/** Validate and store the current entries; returns false to re-ask. */
	const submit = (entries: AnswerEntry[], skipped: boolean): boolean => {
		const error = answerError(question, makeAnswer(question, entries, skipped));
		if (error) {
			ui.notify(error, "warning");
			return false;
		}
		answers.set(question.id, makeAnswer(question, entries, skipped));
		return true;
	};

	while (true) {
		const currentChoices = choices();
		const choice = await ui.select(titleFor(question), currentChoices, options);
		if (choice === undefined) {
			return false;
		}
		if (choice === skipLabel) {
			answers.set(question.id, makeAnswer(question, [], true));
			return true;
		}
		if (choice === customLabel) {
			const typed = await ui.input(titleFor(question), question.placeholder ?? "", options);
			if (typed === undefined) {
				return false;
			}
			const value = typed.trim();
			// A question holds at most one typed answer; editing replaces it,
			// and clearing it preserves the listed selection.
			custom = value ? { value, label: value, custom: true } : undefined;
			continue;
		}
		const index = currentChoices.indexOf(choice);
		if (index >= 0 && index < question.options.length) {
			if (!question.multiple) {
				// Single choice answers the question as soon as an option is
				// picked; a typed answer entered earlier rides along.
				const option = question.options[index];
				return submit([
					{ value: option.value, label: option.label, custom: false },
					...(custom ? [custom] : []),
				], false);
			}
			if (selected.has(index)) {
				selected.delete(index);
			} else {
				selected.add(index);
			}
			continue;
		}
		if (choice === doneLabel) {
			const entries: AnswerEntry[] = [
				...question.options
					.filter((_, optionIndex) => selected.has(optionIndex))
					.map((option) => ({ value: option.value, label: option.label, custom: false })),
				...(custom ? [custom] : []),
			];
			if (submit(entries, !question.required && entries.length === 0)) {
				return true;
			}
			continue;
		}
	}
}
