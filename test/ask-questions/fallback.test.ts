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
	it("keeps a single selection open so a typed extra answer can be added", async () => {
		const { ui } = dialogs([0, CUSTOM, "Done"], ["  extra context  "]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose and explain", options: OPTIONS }],
		}));
		assert.equal(result.cancelled, false);
		assert.deepEqual(result.answers[0]?.entries, [
			{ value: "Alpha", label: "Alpha", custom: false },
			{ value: "extra context", label: "extra context", custom: true },
		]);
	});

	it("replaces a single listed selection without losing the typed answer", async () => {
		const { ui } = dialogs([0, CUSTOM, 1, "Done"], ["explanation"]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS }],
		}));
		assert.deepEqual(result.answers[0]?.entries, [
			{ value: "Beta", label: "Beta", custom: false },
			{ value: "explanation", label: "explanation", custom: true },
		]);
	});

	it("supports a typed answer without a listed selection", async () => {
		const { ui } = dialogs([CUSTOM, "Done"], ["Something else"]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS }],
		}));
		assert.deepEqual(result.answers[0]?.entries, [
			{ value: "Something else", label: "Something else", custom: true },
		]);
	});

	it("preserves only the first preset on single-choice questions", async () => {
		const { ui } = dialogs([(choices) => {
			assert.equal(choices[0], "(•) 1. Alpha");
			assert.equal(choices[1], "( ) 2. Beta");
			return "Done";
		}]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS.map((option) => ({ ...option, selected: true })) }],
		}));
		assert.deepEqual(result.answers[0]?.entries.map((entry) => entry.value), ["Alpha"]);
	});

	it("clears a preset single option while retaining the typed answer", async () => {
		const { ui } = dialogs([CUSTOM, 0, (choices) => {
			assert.equal(choices[0], "( ) 1. Alpha");
			return "Done";
		}], ["custom alone"]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: [{ label: "Alpha", selected: true }] }],
		}));
		assert.equal(result.cancelled, false);
		assert.deepEqual(result.answers[0]?.entries, [
			{ value: "custom alone", label: "custom alone", custom: true },
		]);
	});

	it("edits and clears the extra answer without clearing the selected option", async () => {
		const { ui } = dialogs([0, CUSTOM, CUSTOM, CUSTOM, "Done"], ["first", "replacement", "  "]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS }],
		}));
		assert.deepEqual(result.answers[0]?.entries, [
			{ value: "Alpha", label: "Alpha", custom: false },
		]);
	});

	it("keeps multi-select validation and accepts a typed answer alongside selections", async () => {
		const { ui, notifications } = dialogs([0, "Done", CUSTOM, "Done"], ["extra"]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose two", multiple: true, min: 2, options: OPTIONS }],
		}));
		assert.deepEqual(notifications, ["Select at least 2 answers."]);
		assert.deepEqual(result.answers[0]?.entries.map((entry) => entry.value), ["Alpha", "extra"]);
	});

	it("requires an answer before Done on a required question", async () => {
		const { ui, notifications } = dialogs(["Done", 1, "Done"]);
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

	it("cancels when the custom answer dialog is dismissed", async () => {
		const { ui } = dialogs([0, CUSTOM], [undefined]);
		const result = await runFallbackSurvey(ui, normalizeQuestions({
			questions: [{ question: "Choose", options: OPTIONS }],
		}));
		assert.equal(result.cancelled, true);
	});
});
