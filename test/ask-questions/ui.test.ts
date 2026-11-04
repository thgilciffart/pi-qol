import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { type AskResult, normalizeQuestions } from "../../src/ask-questions/questions.ts";
import { createQuestionnaireComponent } from "../../src/ask-questions/ui/ask-questionnaire.ts";

function makeHost() {
	const tui = {
		requestRender: () => {},
		terminal: { rows: 40, columns: 100 },
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	return { tui, theme };
}

function mount(questions: ReturnType<typeof normalizeQuestions>) {
	const { tui, theme } = makeHost();
	let result: AskResult | undefined;
	const component = createQuestionnaireComponent(
		tui,
		theme,
		questions,
		{ submitLabel: "Submit" },
		(value) => {
			result = value;
		},
	);
	return { component, result: () => result };
}

const ENTER = "\r";
const ESCAPE = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const BACKSPACE = "\x7f";

describe("questionnaire component", () => {
	it("keeps a preselected single choice when adding a typed answer", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [{ question: "Choose one", options: [{ label: "Default", selected: true }] }],
		}));
		component.handleInput(DOWN);
		for (const character of "custom") component.handleInput(character);
		component.handleInput(ENTER);
		assert.equal(result()?.cancelled, false);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "Default", label: "Default", custom: false },
			{ value: "custom", label: "custom", custom: true },
		]);
	});

	it("clears a preset single selection without losing the typed answer", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [{ question: "Choose or type", options: [{ label: "Default", selected: true }] }],
		}));
		component.handleInput(DOWN);
		for (const character of "custom only") component.handleInput(character);
		component.handleInput(UP);
		component.handleInput(" ");
		component.handleInput(ENTER);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "custom only", label: "custom only", custom: true },
		]);
	});

	it("shows a warning when another selection would exceed max", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [{ question: "Choose one", multiple: true, max: 1,
				options: [{ label: "Alpha" }, { label: "Beta" }] }],
		}));
		component.handleInput("1");
		component.handleInput("2");
		assert.match(component.render(80).join("\n"), /Select at most 1 answer/);
		component.handleInput(ENTER);
		assert.deepEqual(result()?.answers[0]?.entries.map((entry) => entry.value), ["Alpha"]);
	});

	it("reflows cached content when the terminal width changes", () => {
		const { component } = mount(normalizeQuestions({
			questions: [{ question: "A long question that wraps onto several lines in a narrow terminal" }],
		}));
		component.render(100);
		const narrow = component.render(30);
		assert.ok(narrow.every((line) => visibleWidth(line) <= 30));
		assert.equal(visibleWidth(component.render(100)[0]!), 100);
	});

	it("renders the question and options", () => {
		const questions = normalizeQuestions({
			questions: [
				{
					id: "pick",
					label: "Pick",
					question: "Choose one",
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
			],
		});
		const { component } = mount(questions);
		const rendered = component.render(80).join("\n");
		assert.match(rendered, /Choose one/);
		assert.match(rendered, /Alpha/);
		assert.match(rendered, /Beta/);
		assert.match(rendered, /Type something/);
	});

	it("selects a single option on space and waits for Enter to confirm", () => {
		const questions = normalizeQuestions({
			questions: [
				{
					id: "pick",
					label: "Pick",
					question: "Choose one",
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
			],
		});
		const { component, result } = mount(questions);
		component.handleInput(" ");
		assert.equal(result(), undefined, "selection leaves time to add a typed answer");
		assert.match(component.render(80).join("\n"), /\(•\) 1\. Alpha/);
		component.handleInput(ENTER);
		assert.equal(result()?.cancelled, false);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "Alpha", label: "Alpha", custom: false },
		]);
	});

	it("keeps one radio selection alongside an editable extra answer", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [{ question: "Choose and type", options: [{ label: "Alpha" }, { label: "Beta" }] }],
		}));
		component.handleInput("1");
		assert.equal(result(), undefined);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		for (const character of "extra") component.handleInput(character);
		component.handleInput(UP);
		component.handleInput(" ");
		component.handleInput(DOWN);
		component.handleInput(BACKSPACE);
		component.handleInput("!");
		component.handleInput(ENTER);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "Beta", label: "Beta", custom: false },
			{ value: "extr!", label: "extr!", custom: true },
		]);
	});

	it("isolates undo history between questions", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [{ question: "First" }, { question: "Second", required: false }],
		}));
		for (const character of "first answer") component.handleInput(character);
		component.handleInput(TAB);
		component.handleInput("\x1b[45;5u"); // Ctrl+-: editor undo
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		assert.equal(result()?.answers[0]?.entries[0]?.value, "first answer");
		assert.equal(result()?.answers[1]?.skipped, true);
		assert.deepEqual(result()?.answers[1]?.entries, []);
	});

	it("confirms the selected radio option without replacing it with the cursor row", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [{ question: "Choose and type", options: [{ label: "Alpha" }, { label: "Beta" }] }],
		}));
		component.handleInput(" ");
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		for (const character of "extra") component.handleInput(character);
		component.handleInput(UP);
		component.handleInput(ENTER);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "Alpha", label: "Alpha", custom: false },
			{ value: "extra", label: "extra", custom: true },
		]);
	});

	it("selects numbered options and toggles multiple choices", () => {
		const questions = normalizeQuestions({
			questions: [
				{
					id: "pick",
					label: "Pick",
					question: "Choose some",
					multiple: true,
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
			],
		});
		const { component, result } = mount(questions);

		component.handleInput("2");
		assert.equal(result(), undefined, "multiple-choice questions wait for Enter");
		component.handleInput("a");
		component.handleInput("c");
		component.handleInput(" ");
		component.handleInput(ENTER);
		// The cursor stayed on the second option, so Space toggles Beta.
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "Beta", label: "Beta", custom: false },
		]);
	});

	it("enforces min selections before confirming", () => {
		const questions = normalizeQuestions({
			questions: [
				{
					id: "pick",
					label: "Pick",
					question: "Choose two",
					multiple: true,
					min: 2,
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
			],
		});
		const { component, result } = mount(questions);
		component.handleInput(" ");
		component.handleInput(ENTER);
		assert.equal(result(), undefined, "min selection blocks confirmation");
		component.handleInput(DOWN);
		component.handleInput(" ");
		component.handleInput(ENTER);
		assert.equal(result()?.answers[0]?.entries.length, 2);
	});

	it("walks through multiple tabs, typing, and the submit tab", () => {
		const questions = normalizeQuestions({
			questions: [
				{
					id: "pick",
					label: "Pick",
					question: "Choose some",
					multiple: true,
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
				{ id: "notes", label: "Notes", question: "Say something" },
			],
		});
		const { component, result } = mount(questions);

		assert.match(component.render(80).join("\n"), /Choose some/);
		component.handleInput(" ");
		component.handleInput(ENTER);
		assert.match(component.render(80).join("\n"), /Say something/, "advances to the next tab");

		for (const character of "hello") {
			component.handleInput(character);
		}
		component.handleInput(ENTER);
		assert.match(component.render(80).join("\n"), /Review your answers/);

		component.handleInput(ENTER);
		assert.equal(result()?.cancelled, false);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "Alpha", label: "Alpha", custom: false },
		]);
		assert.deepEqual(result()?.answers[1]?.entries, [
			{ value: "hello", label: "hello", custom: true },
		]);
	});

	it("skips optional free-form questions on empty Enter", () => {
		const questions = normalizeQuestions({
			questions: [{ id: "notes", label: "Notes", question: "Anything?", required: false }],
		});
		const { component, result } = mount(questions);
		component.handleInput(ENTER);
		assert.equal(result()?.cancelled, false);
		assert.equal(result()?.answers[0]?.skipped, true);
	});

	it("treats free-form questions as a single typed answer", () => {
		const questions = normalizeQuestions({
			questions: [{ id: "notes", label: "Notes", question: "Say something", multiple: true }],
		});
		const { component, result } = mount(questions);
		for (const character of "hello") {
			component.handleInput(character);
		}
		component.handleInput(ENTER);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "hello", label: "hello", custom: true },
		]);
	});

	it("edits a typed answer in place on an option question", () => {
		const questions = normalizeQuestions({
			questions: [
				{
					id: "pick",
					label: "Pick",
					question: "Choose and maybe type",
					multiple: true,
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
			],
		});
		const { component, result } = mount(questions);
		// Move onto the custom row: typing starts immediately, no menu to open.
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		const rendered = component.render(80).join("\n");
		assert.match(rendered, /Alpha/, "options stay visible while typing");
		assert.match(rendered, /Type something/);
		for (const character of "first") {
			component.handleInput(character);
		}
		component.handleInput(ENTER);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "first", label: "first", custom: true },
		]);
	});

	it("replaces the typed answer and combines it with options", () => {
		const questions = normalizeQuestions({
			questions: [
				{
					id: "pick",
					label: "Pick",
					question: "Choose and maybe type",
					multiple: true,
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
			],
		});
		const { component, result } = mount(questions);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		for (const character of "one") {
			component.handleInput(character);
		}
		component.handleInput(UP);
		component.handleInput(UP);
		component.handleInput(" ");
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(BACKSPACE);
		component.handleInput(BACKSPACE);
		component.handleInput(BACKSPACE);
		for (const character of "two") {
			component.handleInput(character);
		}
		component.handleInput(ENTER);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "Alpha", label: "Alpha", custom: false },
			{ value: "two", label: "two", custom: true },
		]);
	});

	it("keeps the full pasted custom answer alongside selected options", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [{ question: "Choose and type", multiple: true, options: [{ label: "Alpha" }] }],
		}));
		const text = "x".repeat(1001);
		component.handleInput(" ");
		component.handleInput(DOWN);
		component.handleInput(`\x1b[200~${text}\x1b[201~`);
		component.handleInput(ENTER);
		assert.deepEqual(result()?.answers[0]?.entries, [
			{ value: "Alpha", label: "Alpha", custom: false },
			{ value: text, label: text, custom: true },
		]);
	});

	it("keeps expanded pasted answers when submitting through the review tab", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [
				{ question: "Type a note" },
				{ question: "Choose and type", multiple: true, options: [{ label: "Alpha" }] },
			],
		}));
		const text = Array.from({ length: 12 }, (_, index) => `Line ${index}`).join("\n");
		component.handleInput(`\x1b[200~${text}\x1b[201~`);
		component.handleInput(TAB);
		component.handleInput(" ");
		component.handleInput(DOWN);
		component.handleInput(`\x1b[200~${text}\x1b[201~`);
		component.handleInput(TAB);
		component.handleInput(ENTER);
		assert.equal(result()?.answers[0]?.entries[0]?.value, text);
		assert.equal(result()?.answers[1]?.entries[1]?.value, text);
	});

	it("inserts a newline in a custom answer with backslash Enter", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [{ question: "Choose or type", options: [{ label: "Alpha" }] }],
		}));
		component.handleInput(DOWN);
		for (const character of "first\\") component.handleInput(character);
		component.handleInput(ENTER);
		assert.equal(result(), undefined, "newline must not submit the question");
		for (const character of "second") component.handleInput(character);
		component.handleInput(ENTER);
		assert.equal(result()?.answers[0]?.entries[0]?.value, "first\nsecond");
	});

	it("keeps a custom answer editable after validation fails", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [{ question: "Choose two", multiple: true, min: 2, options: [{ label: "Alpha" }] }],
		}));
		component.handleInput(DOWN);
		for (const character of "custom") component.handleInput(character);
		component.handleInput(ENTER);
		assert.equal(result(), undefined);
		assert.match(component.render(80).join("\n"), /Select at least 2 answers/);
		component.handleInput(BACKSPACE);
		component.handleInput("!");
		component.handleInput(UP);
		component.handleInput(" ");
		component.handleInput(ENTER);
		assert.equal(result()?.answers[0]?.entries.find((entry) => entry.custom)?.value, "custo!");
	});

	it("arms cancellation on the first Escape and cancels on the second", () => {
		const questions = normalizeQuestions({
			questions: [{ id: "pick", label: "Pick", question: "Choose one", options: [{ label: "A" }] }],
		});
		const { component, result } = mount(questions);
		component.handleInput(ESCAPE);
		assert.equal(result(), undefined);
		assert.match(component.render(80).join("\n"), /Press Esc again/);
		component.handleInput(ESCAPE);
		assert.equal(result()?.cancelled, true);
	});

	it("switches tabs with Tab", () => {
		const questions = normalizeQuestions({
			questions: [
				{ id: "one", label: "One", question: "First question" },
				{ id: "two", label: "Two", question: "Second question" },
			],
		});
		const { component } = mount(questions);
		assert.match(component.render(80).join("\n"), /First question/);
		component.handleInput(TAB);
		assert.match(component.render(80).join("\n"), /Second question/);
		component.handleInput(TAB);
		assert.match(component.render(80).join("\n"), /Review your answers/);
	});

	it("restores the custom row and unfinished spaces after switching tabs", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [
				{ question: "Choose and type", options: [{ label: "Alpha" }] },
				{ question: "Optional note", required: false },
			],
		}));
		component.handleInput(" ");
		component.handleInput(DOWN);
		for (const character of "hello ") component.handleInput(character);
		component.handleInput(TAB);
		component.handleInput(SHIFT_TAB);
		for (const character of "world") component.handleInput(character);
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		assert.equal(result()?.answers[0]?.entries[1]?.value, "hello world");
	});

	it("restores the text caret after switching tabs", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [{ question: "Note" }, { question: "Another note", required: false }],
		}));
		for (const character of "hello world") component.handleInput(character);
		for (let index = 0; index < 5; index += 1) component.handleInput("\x1b[D");
		component.handleInput(TAB);
		component.handleInput(SHIFT_TAB);
		for (const character of "small ") component.handleInput(character);
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		assert.equal(result()?.answers[0]?.entries[0]?.value, "hello small world");
	});

	it("edits multiline custom answers with arrow keys before leaving the editor", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [{ question: "Choose or type", options: [{ label: "Alpha" }] }],
		}));
		component.handleInput(DOWN);
		component.handleInput("\x1b[200~first\nsecond\x1b[201~");
		component.handleInput(UP);
		component.handleInput("\x1b[H");
		component.handleInput("[");
		component.handleInput(DOWN);
		component.handleInput("\x1b[F");
		component.handleInput("]");
		component.handleInput(ENTER);
		assert.equal(result()?.answers[0]?.entries[0]?.value, "[first\nsecond]");
	});

	it("pages through long option lists and keeps the target visible", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [{ question: "Choose", allowOther: false,
				options: Array.from({ length: 20 }, (_, index) => ({ label: `Option ${index + 1}` })) }],
		}));
		component.handleInput("\x1b[6~");
		component.handleInput("\x1b[6~");
		assert.match(component.render(80).join("\n"), /Option 17/);
		component.handleInput("\x1b[5~");
		component.handleInput(ENTER);
		assert.equal(result()?.answers[0]?.entries[0]?.value, "Option 9");
	});

	it("shows progress, selection counts, and specific errors without hiding answers", () => {
		const { component } = mount(normalizeQuestions({
			questions: [
				{ question: "Choose two", multiple: true, min: 2, options: [{ label: "Alpha" }, { label: "Beta" }] },
				{ question: "Optional note", required: false },
			],
		}));
		component.handleInput(" ");
		assert.match(component.render(80).join("\n"), /1 answer selected/);
		assert.match(component.render(80).join("\n"), /1 of 2 questions ready/);
		component.handleInput(TAB);
		assert.match(component.render(80).join("\n"), /Optional • leave empty to skip/);
		component.handleInput(TAB);
		const review = component.render(80).join("\n");
		assert.match(review, /Alpha/);
		assert.match(review, /Select at least 2 answers/);
		assert.match(review, /1 question needs attention/);
	});

	it("clears validation feedback when the typed answer becomes valid", () => {
		const { component } = mount(normalizeQuestions({ questions: [{ question: "Type a note" }] }));
		component.handleInput(ENTER);
		assert.match(component.render(80).join("\n"), /This question needs an answer/);
		component.handleInput("x");
		assert.doesNotMatch(component.render(80).join("\n"), /This question needs an answer/);
	});

	it("does not carry a validation warning onto the next question", () => {
		const { component } = mount(normalizeQuestions({
			questions: [
				{ question: "Choose", multiple: true, max: 1, options: [{ label: "Alpha" }, { label: "Beta" }] },
				{ question: "Note" },
			],
		}));
		component.handleInput("1");
		component.handleInput("2");
		component.handleInput(ENTER);
		assert.doesNotMatch(component.render(80).join("\n"), /Select at most 1 answer/);
	});

	it("does not restore a discarded draft after skipping a question", () => {
		const { component, result } = mount(normalizeQuestions({
			questions: [
				{ question: "Choose or skip", required: false, options: [{ label: "Alpha" }] },
				{ question: "Note", required: false },
			],
		}));
		component.handleInput(DOWN);
		for (const character of "discard") component.handleInput(character);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		component.handleInput(SHIFT_TAB);
		component.handleInput(UP);
		for (const character of "fresh") component.handleInput(character);
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		assert.equal(result()?.answers[0]?.entries[0]?.value, "fresh");
	});

	it("handles an already aborted signal and ignores input after disposal", () => {
		const { tui, theme } = makeHost();
		const questions = normalizeQuestions({ questions: [{ question: "Note" }] });
		const controller = new AbortController();
		controller.abort();
		const results: AskResult[] = [];
		const component = createQuestionnaireComponent(tui, theme, questions,
			{ submitLabel: "Submit", signal: controller.signal }, (result) => { results.push(result); });
		assert.equal(results.length, 1);
		assert.equal(results[0]?.cancelled, true);
		component.handleInput("x");
		component.handleInput(ENTER);
		assert.equal(results.length, 1);
		const mounted = mount(questions);
		mounted.component.dispose();
		mounted.component.handleInput("x");
		mounted.component.handleInput(ENTER);
		assert.equal(mounted.result(), undefined);
	});

	it("cancels through the abort signal", () => {
		const questions = normalizeQuestions({
			questions: [{ id: "pick", label: "Pick", question: "Choose one", options: [{ label: "A" }] }],
		});
		const controller = new AbortController();
		const { tui, theme } = makeHost();
		let result: AskResult | undefined;
		createQuestionnaireComponent(
			tui,
			theme,
			questions,
			{ submitLabel: "Submit", signal: controller.signal },
			(value) => {
				result = value;
			},
		);
		controller.abort();
		assert.equal(result?.cancelled, true);
	});
});
