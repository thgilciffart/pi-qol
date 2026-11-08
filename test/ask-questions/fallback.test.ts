import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { runFallbackSurvey } from "../../src/ask-questions/fallback.ts";
import { normalizeQuestions } from "../../src/ask-questions/questions.ts";

type DialogChoice = string | number | undefined | ((choices: string[]) => string);

function dialogs(selections: DialogChoice[], inputs: Array<string | undefined> = []) {
	const notifications: string[] = [];
	const ui: Parameters<typeof runFallbackSurvey>[0] = {
		select: async (_title, choices) => {
			assert.ok(selections.length > 0, "unexpected selection dialog");
			const next = selections.shift();
			const choice = typeof next === "function" ? next(choices)
				: typeof next === "number" ? choices[next] : next;
			if (choice !== undefined) assert.ok(choices.includes(choice), `Missing choice: ${choice}`);
			return choice;
		},
		input: async () => {
			assert.ok(inputs.length > 0, "unexpected text dialog");
			return inputs.shift();
		},
		notify: (message) => { notifications.push(message); },
	};
	return { ui, notifications };
}

const CUSTOM = "Type something… (type an answer)";
const OPTIONS = [{ label: "Alpha" }, { label: "Beta" }];

describe("RPC questionnaire fallback", () => {
	it("answers a single-choice question with one dialog when an option is picked", async () => {
		const { ui } = dialogs([(choices) => {
			assert.deepEqual(choices, ["Alpha", "Beta", "Done", CUSTOM]);
			return choices[1];
		}]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS }],
		}));
		assert.equal(result.cancelled, false);
		assert.deepEqual(result.answers[0]?.entries, [
			{ value: "Beta", label: "Beta", custom: false },
		]);
	});

	it("adds a typed answer entered before the picked option", async () => {
		const { ui } = dialogs([CUSTOM, 0], ["  extra context  "]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose and explain", options: OPTIONS }],
		}));
		assert.equal(result.cancelled, false);
		assert.deepEqual(result.answers[0]?.entries, [
			{ value: "Alpha", label: "Alpha", custom: false },
			{ value: "extra context", label: "extra context", custom: true },
		]);
	});

	it("supports a typed answer without a listed selection via Done", async () => {
		const { ui } = dialogs([CUSTOM, "Done"], ["Something else"]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS }],
		}));
		assert.deepEqual(result.answers[0]?.entries, [
			{ value: "Something else", label: "Something else", custom: true },
		]);
	});

	it("edits and clears the typed answer before picking an option", async () => {
		const { ui } = dialogs([CUSTOM, CUSTOM, CUSTOM, 0], ["first", "replacement", "  "]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS }],
		}));
		assert.deepEqual(result.answers[0]?.entries, [
			{ value: "Alpha", label: "Alpha", custom: false },
		]);
	});

	it("submits the first preset on single-choice questions when Done is chosen", async () => {
		const { ui } = dialogs([(choices) => {
			assert.equal(choices[0], "Alpha");
			assert.equal(choices[1], "Beta");
			return "Done";
		}]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS.map((option) => ({ ...option, selected: true })) }],
		}));
		assert.deepEqual(result.answers[0]?.entries.map((entry) => entry.value), ["Alpha"]);
	});

	it("keeps multi-select markers and validation and accepts a typed answer alongside selections", async () => {
		const { ui, notifications } = dialogs([0, "Done", CUSTOM, "Done"], ["extra"]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose two", multiple: true, min: 2, options: OPTIONS }],
		}));
		assert.deepEqual(notifications, ["Select at least 2 answers."]);
		assert.deepEqual(result.answers[0]?.entries.map((entry) => entry.value), ["Alpha", "extra"]);
	});

	it("requires an answer before accepting Done on a required question", async () => {
		const { ui, notifications } = dialogs(["Done", 1]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS, allowOther: false }],
		}));
		assert.deepEqual(notifications, ["This question needs an answer."]);
		assert.deepEqual(result.answers[0]?.entries.map((entry) => entry.value), ["Beta"]);
	});

	it("reports an optional question as skipped when Done has no answers", async () => {
		const { ui } = dialogs(["Done"]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS, required: false }],
		}));
		assert.equal(result.cancelled, false);
		assert.equal(result.answers[0]?.skipped, true);
	});

	it("skips an optional question through the skip entry", async () => {
		const { ui } = dialogs(["Skip this question"]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS, required: false, allowOther: false }],
		}));
		assert.equal(result.cancelled, false);
		assert.equal(result.answers[0]?.skipped, true);
	});

	it("cancels when the select dialog is dismissed", async () => {
		const { ui } = dialogs([undefined]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS }],
		}));
		assert.equal(result.cancelled, true);
	});

	it("cancels when the custom answer dialog is dismissed", async () => {
		const { ui } = dialogs([CUSTOM], [undefined]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS }],
		}));
		assert.equal(result.cancelled, true);
	});
});
