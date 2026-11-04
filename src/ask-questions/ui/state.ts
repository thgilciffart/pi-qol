/**
 * Pure answer and selection operations for the questionnaire component.
 *
 * Every function takes the current answer and returns a new one; the
 * component owns the map of answers and decides when to redraw.
 */
import {
	type AnswerEntry,
	type NormalizedOption,
	type NormalizedQuestion,
	type QuestionAnswer,
	makeAnswer,
} from "../questions.ts";

/** One selectable row under an option question. */
export type QuestionRow =
	| { kind: "option"; option: NormalizedOption; index: number }
	| { kind: "custom" }
	| { kind: "skip" };

export function optionEntry(option: NormalizedOption): AnswerEntry {
	return { value: option.value, label: option.label, custom: false };
}

function typedEntry(value: string): AnswerEntry {
	return { value, label: value, custom: true };
}

/** Answers seeded from preselected options (only the first for single-select). */
export function initialAnswers(questions: NormalizedQuestion[]): Map<string, QuestionAnswer> {
	const answers = new Map<string, QuestionAnswer>();
	for (const question of questions) {
		const preselected = question.options.filter((option) => option.selected).map(optionEntry);
		const entries = question.multiple ? preselected : preselected.slice(0, 1);
		if (entries.length > 0) {
			answers.set(question.id, makeAnswer(question, entries));
		}
	}
	return answers;
}

/** An answer with these entries; an empty optional answer counts as skipped. */
export function withEntries(question: NormalizedQuestion, entries: AnswerEntry[]): QuestionAnswer {
	return makeAnswer(question, entries, entries.length === 0 && !question.required);
}

export function listedEntries(answer: QuestionAnswer): AnswerEntry[] {
	return answer.entries.filter((entry) => !entry.custom);
}

export function typedValue(answer: QuestionAnswer): string | undefined {
	return answer.entries.find((entry) => entry.custom)?.value;
}

export function isOptionSelected(answer: QuestionAnswer, option: NormalizedOption): boolean {
	return answer.entries.some((entry) => !entry.custom && entry.value === option.value);
}

/**
 * Replace the typed answer with `text`, keeping any listed selections.
 * Free-form questions only ever hold the typed answer.
 */
export function withTypedText(
	question: NormalizedQuestion,
	answer: QuestionAnswer,
	text: string,
): QuestionAnswer {
	const value = text.trim();
	const listed = listedEntries(answer);
	return withEntries(question, value ? [...listed, typedEntry(value)] : listed);
}

/** Toggle a multi-select option. `full` reports a blocked selection at `max`. */
export function toggleMultiple(
	question: NormalizedQuestion,
	answer: QuestionAnswer,
	option: NormalizedOption,
): { answer: QuestionAnswer; full: boolean } {
	const index = answer.entries.findIndex((entry) => !entry.custom && entry.value === option.value);
	if (index >= 0) {
		return { answer: withEntries(question, answer.entries.toSpliced(index, 1)), full: false };
	}
	if (question.max !== undefined && answer.entries.length >= question.max) {
		return { answer: withEntries(question, answer.entries), full: true };
	}
	return { answer: withEntries(question, [...answer.entries, optionEntry(option)]), full: false };
}

/** Select or clear a single-select option, keeping the typed answer. */
export function toggleSingle(
	question: NormalizedQuestion,
	answer: QuestionAnswer,
	option: NormalizedOption,
): QuestionAnswer {
	const typed = answer.entries.filter((entry) => entry.custom);
	const entries = isOptionSelected(answer, option) ? typed : [optionEntry(option), ...typed];
	return withEntries(question, entries);
}

/** Select every option that fits under `max` next to the typed answer. */
export function selectAll(question: NormalizedQuestion, answer: QuestionAnswer): QuestionAnswer {
	const typed = answer.entries.filter((entry) => entry.custom);
	const capacity = question.max === undefined
		? question.options.length
		: Math.max(0, question.max - typed.length);
	return withEntries(question, [...question.options.slice(0, capacity).map(optionEntry), ...typed]);
}

export function rowsFor(question: NormalizedQuestion): QuestionRow[] {
	const rows: QuestionRow[] = question.options.map((option, index) => ({ kind: "option", option, index }));
	if (question.allowOther) {
		rows.push({ kind: "custom" });
	}
	if (!question.required) {
		rows.push({ kind: "skip" });
	}
	return rows;
}

/** Initial cursor row: the first preselected option, or the top row. */
export function initialCursor(question: NormalizedQuestion | undefined): number {
	return Math.max(0, question?.options.findIndex((option) => option.selected) ?? 0);
}
