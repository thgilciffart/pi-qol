import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
	type QuestionAnswer,
	DEFAULT_OTHER_LABEL,
	answerError,
	answerStatus,
	buildResult,
	collectAnswerErrors,
	formatAnswersText,
	makeAnswer,
	normalizeQuestions,
	toStructuredOutput,
	windowRange,
} from "../../src/ask-questions/questions.ts";
import type { RawQuestion } from "../../src/ask-questions/schema.ts";

function normalize(question: RawQuestion) {
	return normalizeQuestions({ questions: [question] })[0]!;
}

describe("normalizeQuestions", () => {
	it("applies defaults and derives option values from labels", () => {
		const question = normalize({
			id: "scope",
			question: "Pick a scope",
			options: [{ label: "Everything" }],
		});
		assert.equal(question.id, "scope");
		assert.equal(question.label, "Q1");
		assert.equal(question.multiple, false);
		assert.equal(question.allowOther, true);
		assert.equal(question.required, true);
		assert.equal(question.min, undefined);
		assert.equal(question.max, undefined);
		assert.deepEqual(question.options, [
			{ value: "Everything", label: "Everything", description: undefined, selected: false },
		]);
	});

	it("generates missing ids and repairs duplicates", () => {
		const questions = normalizeQuestions({
			questions: [{ question: "a" }, { question: "b" }, { id: "q1", question: "c" }],
		});
		assert.deepEqual(
			questions.map((question) => question.id),
			["q1", "q2", "q1-2"],
		);
		assert.deepEqual(
			questions.map((question) => question.label),
			["Q1", "Q2", "Q3"],
		);
	});

	it("keeps custom labels and option metadata", () => {
		const question = normalize({
			label: "Database",
			question: "Which database?",
			multiple: true,
			min: 1,
			max: 2,
			allowOther: false,
			otherLabel: "Other",
			options: [
				{ value: "pg", label: "PostgreSQL", description: "Relational", selected: true },
				{ value: "sqlite", label: "SQLite" },
			],
		});
		assert.equal(question.label, "Database");
		assert.equal(question.multiple, true);
		assert.equal(question.min, 1);
		assert.equal(question.max, 2);
		assert.equal(question.allowOther, false);
		assert.equal(question.otherLabel, "Other");
		assert.deepEqual(question.options[0], {
			value: "pg",
			label: "PostgreSQL",
			description: "Relational",
			selected: true,
		});
	});

	it("treats questions without options as free-form with a single typed answer", () => {
		const question = normalize({
			question: "Anything else?",
			allowOther: false,
			multiple: true,
			min: 2,
			max: 3,
		});
		assert.deepEqual(question.options, []);
		assert.equal(question.allowOther, true);
		assert.equal(question.multiple, false);
		assert.equal(question.min, undefined);
		assert.equal(question.max, undefined);
		assert.equal(question.otherLabel, DEFAULT_OTHER_LABEL);
	});
});

describe("answerError", () => {
	it("requires an answer for required questions", () => {
		const question = normalize({ question: "Pick", options: [{ label: "A" }] });
		assert.equal(answerError(question, undefined), "This question needs an answer.");
		assert.equal(answerError(question, makeAnswer(question, [])), "This question needs an answer.");
	});

	it("allows empty answers for optional questions", () => {
		const question = normalize({ question: "Pick", required: false, options: [{ label: "A" }] });
		assert.equal(answerError(question, undefined), null);
	});

	it("accepts a single selection", () => {
		const question = normalize({ question: "Pick", options: [{ label: "A" }] });
		assert.equal(
			answerError(question, makeAnswer(question, [{ value: "A", label: "A", custom: false }])),
			null,
		);
	});

	it("allows one listed option plus one typed answer on a single-choice question", () => {
		const question = normalize({ question: "Pick", options: [{ label: "A" }, { label: "B" }] });
		const selected = { value: "A", label: "A", custom: false };
		const typed = { value: "extra", label: "extra", custom: true };
		assert.equal(answerError(question, makeAnswer(question, [selected, typed])), null);
		assert.equal(
			answerError(question, makeAnswer(question, [selected, { value: "B", label: "B", custom: false }, typed])),
			"Only one option is allowed.",
		);
		assert.equal(
			answerError(question, makeAnswer(question, [selected, typed, { ...typed, value: "another" }])),
			"Only one typed answer is allowed.",
		);
	});

	it("enforces min and max for multiple-choice questions", () => {
		const question = normalize({
			question: "Pick some",
			multiple: true,
			min: 2,
			max: 3,
			options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }],
		});
		const entry = (value: string) => ({ value, label: value, custom: false });
		assert.equal(
			answerError(question, makeAnswer(question, [entry("A")])),
			"Select at least 2 answers.",
		);
		assert.equal(
			answerError(question, makeAnswer(question, [entry("A"), entry("B"), entry("C"), entry("D")])),
			"Select at most 3 answers.",
		);
		assert.equal(
			answerError(question, makeAnswer(question, [entry("A"), entry("B")])),
			null,
		);
	});

	it("counts typed answers toward min and max", () => {
		const question = normalize({
			question: "Pick some",
			multiple: true,
			max: 1,
			options: [{ label: "A" }],
		});
		const entries = [
			{ value: "A", label: "A", custom: false },
			{ value: "typed", label: "typed", custom: true },
		];
		assert.equal(answerError(question, makeAnswer(question, entries)), "Select at most 1 answer.");
	});
});

