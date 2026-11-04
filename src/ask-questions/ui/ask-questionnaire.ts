/**
 * Interactive questionnaire component for the `ask_user` tool.
 *
 * Layout (multiple questions):
 *
 *   ─────────────────────────────────────────────
 *    Title
 *    Scope  Release  Notes  [ Submit ]
 *
 *    The question text
 *    Optional header / hints
 *
 *    ❯ [x] 1. Option label
 *          description
 *      [ ] 2. Another option
 *      Type something…
 *      (inline editor for the typed answer, no separate menu)
 *      Skip this question
 *
 *    ↑↓ move • Space toggle • Enter confirm • Esc cancel
 *   ─────────────────────────────────────────────
 *
 * Keyboard contract:
 * - Tab / Shift+Tab switch tabs.
 * - ↑/↓ move the cursor; Home/End jump to the first/last row.
 * - PageUp/PageDown move through long option lists.
 * - Space selects or toggles an option; Enter confirms the question.
 * - 1-9 jumps to an option and toggles it without confirming the question.
 * - A selects all options, C clears the selection (multiple-choice only).
 * - Moving the cursor onto "Type something…" starts editing immediately;
 *   the inline editor is always there, no separate menu.
 * - Esc arms cancellation; Esc twice cancels. Ctrl+C cancels immediately.
 *
 * Answer operations live in `state.ts` and drawing in `render.ts`; this file
 * owns the cursor, tabs, editors, and key handling.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	Key,
	type Component,
	type EditorTheme,
	type TUI,
	decodeKittyPrintable,
	matchesKey,
} from "@earendil-works/pi-tui";
import {
	type AskResult,
	type NormalizedQuestion,
	type QuestionAnswer,
	answerError,
	buildResult,
	collectAnswerErrors,
	makeAnswer,
} from "../questions.ts";
import { MAX_VISIBLE_ROWS, type Notice, renderQuestionnaire } from "./render.ts";
import {
	initialAnswers,
	initialCursor,
	isOptionSelected,
	optionEntry,
	rowsFor,
	selectAll,
	toggleMultiple,
	toggleSingle,
	typedValue,
	withEntries,
	withTypedText,
} from "./state.ts";

export interface QuestionnaireOptions {
	title?: string;
	submitLabel: string;
	signal?: AbortSignal;
}

export interface RunQuestionnaireOptions extends QuestionnaireOptions {
	/**
	 * Called when another component takes over the editor slot (for example
	 * another extension's dialog) before the user answered. The questionnaire
	 * then resolves as cancelled.
	 */
	onDisplaced?: () => void;
}

/** The subset of a Pi extension context the questionnaire needs. */
export type QuestionnaireContext = Pick<ExtensionContext, "ui" | "mode" | "hasUI">;

type QuestionnaireComponent = Component & { focused: boolean; handleInput(data: string): void; dispose(): void };

/**
 * Run the questionnaire and resolve with the user's answers.
 *
 * Pi shows custom components in the editor slot, and a later dialog replaces
 * whatever is there without closing it. When that happens the questionnaire
 * resolves as cancelled right away. Closing Pi's prompt is deferred until
 * focus is back on the editor, because closing restores the editor slot and
 * would otherwise remove the dialog that replaced us.
 */
export function runQuestionnaire(
	ctx: QuestionnaireContext,
	questions: NormalizedQuestion[],
	options: RunQuestionnaireOptions,
): Promise<AskResult> {
	const cancelled = (): AskResult => buildResult(questions, new Map(), true);
	if (options.signal?.aborted) {
		return Promise.resolve(cancelled());
	}
	const displacement = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, displacement.signal]) : displacement.signal;

	return new Promise<AskResult>((resolve, reject) => {
		const onAbort = (): void => resolve(cancelled());
		signal.addEventListener("abort", onAbort, { once: true });
		const settle = (result: AskResult): void => {
			signal.removeEventListener("abort", onAbort);
			resolve(result);
		};

		ctx.ui.custom<AskResult>((tui, theme, _keybindings, close) => {
			const editorFocus = focusedComponent(tui);
			let answered = false;
			let displaced = false;
			const component = createQuestionnaireComponent(tui, theme, questions, { ...options, signal }, (result) => {
				answered = true;
				settle(result);
				if (displaced) {
					closeWhenFocused(tui, editorFocus, () => close(result));
				} else {
					close(result);
				}
			});
			const host: QuestionnaireComponent = {
				get focused() {
					return component.focused;
				},
				set focused(value: boolean) {
					component.focused = value;
					// Losing focus while still mounted means an overlay opened above us.
					if (!value && !answered && !displaced && !isMounted(tui, host)) {
						displaced = true;
						options.onDisplaced?.();
						displacement.abort();
					}
				},
				render: (width) => component.render(width),
				handleInput: (data) => component.handleInput(data),
				invalidate: () => component.invalidate(),
				dispose: () => component.dispose(),
			};
			return host;
		}).then(settle, (error: unknown) => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		});
	});
}

