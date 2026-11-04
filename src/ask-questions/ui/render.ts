/**
 * Rendering for the questionnaire component. Every function draws from a
 * read-only snapshot of the component state, so layout stays separate from
 * key handling.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type NormalizedQuestion,
	type QuestionAnswer,
	answerError,
	answerStatus,
	collectAnswerErrors,
	makeAnswer,
	windowRange,
} from "../questions.ts";
import { isOptionSelected, rowsFor, typedValue } from "./state.ts";

export const MAX_VISIBLE_ROWS = 8;

export type NoticeKind = "info" | "warning" | "error" | "success";
export interface Notice {
	text: string;
	kind: NoticeKind;
}

const NOTICE_COLORS: Record<NoticeKind, "muted" | "warning" | "error" | "success"> = {
	info: "muted",
	warning: "warning",
	error: "error",
	success: "success",
};

/** Everything the renderer reads. `tab === questions.length` is the review tab. */
export interface QuestionnaireView {
	title?: string;
	submitLabel: string;
	questions: NormalizedQuestion[];
	answers: ReadonlyMap<string, QuestionAnswer>;
	tab: number;
	cursor: number;
	submitCursor: number;
	notice?: Notice;
	/** Editor for the current question's typed answer. */
	editor: Component;
	draftEmpty: boolean;
}

/** Appends wrapped lines; continuation lines are indented to the prefix width. */
class Lines {
	readonly lines: string[] = [];
	constructor(readonly width: number) {}

	add(prefix: string, text: string): void {
		const prefixWidth = visibleWidth(prefix);
		if (prefixWidth >= this.width) {
			this.lines.push(...wrapTextWithAnsi(prefix + text, this.width));
			return;
		}
		const continuation = " ".repeat(prefixWidth);
		wrapTextWithAnsi(text, this.width - prefixWidth).forEach((line, index) => {
			this.lines.push(`${index === 0 ? prefix : continuation}${line}`);
		});
	}

	/** Embed a child component indented by `indent` columns. */
	embed(component: Component, indent: number): void {
		const pad = " ".repeat(indent);
		for (const line of component.render(Math.max(1, this.width - 2))) {
			this.lines.push(`${pad}${line}`);
		}
	}
}

function answerOf(view: QuestionnaireView, question: NormalizedQuestion): QuestionAnswer {
	return view.answers.get(question.id) ?? makeAnswer(question, []);
}