describe("collectAnswerErrors", () => {
	it("reports errors in question order", () => {
		const questions = normalizeQuestions({
			questions: [
				{ id: "a", question: "First", options: [{ label: "x" }] },
				{ id: "b", question: "Second", required: false, options: [{ label: "y" }] },
				{ id: "c", question: "Third", options: [{ label: "z" }] },
			],
		});
		const answers = new Map<string, QuestionAnswer>();
		const errors = collectAnswerErrors(questions, answers);
		assert.deepEqual(
			errors.map((error) => error.id),
			["a", "c"],
		);
		assert.equal(errors[0]!.label, "Q1");
	});
});

describe("answerStatus", () => {
	it("marks selections over the maximum as partial", () => {
		const question = normalize({ question: "Choose", multiple: true, max: 1, options: [{ label: "Alpha" }] });
		assert.equal(answerStatus(question, makeAnswer(question, [
			{ value: "Alpha", label: "Alpha", custom: false },
			{ value: "extra", label: "extra", custom: true },
		])), "partial");
	});

	it("distinguishes unanswered, skipped, partial, and complete", () => {
		const required = normalize({ question: "Pick", options: [{ label: "A" }] });
		assert.equal(answerStatus(required, undefined), "unanswered");

		const optional = normalize({ question: "Pick", required: false, options: [{ label: "A" }] });
		assert.equal(answerStatus(optional, undefined), "skipped");

		const multi = normalize({
			question: "Pick",
			multiple: true,
			min: 2,
			options: [{ label: "A" }, { label: "B" }],
		});
		assert.equal(
			answerStatus(multi, makeAnswer(multi, [{ value: "A", label: "A", custom: false }])),
			"partial",
		);
		assert.equal(
			answerStatus(
				multi,
				makeAnswer(multi, [
					{ value: "A", label: "A", custom: false },
					{ value: "B", label: "B", custom: false },
				]),
			),
			"complete",
		);
	});
});

describe("buildResult and toStructuredOutput", () => {
	it("marks unanswered optional questions as skipped", () => {
		const questions = normalizeQuestions({
			questions: [
				{ id: "req", question: "Required", options: [{ label: "A" }] },
				{ id: "opt", question: "Optional", required: false },
			],
		});
		const answers = new Map<string, QuestionAnswer>([
			["req", makeAnswer(questions[0]!, [{ value: "A", label: "A", custom: false }])],
		]);
		const result = buildResult(questions, answers, false);
		assert.equal(result.cancelled, false);
		assert.equal(result.answers[0]!.skipped, false);
		assert.equal(result.answers[1]!.skipped, true);
	});

	it("converts results into the outputSchema shape", () => {
		const question = normalize({ id: "db", label: "DB", question: "Which DB?" });
		const answer = makeAnswer(question, [
			{ value: "pg", label: "PostgreSQL", custom: false },
			{ value: "mysql", label: "mysql", custom: true },
		]);
		const output = toStructuredOutput({ cancelled: false, answers: [answer] });
		assert.deepEqual(output, {
			cancelled: false,
			pending: false,
			answers: [
				{
					id: "db",
					question: "Which DB?",
					skipped: false,
					answers: [
						{ value: "pg", label: "PostgreSQL", custom: false },
						{ value: "mysql", label: "mysql", custom: true },
					],
				},
			],
		});
	});
});

describe("formatAnswersText", () => {
	it("describes typed and selected answers", () => {
		const question = normalize({ id: "db", label: "DB", question: "Which DB?" });
		const answer = makeAnswer(question, [
			{ value: "pg", label: "PostgreSQL", custom: false },
			{ value: "mysql", label: "mysql", custom: true },
		]);
		assert.equal(
			formatAnswersText({ cancelled: false, answers: [answer] }),
			'DB: selected "PostgreSQL", typed "mysql"',
		);
	});

	it("reports skipped questions and cancellation", () => {
		const question = normalize({ id: "x", label: "Extra", question: "More?", required: false });
		const answer = makeAnswer(question, [], true);
		assert.equal(formatAnswersText({ cancelled: false, answers: [answer] }), "Extra: (skipped)");
		assert.equal(
			formatAnswersText({ cancelled: true, answers: [] }),
			"The user cancelled the questionnaire before submitting.",
		);
	});
});

describe("windowRange", () => {
	it("shows everything when it fits", () => {
		assert.deepEqual(windowRange(3, 0, 5), {
			start: 0,
			end: 3,
			hiddenAbove: 0,
			hiddenBelow: 0,
		});
	});

	it("keeps the cursor visible at both ends", () => {
		assert.deepEqual(windowRange(20, 0, 8), {
			start: 0,
			end: 8,
			hiddenAbove: 0,
			hiddenBelow: 12,
		});
		assert.deepEqual(windowRange(20, 19, 8), {
			start: 12,
			end: 20,
			hiddenAbove: 12,
			hiddenBelow: 0,
		});
	});

	it("centers the window around the cursor in the middle", () => {
		assert.deepEqual(windowRange(20, 10, 8), {
			start: 6,
			end: 14,
			hiddenAbove: 6,
			hiddenBelow: 6,
		});
	});
});
