import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { ExtensionAPI, ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { AskResult } from "../../src/ask-questions/questions.ts";
import extension from "../../src/ask-questions/extension.ts";

/** Register the extension against a minimal fake API and capture definitions. */
function loadExtension() {
	let tool: any;
	const commands: Array<{ name: string; description?: string; handler: any }> = [];
	const messages: Array<{ message: any; options: any }> = [];
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const pi = {
		registerTool: (definition: unknown) => {
			tool = definition;
		},
		registerCommand: (name: string, definition: { description?: string; handler?: any }) => {
			commands.push({ name, description: definition.description, handler: definition.handler });
		},
		on: (event: string, handler: (...args: any[]) => any) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		sendMessage: (message: unknown, options?: unknown) => {
			messages.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	const emit = (event: string, payload: unknown = { type: event }, ctx?: unknown) => {
		for (const handler of handlers.get(event) ?? []) {
			handler(payload, ctx);
		}
	};
	return { tool, commands, messages, handlers, emit };
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_color: string, text: string) => text,
} as unknown as Theme;

describe("extension registration", () => {
	it("registers the ask_user tool without a demo command", () => {
		const { tool, commands } = loadExtension();
		assert.equal(tool.name, "ask_user");
		assert.equal(tool.executionMode, "sequential");
		assert.ok(tool.parameters);
		assert.ok(tool.outputSchema);
		assert.ok(tool.annotations?.readOnlyHint);
		assert.deepEqual(
			commands.map((command) => command.name),
			[],
		);
	});

	it("renders the tool call header", () => {
		const { tool } = loadExtension();
		const component = tool.renderCall(
			{ questions: [{ id: "scope", label: "Scope", question: "Pick one" }] },
			theme,
			{},
		);
		const rendered = component.render(80).join("\n");
		assert.match(rendered, /ask_user/);
		assert.match(rendered, /Scope/);
	});
});

describe("ask_user execution", () => {
	it("returns an error with the questions when no UI exists", async () => {
		const { tool } = loadExtension();
		const ctx = {
			mode: "print",
			hasUI: false,
			ui: {},
		} as unknown as ExtensionToolContext;
		const result = await tool.execute(
			"call-1",
			{ questions: [{ id: "scope", question: "Which scope? Costs $& or $1", options: [{ label: "All" }] }] },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Interactive UI is not available/);
		assert.ok(result.content[0].text.includes("1. Which scope? Costs $& or $1"), "$ sequences stay literal");
		assert.equal(result.details.cancelled, true);
	});

	it("uses dialog fallbacks in RPC mode and returns structured answers", async () => {
		const { tool } = loadExtension();
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async () => undefined,
				input: async () => "hello world",
				notify: () => {},
			},
		} as unknown as ExtensionToolContext;
		const result = await tool.execute(
			"call-2",
			{
				questions: [
					{ id: "notes", label: "Notes", question: "Say something", placeholder: "Type here" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.isError, undefined);
		assert.equal(result.details.cancelled, false);
		assert.match(result.content[0].text, /Notes: typed "hello world"/);
		assert.deepEqual(result.structuredContent, {
			cancelled: false,
			pending: false,
			answers: [
				{
					id: "notes",
					question: "Say something",
					skipped: false,
					answers: [{ value: "hello world", label: "hello world", custom: true }],
				},
			],
		});
	});

	it("cancels in RPC mode when a dialog is dismissed", async () => {
		const { tool } = loadExtension();
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async () => "All",
				input: async () => undefined,
				notify: () => {},
			},
		} as unknown as ExtensionToolContext;
		const result = await tool.execute(
			"call-3",
			{ questions: [{ id: "typed", label: "Typed", question: "Type it" }] },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.details.cancelled, true);
		assert.match(result.content[0].text, /cancelled/i);
	});
});

describe("ask_user modes", () => {
	function tuiContext(sessionId?: string): { ctx: ExtensionToolContext; resolve: () => void; setSessionId: (next: string) => void } {
		let resolveCustom: ((result: AskResult) => void) | undefined;
		let currentSessionId = sessionId;
		const ctx = {
			mode: "tui",
			hasUI: true,
			sessionManager: {
				getSessionId: () => currentSessionId,
			},
			ui: {
				custom: () =>
					new Promise<AskResult>((resolve) => {
						resolveCustom = resolve;
					}),
			},
		} as unknown as ExtensionToolContext;
		return {
			ctx,
			setSessionId: (next: string) => {
				currentSessionId = next;
			},
			resolve: () => {
				resolveCustom?.({
					cancelled: false,
					answers: [
						{
							id: "pick",
							label: "Pick",
							question: "Choose",
							entries: [{ value: "A", label: "A", custom: false }],
							skipped: false,
						},
					],
				});
			},
		};
	}

	for (const modeParams of [{}, { mode: "background" }, { noWait: true }, { mode: "background", noWait: false }]) {
		it(`returns immediately and steers with answers for ${JSON.stringify(modeParams)}`, async () => {
			const { tool, messages } = loadExtension();
			const host = tuiContext();
			const result = await tool.execute(
				"call-bg",
				{
					...modeParams,
					questions: [
						{ id: "pick", label: "Pick", question: "Choose", options: [{ label: "A" }] },
					],
				},
				undefined,
				undefined,
				host.ctx,
			);
			assert.equal(result.isError, undefined);
			assert.equal(result.details.pending, true);
			assert.equal(result.structuredContent.pending, true);
			assert.deepEqual(result.structuredContent.answers, [
				{ id: "pick", question: "Choose", skipped: false, answers: [] },
			]);
			assert.equal(messages.length, 0, "nothing is sent while the question is open");

			host.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(messages.length, 1);
			assert.match(messages[0]!.message.content, /Pick: selected "A"/);
			assert.deepEqual(messages[0]!.options, { triggerTurn: true, deliverAs: "steer" });
		});

	}

	for (const modeParams of [{ mode: "urgent" }, { noWait: false }, { mode: "urgent", noWait: true }]) {
		it(`blocks until the user answers for ${JSON.stringify(modeParams)}`, async () => {
			const { tool, messages } = loadExtension();
			const host = tuiContext();
			let completed = false;
			const execution = tool.execute("call-urgent", {
				...modeParams,
				questions: [{ id: "pick", label: "Pick", question: "Choose", options: [{ label: "A" }] }],
			}, undefined, undefined, host.ctx).then((result: any) => {
				completed = true;
				return result;
			});
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(completed, false, "tool must remain blocked while input is pending");
			host.resolve();
			const result = await execution;
			assert.equal(result.details.cancelled, false);
			assert.equal(result.structuredContent.pending, false);
			assert.match(result.content[0].text, /Pick: selected "A"/);
			assert.equal(messages.length, 0, "urgent answers are returned directly");
		});
	}

	it("rejects a second background questionnaire while one is open", async () => {
		const { tool, messages } = loadExtension();
		const host = tuiContext();
		const params = {
			noWait: true,
			questions: [{ id: "pick", label: "Pick", question: "Choose", options: [{ label: "A" }] }],
		};
		await tool.execute("call-bg-1", params, undefined, undefined, host.ctx);
		const second = await tool.execute("call-bg-2", params, undefined, undefined, host.ctx);
		assert.equal(second.isError, true);
		assert.match(second.content[0].text, /already open/);
		host.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(messages.length, 1, "the first questionnaire still delivers");
	});

	it("surfaces a failed background questionnaire and releases the slot", async () => {
		const { tool, messages } = loadExtension();
		const notifications: Array<{ message: string; type?: string }> = [];
		const failingCtx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: () => Promise.reject(new Error("render exploded")),
				notify: (message: string, type?: string) => {
					notifications.push({ message, type });
				},
			},
		} as unknown as ExtensionToolContext;
		const params = {
			noWait: true,
			questions: [{ id: "pick", label: "Pick", question: "Choose", options: [{ label: "A" }] }],
		};
		const failed = await tool.execute("call-bg-fail", params, undefined, undefined, failingCtx);
		assert.equal(failed.details.pending, true);
		assert.equal(messages.length, 0, "a failed questionnaire delivers nothing");

		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.message, /could not show the background questionnaire/);
		assert.match(notifications[0]!.message, /render exploded/);
		assert.equal(notifications[0]!.type, "error");

		// The failed slot is released, so a later background call can still open.
		const host = tuiContext();
		const retry = await tool.execute("call-bg-retry", params, undefined, undefined, host.ctx);
		assert.equal(retry.details.pending, true);
		host.resolve();
	});

	it("cancels background questionnaires on session_shutdown and session_start without leaking answers", async () => {
		for (const lifecycleEvent of ["session_shutdown", "session_start"] as const) {
			const { tool, messages, emit } = loadExtension();
			let mountedResult: AskResult | undefined;
			const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
			const realMountCtx = {
				mode: "tui",
				hasUI: true,
				sessionManager: { getSessionId: () => "session-1" },
				ui: {
					custom: (factory: any) =>
						new Promise<AskResult>((resolve) => {
							factory(tui, theme, {}, (result: AskResult) => {
								mountedResult = result;
								resolve(result);
							});
						}),
				},
			} as unknown as ExtensionToolContext;

			const params = {
				mode: "background" as const,
				questions: [{ id: "pick", label: "Pick", question: "Choose", options: [{ label: "A" }] }],
			};
			const first = await tool.execute("call-bg-lifecycle", params, undefined, undefined, realMountCtx);
			assert.equal(first.details.pending, true);

			const nextHost = tuiContext("session-2");
			emit(lifecycleEvent, { type: lifecycleEvent }, nextHost.ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));

			assert.equal(mountedResult?.cancelled, true, `${lifecycleEvent} must abort the open component`);
			assert.equal(messages.length, 0, `${lifecycleEvent} must prevent steering answers into the parent session`);

			if (lifecycleEvent === "session_shutdown") {
				emit("session_start", { type: "session_start", reason: "new" }, nextHost.ctx);
			}
			const second = await tool.execute("call-bg-next", params, undefined, undefined, nextHost.ctx);
			assert.equal(second.isError, undefined, `a new session after ${lifecycleEvent} can open a background survey`);
			nextHost.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(messages.length, 1);
		}
	});

	it("closes the background questionnaire before an urgent one and tells the agent", async () => {
		const { tool, messages } = loadExtension();
		const host = tuiContext();
		const question = { id: "pick", label: "Pick", question: "Choose", options: [{ label: "A" }] };
		await tool.execute("call-bg", { questions: [question] }, undefined, undefined, host.ctx);

		const urgent = tool.execute("call-urgent", { mode: "urgent", questions: [question] }, undefined, undefined, host.ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(messages.length, 1, "the replaced background questionnaire reports back");
		assert.match(messages[0]!.message.content, /urgent questionnaire replaced it/);
		assert.equal(messages[0]!.message.details.cancelled, true);
		assert.deepEqual(messages[0]!.options, { triggerTurn: true, deliverAs: "steer" });

		host.resolve();
		const result = await urgent;
		assert.match(result.content[0].text, /Pick: selected "A"/);

		const next = await tool.execute("call-bg-next", { questions: [question] }, undefined, undefined, host.ctx);
		assert.equal(next.isError, undefined, "the background slot was released");
	});

	it("cancels a background questionnaire that another Pi dialog displaced", async () => {
		const { tool, messages } = loadExtension();
		// Mimic Pi: custom components and dialogs share one editor slot, and the
		// prompt's close() puts the editor back into that slot.
		const editor = { focused: false, render: () => [], invalidate: () => {} };
		const slot = { children: [editor] as unknown[], render: () => [], invalidate: () => {} };
		let focus: any = editor;
		const listeners: Array<(data: string) => unknown> = [];
		const setFocus = (component: any) => {
			focus.focused = false;
			focus = component;
			component.focused = true;
		};
		const tui = {
			children: [slot],
			terminal: { rows: 40, columns: 100 },
			requestRender: () => {},
			getFocusedComponent: () => focus,
			addInputListener: (listener: (data: string) => unknown) => {
				listeners.push(listener);
				return () => listeners.splice(listeners.indexOf(listener), 1);
			},
		} as unknown as TUI;
		let closes = 0;
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: (factory: any) =>
					new Promise<AskResult>((resolve) => {
						const component = factory(tui, theme, {}, (result: AskResult) => {
							closes += 1;
							slot.children = [editor];
							setFocus(editor);
							resolve(result);
						});
						slot.children = [component];
						setFocus(component);
					}),
			},
		} as unknown as ExtensionToolContext;
		const params = { questions: [{ id: "pick", label: "Pick", question: "Choose", options: [{ label: "A" }] }] };
		await tool.execute("call-bg", params, undefined, undefined, ctx);

		// An overlay above the questionnaire takes focus but leaves it mounted.
		const overlay = { focused: false, render: () => [], invalidate: () => {} };
		const mounted = focus;
		setFocus(overlay);
		setFocus(mounted);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(messages.length, 0, "an overlay does not cancel the questionnaire");

		const dialog = { focused: false, render: () => [], invalidate: () => {} };
		slot.children = [dialog];
		setFocus(dialog);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(messages.length, 1);
		assert.match(messages[0]!.message.content, /another dialog replaced it/);
		assert.equal(closes, 0, "closing now would remove the dialog that replaced the questionnaire");
		assert.equal(slot.children[0], dialog);

		// The dialog closes and Pi focuses the editor; the next key closes our prompt.
		slot.children = [editor];
		setFocus(editor);
		for (const listener of [...listeners]) listener("x");
		assert.equal(closes, 1);
		assert.equal(listeners.length, 0);

		const next = await tool.execute("call-bg-next", params, undefined, undefined, ctx);
		assert.equal(next.isError, undefined, "the background slot was released");
	});

	it("drops late background answers if the parent session switched without firing an event", async () => {
		const { tool, messages } = loadExtension();
		const host = tuiContext("session-origin");
		const params = {
			mode: "background" as const,
			questions: [{ id: "pick", label: "Pick", question: "Choose", options: [{ label: "A" }] }],
		};
		await tool.execute("call-bg-origin", params, undefined, undefined, host.ctx);
		host.setSessionId("session-switched");
		host.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(messages.length, 0, "answers from an earlier session id must never steer the switched session");
	});
});