function focusedComponent(tui: TUI): Component | null | undefined {
	return (tui as Partial<{ getFocusedComponent(): Component | null }>).getFocusedComponent?.();
}

function isMounted(tui: TUI, target: Component): boolean {
	if (!Array.isArray(tui.children)) {
		return true;
	}
	const contains = (node: Component): boolean => {
		if (node === target) {
			return true;
		}
		const children = (node as { children?: unknown }).children;
		return Array.isArray(children) && children.some(contains);
	};
	return tui.children.some(contains);
}

/** Run `close` on the first key press once `target` has focus again. */
function closeWhenFocused(tui: TUI, target: Component | null | undefined, close: () => void): void {
	if (!target) {
		return;
	}
	const stop = tui.addInputListener(() => {
		if (focusedComponent(tui) === target) {
			stop();
			close();
		}
		return undefined;
	});
}

/** Build the questionnaire component. Exported for tests and reuse. */
export function createQuestionnaireComponent(
	tui: TUI,
	theme: Theme,
	questions: NormalizedQuestion[],
	options: QuestionnaireOptions,
	done: (result: AskResult) => void,
): QuestionnaireComponent {
	const showTabs = questions.length > 1;
	const reviewTab = questions.length;

	const answers = initialAnswers(questions);
	// Each question keeps its own editor (raw draft, caret, undo history) and
	// cursor row, keyed by question; `undefined` is the review tab.
	const editors = new Map<NormalizedQuestion | undefined, Editor>();
	const cursors = new Map<NormalizedQuestion | undefined, number>();

	let tab = 0;
	let cursor = 0;
	let submitCursor = questions.length;
	let cancelArmed = false;
	let notice: Notice | undefined;
	let editor: Editor;
	let editorQuestion: NormalizedQuestion | undefined;
	let editorText = "";
	let cachedLines: string[] | undefined;
	let cachedWidth: number | undefined;
	let finished = false;
	let componentFocused = false;
	let suppressEditorEvents = false;

	// ── State access ─────────────────────────────────────────────────────

	const currentQuestion = (): NormalizedQuestion | undefined => questions[tab];
	const answerOf = (question: NormalizedQuestion): QuestionAnswer =>
		answers.get(question.id) ?? makeAnswer(question, []);
	const setAnswer = (question: NormalizedQuestion, answer: QuestionAnswer): void => {
		answers.set(question.id, answer);
	};
	const onCustomRow = (question: NormalizedQuestion): boolean => rowsFor(question)[cursor]?.kind === "custom";

	/** True when keystrokes belong in the editor (free-form or custom row). */
	function isEditorActive(): boolean {
		const question = currentQuestion();
		return question !== undefined && (question.options.length === 0 || onCustomRow(question));
	}

	// ── Redraw, notices, cursor ──────────────────────────────────────────

	function redraw(): void {
		cachedLines = undefined;
		tui.requestRender();
	}

	function warn(text: string): void {
		notice = { text, kind: "warning" };
		redraw();
	}

	/** Validate the current answer, then move on or explain what is missing. */
	function confirmQuestion(question: NormalizedQuestion): void {
		const error = answerError(question, answers.get(question.id));
		if (error) {
			warn(error);
		} else {
			advance();
		}
	}

	function syncEditorFocus(): void {
		editor.focused = componentFocused && isEditorActive();
	}

	function placeCursor(index: number): void {
		cursor = index;
		syncEditorFocus();
	}

	function moveCursorTo(index: number): void {
		placeCursor(index);
		redraw();
	}

	// ── Editor ───────────────────────────────────────────────────────────

	function setText(text: string): void {
		suppressEditorEvents = true;
		editor.setText(text);
		editorText = editor.getText();
		suppressEditorEvents = false;
	}

	/** Mirror the editor into the free-form answer or the custom row's typed answer. */
	function applyEditorText(value: string): void {
		const question = currentQuestion();
		if (question && (question.options.length === 0 || onCustomRow(question))) {
			setAnswer(question, withTypedText(question, answerOf(question), value));
		}
	}

	const editorTheme: EditorTheme = {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};

	function createEditor(): Editor {
		const questionEditor = new Editor(tui, editorTheme);
		questionEditor.onChange = (value) => {
			editorText = value;
			if (!suppressEditorEvents) {
				applyEditorText(questionEditor.getExpandedText());
				const question = currentQuestion();
				if (question && !answerError(question, answers.get(question.id))) {
					notice = undefined;
				}
			}
			cachedLines = undefined;
		};
		questionEditor.onSubmit = (value) => {
			const question = currentQuestion();
			if (!question) {
				return;
			}
			// Submission clears the editor first. Restore the submitted text so a
			// validation error leaves the answer available for further editing.
			setText(value);
			applyEditorText(value);
			confirmQuestion(question);
		};
		return questionEditor;
	}

	/** Swap in the editor and cursor of `question`, saving the current ones. */
	function loadQuestion(question: NormalizedQuestion | undefined): void {
		if (editor) {
			cursors.set(editorQuestion, cursor);
			editor.focused = false;
		}
		const visited = cursors.has(question);
		let nextEditor = editors.get(question);
		if (!nextEditor) {
			nextEditor = createEditor();
			editors.set(question, nextEditor);
		}
		editor = nextEditor;
		editorQuestion = question;
		cursor = cursors.get(question) ?? initialCursor(question);
		// A visited editor already holds the raw draft and caret. Loading the
		// trimmed answer again would drop trailing spaces and reset the caret.
		if (visited) {
			editorText = editor.getText();
		} else {
			setText(question ? (typedValue(answerOf(question)) ?? "") : "");
		}
		syncEditorFocus();
	}

	// ── Tabs ─────────────────────────────────────────────────────────────

	function showTab(index: number): void {
		tab = index;
		cancelArmed = false;
		notice = undefined;
		loadQuestion(questions[tab]);
		redraw();
	}

	function goTab(delta: number): void {
		if (!showTabs) {
			return;
		}
		const total = questions.length + 1;
		const next = (tab + delta + total) % total;
		if (next === reviewTab) {
			submitCursor = reviewTab;
		}
		showTab(next);
	}

	function advance(): void {
		if (questions.length === 1) {
			finish(false);
			return;
		}
		showTab(tab < questions.length - 1 ? tab + 1 : reviewTab);
	}

	// ── Actions ──────────────────────────────────────────────────────────

	function finish(cancelled: boolean): void {
		if (finished) {
			return;
		}
		if (!cancelled) {
			const [first] = collectAnswerErrors(questions, answers);
			if (first) {
				showTab(Math.max(0, questions.findIndex((question) => question.id === first.id)));
				notice = { text: `${first.label}: ${first.message}`, kind: "error" };
				return;
			}
		}
		finished = true;
		options.signal?.removeEventListener("abort", onAbort);
		done(buildResult(questions, answers, cancelled));
	}

	/** Space (`toggle`) or Enter on the cursor row. */
	function activateRow(question: NormalizedQuestion, toggle: boolean): void {
		const row = rowsFor(question)[cursor];
		if (!row) {
			return;
		}
		if (row.kind === "custom") {
			// The custom row is edited in place; Enter confirms the question.
			confirmQuestion(question);
			return;
		}
		if (row.kind === "skip") {
			setAnswer(question, makeAnswer(question, [], true));
			setText("");
			advance();
			return;
		}
		if (toggle) {
			notice = undefined;
			if (question.multiple) {
				const { answer, full } = toggleMultiple(question, answerOf(question), row.option);
				setAnswer(question, answer);
				if (full) {
					warn(`Select at most ${question.max} ${question.max === 1 ? "answer" : "answers"}.`);
					return;
				}
			} else {
				setAnswer(question, toggleSingle(question, answerOf(question), row.option));
			}
			redraw();
			return;
		}
		if (question.multiple) {
			confirmQuestion(question);
			return;
		}
		// Enter on a single-choice row picks it only when nothing is chosen yet.
		if (answerOf(question).entries.length === 0) {
			setAnswer(question, withEntries(question, [optionEntry(row.option)]));
		}
		advance();
	}

	// ── Input handling ───────────────────────────────────────────────────

	function handleReviewTab(data: string): void {
		const total = questions.length + 1;
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			goTab(1);
		} else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			goTab(-1);
		} else if (matchesKey(data, Key.up)) {
			submitCursor = (submitCursor - 1 + total) % total;
			redraw();
		} else if (matchesKey(data, Key.down)) {
			submitCursor = (submitCursor + 1) % total;
			redraw();
		} else if (matchesKey(data, Key.home)) {
			submitCursor = 0;
			redraw();
		} else if (matchesKey(data, Key.end)) {
			submitCursor = questions.length;
			redraw();
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			if (submitCursor < questions.length) {
				showTab(submitCursor);
			} else {
				finish(false);
			}
		}
	}

	function stepCursor(question: NormalizedQuestion, delta: number): void {
		const count = rowsFor(question).length;
		if (count > 0) {
			moveCursorTo((cursor + delta + count) % count);
		}
	}

	function handleCustomRow(question: NormalizedQuestion, data: string): void {
		// Leave the editor from its first/last line so single-line answers keep
		// quick row navigation and multiline answers can still use the arrows.
		if (matchesKey(data, Key.up) && editor.getCursor().line === 0) {
			stepCursor(question, -1);
		} else if (matchesKey(data, Key.down) && editor.getCursor().line === editor.getLines().length - 1) {
			stepCursor(question, 1);
		} else {
			// The editor handles submission, paste expansion, and newline shortcuts.
			editor.handleInput(data);
			redraw();
		}
	}

	/** Returns true when `data` was a navigation key. */
	function handleRowNavigation(question: NormalizedQuestion, data: string): boolean {
		const last = rowsFor(question).length - 1;
		if (last < 0) {
			return false;
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			const delta = matchesKey(data, Key.pageUp) ? -MAX_VISIBLE_ROWS : MAX_VISIBLE_ROWS;
			moveCursorTo(Math.max(0, Math.min(last, cursor + delta)));
		} else if (matchesKey(data, Key.up)) {
			stepCursor(question, -1);
		} else if (matchesKey(data, Key.down)) {
			stepCursor(question, 1);
		} else if (matchesKey(data, Key.home)) {
			moveCursorTo(0);
		} else if (matchesKey(data, Key.end)) {
			moveCursorTo(last);
		} else {
			return false;
		}
		return true;
	}

	function handleOptionRows(question: NormalizedQuestion, data: string): void {
		if (matchesKey(data, Key.right)) {
			goTab(1);
			return;
		}
		if (matchesKey(data, Key.left)) {
			goTab(-1);
			return;
		}
		if (handleRowNavigation(question, data)) {
			return;
		}
		if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
			activateRow(question, matchesKey(data, Key.space));
			return;
		}

		const printable = printableKey(data);
		if (printable === undefined) {
			return;
		}
		const lower = printable.toLowerCase();
		if (question.multiple && lower === "a") {
			setAnswer(question, selectAll(question, answerOf(question)));
			notice = undefined;
			redraw();
			return;
		}
		if (question.multiple && lower === "c") {
			setAnswer(question, withEntries(question, []));
			setText("");
			notice = undefined;
			redraw();
			return;
		}
		const digit = Number.parseInt(printable, 10);
		if (digit >= 1 && digit <= 9) {
			const index = rowsFor(question).findIndex((row) => row.kind === "option" && row.index === digit - 1);
			if (index >= 0) {
				placeCursor(index);
				activateRow(question, true);
			}
		}
	}

	function handleInput(data: string): void {
		if (finished) {
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			finish(true);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (cancelArmed) {
				finish(true);
			} else {
				cancelArmed = true;
				warn("Press Esc again to cancel.");
			}
			return;
		}
		if (cancelArmed) {
			cancelArmed = false;
			notice = undefined;
			redraw();
		}

		if (showTabs && matchesKey(data, Key.tab)) {
			goTab(1);
			return;
		}
		if (showTabs && matchesKey(data, Key.shift("tab"))) {
			goTab(-1);
			return;
		}
		if (showTabs && tab === reviewTab) {
			handleReviewTab(data);
			return;
		}
		const question = currentQuestion();
		if (!question) {
			return;
		}
		if (question.options.length === 0) {
			editor.handleInput(data);
			redraw();
		} else if (onCustomRow(question)) {
			handleCustomRow(question, data);
		} else {
			handleOptionRows(question, data);
		}
	}

	// ── Rendering ────────────────────────────────────────────────────────

	function render(width: number): string[] {
		if (cachedLines && cachedWidth === width) {
			return cachedLines;
		}
		cachedLines = renderQuestionnaire(theme, {
			title: options.title,
			submitLabel: options.submitLabel,
			questions,
			answers,
			tab,
			cursor,
			submitCursor,
			notice,
			editor,
			draftEmpty: editorText.length === 0,
		}, width);
		cachedWidth = width;
		return cachedLines;
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	loadQuestion(questions[0]);

	const onAbort = (): void => finish(true);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) {
		onAbort();
	}

	return {
		get focused(): boolean {
			return componentFocused;
		},
		set focused(value: boolean) {
			if (componentFocused === value) {
				return;
			}
			componentFocused = value;
			syncEditorFocus();
			redraw();
		},
		render,
		handleInput,
		invalidate: () => {
			cachedLines = undefined;
		},
		dispose: () => {
			finished = true;
			editor.focused = false;
			options.signal?.removeEventListener("abort", onAbort);
		},
	};
}

/** Extract a printable character from raw input, including Kitty CSI-u keys. */
function printableKey(data: string): string | undefined {
	return data.length === 1 ? data : decodeKittyPrintable(data);
}