function onReviewTab(view: QuestionnaireView): boolean {
	return view.questions.length > 1 && view.tab === view.questions.length;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

export function renderQuestionnaire(theme: Theme, view: QuestionnaireView, width: number): string[] {
	const out = new Lines(Math.max(1, width));
	const showTabs = view.questions.length > 1;
	const border = theme.fg("borderAccent", "─".repeat(out.width));

	out.lines.push(border);
	if (view.title) {
		out.add(" ", theme.bold(theme.fg("accent", view.title)));
	}
	if (showTabs) {
		renderTabs(out, theme, view);
	}
	if (view.title || showTabs) {
		out.add(" ", "");
	}
	if (onReviewTab(view)) {
		renderReview(out, theme, view);
	} else {
		renderQuestion(out, theme, view);
	}
	out.add(" ", "");
	if (view.notice) {
		out.add(" ", theme.fg(NOTICE_COLORS[view.notice.kind], view.notice.text));
	}
	out.add(" ", theme.fg("dim", helpText(view)));
	out.lines.push(border);
	return out.lines;
}

function renderTabs(out: Lines, theme: Theme, view: QuestionnaireView): void {
	const { questions, answers } = view;
	const parts = questions.map((question, index) => {
		const text = ` ${question.label} `;
		if (index === view.tab) {
			return theme.bg("selectedBg", theme.fg("text", text));
		}
		const status = answerStatus(question, answers.get(question.id));
		const color = status === "complete" ? "success" : status === "partial" ? "accent" : "muted";
		return theme.fg(color, text);
	});
	const submitText = ` ${view.submitLabel} `;
	if (onReviewTab(view)) {
		parts.push(theme.bg("selectedBg", theme.fg("text", submitText)));
	} else {
		const ready = collectAnswerErrors(questions, answers).length === 0;
		parts.push(theme.fg(ready ? "success" : "dim", submitText));
	}
	out.add(" ", parts.join(" "));
	const readyCount = questions.filter((question) => !answerError(question, answers.get(question.id))).length;
	out.add(" ", theme.fg("dim", `${readyCount} of ${questions.length} questions ready`));
}

function renderQuestion(out: Lines, theme: Theme, view: QuestionnaireView): void {
	const question = view.questions[view.tab];
	if (!question) {
		return;
	}
	out.add(" ", theme.bold(theme.fg("text", question.question)));
	if (question.header) {
		out.add(" ", theme.fg("muted", question.header));
	}
	if (!question.required) {
		const hint = question.options.length === 0 ? "leave empty to skip" : "choose Skip this question to skip";
		out.add(" ", theme.fg("dim", `Optional • ${hint}`));
	}
	if (question.multiple) {
		const min = question.min !== undefined
			? `at least ${question.min}`
			: question.required ? "one or more" : "any number";
		const max = question.max !== undefined ? `, up to ${question.max}` : "";
		const selected = plural(answerOf(view, question).entries.length, "answer", "answers");
		out.add(" ", theme.fg("dim", `Select ${min}${max} • ${selected} selected • Space toggles`));
	}
	out.add(" ", "");
	if (question.options.length === 0) {
		if (question.placeholder && view.draftEmpty) {
			out.add(" ", theme.fg("dim", question.placeholder));
		}
		out.embed(view.editor, 1);
		return;
	}
	renderRows(out, theme, view, question);
}

function renderRows(out: Lines, theme: Theme, view: QuestionnaireView, question: NormalizedQuestion): void {
	const answer = answerOf(view, question);
	const rows = rowsFor(question);
	const { start, end, hiddenAbove, hiddenBelow } = windowRange(rows.length, view.cursor, MAX_VISIBLE_ROWS);
	if (hiddenAbove > 0) {
		out.add("  ", theme.fg("dim", `${hiddenAbove} more above`));
	}
	for (let index = start; index < end; index += 1) {
		const row = rows[index]!;
		const active = index === view.cursor;
		const marker = active ? theme.fg("accent", "❯ ") : "  ";
		if (row.kind === "option") {
			const selected = isOptionSelected(answer, row.option);
			const box = question.multiple ? (selected ? "[x]" : "[ ]") : selected ? "(•)" : "( )";
			const number = row.index < 9 ? `${row.index + 1}.` : "  ";
			const color = active ? "accent" : selected ? "success" : "text";
			out.add(marker, theme.fg(color, `${box} ${number} ${row.option.label}`));
			if (row.option.description) {
				out.add("     ", theme.fg("muted", row.option.description));
			}
		} else if (row.kind === "custom") {
			out.add(marker, theme.fg(active ? "accent" : "text", question.otherLabel));
			const typed = typedValue(answer);
			if (active) {
				if (view.draftEmpty && question.placeholder) {
					out.add("  ", theme.fg("dim", question.placeholder));
				}
				out.embed(view.editor, 2);
			} else if (typed) {
				out.add("  ", theme.fg("text", typed));
			}
		} else {
			out.add(marker, theme.fg(active ? "accent" : "warning", "Skip this question"));
		}
	}
	if (hiddenBelow > 0) {
		out.add("  ", theme.fg("dim", `${hiddenBelow} more below`));
	}
}

function renderReview(out: Lines, theme: Theme, view: QuestionnaireView): void {
	const { questions, answers } = view;
	out.add(" ", theme.bold(theme.fg("text", "Review your answers")));
	out.add(" ", "");
	const errors = collectAnswerErrors(questions, answers);
	const invalid = new Map(errors.map((error) => [error.id, error.message]));
	questions.forEach((question, index) => {
		const answer = answerOf(view, question);
		const marker = view.submitCursor === index ? theme.fg("accent", "❯ ") : "  ";
		let summary: string;
		if (answer.skipped) {
			summary = theme.fg("dim", "(skipped)");
		} else if (answer.entries.length === 0) {
			summary = question.required
				? theme.fg("warning", "(unanswered)")
				: theme.fg("dim", "(optional, skipped)");
		} else {
			summary = answer.entries
				.map((entry) => (entry.custom ? theme.fg("accent", `"${entry.value}"`) : theme.fg("text", entry.label)))
				.join(theme.fg("dim", ", "));
		}
		out.add(marker, `${theme.fg("muted", `${question.label}: `)}${summary}`);
		const error = invalid.get(question.id);
		if (error) {
			out.add("    ", theme.fg("warning", error));
		}
	});
	out.add(" ", "");
	const ready = errors.length === 0;
	out.add(
		view.submitCursor === questions.length ? theme.fg("accent", "❯ ") : "  ",
		theme.fg(ready ? "success" : "warning", `[ ${view.submitLabel} ]`),
	);
	if (!ready) {
		out.add("  ", theme.fg("warning", `${plural(errors.length, "question needs", "questions need")} attention`));
	}
}

function helpText(view: QuestionnaireView): string {
	const showTabs = view.questions.length > 1;
	if (onReviewTab(view)) {
		return `↑↓ choose • Enter open or ${view.submitLabel} • Tab switch • Esc cancel`;
	}
	const question = view.questions[view.tab];
	if (!question) {
		return "Tab switch • Esc cancel";
	}
	if (question.options.length === 0) {
		return `Enter ${showTabs ? "confirm" : "submit"} • \\+Enter newline${showTabs ? " • Tab switch" : ""} • Esc cancel`;
	}
	if (rowsFor(question)[view.cursor]?.kind === "custom") {
		return "Type your answer • Enter confirm • \\+Enter newline • ↑↓ edit/move • Esc cancel";
	}
	if (question.multiple) {
		return "↑↓ move • Space toggle • A all • C clear • 1-9 jump • Enter confirm • Tab switch";
	}
	return "↑↓ move • Space select/clear • 1-9 select/clear • Enter confirm • Tab switch • Esc cancel";
}
