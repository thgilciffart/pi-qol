/**
 * Pure questionnaire model: normalization, validation, and formatting.
 *
 * Everything in this file is free of UI and Pi runtime imports so it can be
 * unit tested and reasoned about in isolation.
 */
import type { AskUserOutput, AskUserParams } from "./schema.ts";

export const DEFAULT_SUBMIT_LABEL = "Submit";
export const DEFAULT_OTHER_LABEL = "Type something…";

export interface NormalizedOption {
	value: string;
	label: string;
	description?: string;
	selected: boolean;
}

export interface NormalizedQuestion {
	id: string;
	label: string;
	question: string;
	header?: string;
	options: NormalizedOption[];
	multiple: boolean;
	allowOther: boolean;
	required: boolean;
	min?: number;
	max?: number;
	placeholder?: string;
	otherLabel: string;
}

export interface AnswerEntry {
	/** Machine-readable value. */
	value: string;
	/** Human-readable label. */
	label: string;
	/** True when the user typed this answer. */
	custom: boolean;
}

export interface QuestionAnswer {
	id: string;
	label: string;
	question: string;
	entries: AnswerEntry[];
	skipped: boolean;
}

export interface AskResult {
	cancelled: boolean;
	/** True when the questionnaire is still open in the background (noWait). */
	pending?: boolean;
	answers: QuestionAnswer[];
}

export type AnswerStatus = "complete" | "partial" | "skipped" | "unanswered";

/**
 * Apply defaults and derive stable ids/tab labels.
 *
 * Questions without options become free-form questions. Duplicate or missing
 * ids are repaired so the result is always addressable.
 */
export function normalizeQuestions(params: AskUserParams): NormalizedQuestion[] {
	const used = new Set<string>();
	return params.questions.map((raw, index) => {
		const baseId = raw.id?.trim() || `q${index + 1}`;
		let id = baseId;
		let suffix = 2;
		while (used.has(id)) {
			id = `${baseId}-${suffix}`;
			suffix += 1;
		}
		used.add(id);

		const options: NormalizedOption[] = (raw.options ?? []).map((option) => ({
			value: option.value?.trim() || option.label,
			label: option.label,
			description: option.description,
			selected: option.selected ?? false,
		}));
		const freeForm = options.length === 0;
		// Free-form questions always hold exactly one typed answer, so
		// multiple/min/max do not apply to them.
		const multiple = freeForm ? false : (raw.multiple ?? false);

		return {
			id,
			label: raw.label?.trim() || `Q${index + 1}`,
			question: raw.question,
			header: raw.header,
			options,
			multiple,
			// A free-form question is always typed, so `allowOther` is irrelevant there.
			allowOther: freeForm ? true : (raw.allowOther ?? true),
			required: raw.required ?? true,
			min: multiple ? raw.min : undefined,
			max: multiple ? raw.max : undefined,
			placeholder: raw.placeholder,
			otherLabel: raw.otherLabel?.trim() || DEFAULT_OTHER_LABEL,
		};
	});
}

/** Create an answer object for a question, filling in display metadata. */
export function makeAnswer(
	question: NormalizedQuestion,
	entries: AnswerEntry[],
	skipped = false,
): QuestionAnswer {
	return {
		id: question.id,
		label: question.label,
		question: question.question,
		entries,
		skipped,
	};
}

/** Validation error for one answer, or null when the answer is acceptable. */
export function answerError(
	question: NormalizedQuestion,
	answer: QuestionAnswer | undefined,
): string | null {
	const entries = answer?.entries ?? [];
	if (entries.length === 0) {
		return question.required ? "This question needs an answer." : null;
	}
	const customCount = entries.filter((entry) => entry.custom).length;
	if (customCount > 1) {
		return "Only one typed answer is allowed.";
	}
	if (!question.multiple && entries.length - customCount > 1) {
		return "Only one option is allowed.";
	}
	if (question.multiple) {
		const min = question.min ?? (question.required ? 1 : 0);
		if (entries.length < min) {
			return `Select at least ${min} ${min === 1 ? "answer" : "answers"}.`;
		}
		if (question.max !== undefined && entries.length > question.max) {
			return `Select at most ${question.max} ${question.max === 1 ? "answer" : "answers"}.`;
		}
	}
	return null;
}

/** All validation errors for a questionnaire, in question order. */
export function collectAnswerErrors(
	questions: NormalizedQuestion[],
	answers: ReadonlyMap<string, QuestionAnswer>,
): Array<{ id: string; label: string; message: string }> {
	const errors: Array<{ id: string; label: string; message: string }> = [];
	for (const question of questions) {
		const message = answerError(question, answers.get(question.id));
		if (message) {
			errors.push({ id: question.id, label: question.label, message });
		}
	}
	return errors;
}

/** Status used for tab icons and the review tab. */
export function answerStatus(
	question: NormalizedQuestion,
	answer: QuestionAnswer | undefined,
): AnswerStatus {
	const entries = answer?.entries ?? [];
	if (entries.length === 0) {
		return question.required ? "unanswered" : "skipped";
	}
	if (answerError(question, answer)) {
		return "partial";
	}
	return "complete";
}

/**
 * Build the ordered result. Unanswered optional questions are reported as
 * skipped so the caller never has to infer intent from an empty list.
 */
export function buildResult(
	questions: NormalizedQuestion[],
	answers: ReadonlyMap<string, QuestionAnswer>,
	cancelled: boolean,
	pending = false,
): AskResult {
	return {
		cancelled,
		pending,
		answers: questions.map((question) => {
			const answer = answers.get(question.id) ?? makeAnswer(question, []);
			const skipped = answer.skipped || (!question.required && answer.entries.length === 0);
			return { ...answer, skipped };
		}),
	};
}

/** Machine-readable result matching the tool's `outputSchema`. */
export function toStructuredOutput(result: AskResult): AskUserOutput {
	return {
		cancelled: result.cancelled,
		pending: result.pending ?? false,
		answers: result.answers.map((answer) => ({
			id: answer.id,
			question: answer.question,
			skipped: answer.skipped,
			answers: answer.entries.map((entry) => ({
				value: entry.value,
				label: entry.label,
				custom: entry.custom,
			})),
		})),
	};
}

/** Compact, model-facing summary of the answers. */
export function formatAnswersText(result: AskResult): string {
	if (result.cancelled) {
		return "The user cancelled the questionnaire before submitting.";
	}
	if (result.answers.length === 0) {
		return "No questions were answered.";
	}
	return result.answers
		.map((answer) => {
			if (answer.skipped) {
				return `${answer.label}: (skipped)`;
			}
			if (answer.entries.length === 0) {
				return `${answer.label}: (no answer)`;
			}
			const selected = answer.entries
				.filter((entry) => !entry.custom)
				.map((entry) => `"${entry.label}"`);
			const typed = answer.entries
				.filter((entry) => entry.custom)
				.map((entry) => `"${entry.value}"`);
			const parts: string[] = [];
			if (selected.length > 0) {
				parts.push(`selected ${selected.join(", ")}`);
			}
			if (typed.length > 0) {
				parts.push(`typed ${typed.join(", ")}`);
			}
			return `${answer.label}: ${parts.join(", ")}`;
		})
		.join("\n");
}

/**
 * Visible window for a list that does not fit on screen. Keeps the cursor
 * inside a fixed-size window and reports how many entries are hidden.
 */
export function windowRange(
	total: number,
	cursor: number,
	maxVisible: number,
): { start: number; end: number; hiddenAbove: number; hiddenBelow: number } {
	if (total <= maxVisible) {
		return { start: 0, end: total, hiddenAbove: 0, hiddenBelow: 0 };
	}
	const half = Math.floor(maxVisible / 2);
	let start = Math.max(0, cursor - half);
	let end = Math.min(total, start + maxVisible);
	start = Math.max(0, end - maxVisible);
	end = Math.min(total, start + maxVisible);
	return { start, end, hiddenAbove: start, hiddenBelow: total - end };
}
