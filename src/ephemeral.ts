/**
 * Ephemeral chats for pi.
 *
 * `/ephemeral` opens an in-memory chat immediately. Repeating it before any
 * messages have been sent returns to the saved chat. Private conversation
 * history is never converted into a saved session.
 */

import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

/** Footer status key for the ephemeral badge. */
const STATUS_KEY = "ephemeral";
const RETURN_ENTRY = "pi-qol-ephemeral-return";

/** The fields that separate a file-backed `SessionManager` from `SessionManager.inMemory()`. */
interface SessionManagerInternals {
	persist?: boolean;
	sessionFile?: string;
	sessionDir?: string;
}

/**
 * Turn a just-created file-backed session manager into an in-memory one.
 *
 * `ctx.newSession()` always inherits the persistence mode of the outgoing
 * session, and `ExtensionCommandContext` has no option to request an in-memory
 * session. This writes the same internal fields as `SessionManager.inMemory()`.
 * It runs from `newSession({ setup })`, after the runtime exists but before the
 * first message would create the session file.
 *
 * @returns `true` when the manager is verifiably in-memory.
 */
export function makeSessionInMemory(sessionManager: SessionManager): boolean {
	try {
		const internals = sessionManager as unknown as SessionManagerInternals;
		if (typeof internals.persist !== "boolean") {
			return false;
		}
		internals.persist = false;
		internals.sessionFile = undefined;
		internals.sessionDir = "";
	} catch {
		return false;
	}
	return sessionManager.isPersisted() === false && sessionManager.getSessionFile() === undefined;
}

/**
 * Whether the active chat is file-backed. The published `ExtensionContext`
 * type hides `isPersisted()` behind `ReadonlySessionManager`, but the runtime
 * object is the full session manager.
 */
function isPersisted(ctx: ExtensionContext): boolean {
	return (ctx.sessionManager as SessionManager).isPersisted();
}

/** Keep the footer badge in sync with the active chat. */
function refreshStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}
	if (isPersisted(ctx)) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "◌ ephemeral"));
}

export default function ephemeralPlugin(pi: ExtensionAPI): void {
	let switching = false;
	pi.registerShortcut(Key.alt("p"), {
		description: "Toggle an empty ephemeral chat",
		handler: () => {
			// Shortcuts lack newSession(). Dispatch the command with its full context.
			pi.sendUserMessage("/ephemeral", { expandPromptTemplates: true });
		},
	});

	pi.registerCommand("ephemeral", {
		description: "Open a private chat or leave an empty one",
		handler: async (args, ctx) => {
			if (switching) return;
			const initialPrompt = args.trim();
			if (!isPersisted(ctx)) {
				const entries = ctx.sessionManager.getEntries();
				if (initialPrompt || entries.some(entry => entry.type === "message") || !ctx.isIdle() || ctx.hasPendingMessages()) {
					ctx.ui.notify("This chat is already ephemeral. Only an empty, idle chat can leave private mode.", "info");
					refreshStatus(ctx);
					return;
				}
				const previous = entries.findLast(entry => entry.type === "custom" && entry.customType === RETURN_ENTRY);
				const data = previous?.type === "custom" ? previous.data as { sessionFile?: unknown } | null : null;
				const target = typeof data?.sessionFile === "string" && data.sessionFile
					? data.sessionFile : SessionManager.create(ctx.cwd).getSessionFile()!;
				switching = true;
				try {
					const result = await ctx.switchSession(target, {
						withSession: async newCtx => {
							refreshStatus(newCtx);
							newCtx.ui.notify("Private mode off.", "info");
						},
					});
					if (result.cancelled) ctx.ui.notify("Still in private mode.", "info");
				} finally {
					switching = false;
				}
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("Creating an ephemeral chat needs an interactive UI.", "error");
				return;
			}

			const previousSessionFile = ctx.sessionManager.getSessionFile();
			let inMemory = false;

			// The current ctx is stale after a successful replacement. Any work that
			// needs the new session must run in withSession().
			switching = true;
			try {
				const result = await ctx.newSession({
					setup: async (sessionManager) => {
						inMemory = makeSessionInMemory(sessionManager);
						if (inMemory && previousSessionFile) {
							sessionManager.appendCustomEntry(RETURN_ENTRY, { sessionFile: previousSessionFile });
						}
					},
					withSession: async (newCtx) => {
						refreshStatus(newCtx);
						if (inMemory) {
							newCtx.ui.notify("Ephemeral chat started. Nothing in this chat is saved to disk.", "info");
						} else {
							newCtx.ui.notify(
								"Could not disable session persistence for the new chat. It will be saved. No initial prompt was sent.",
								"error",
							);
							return;
						}
						if (initialPrompt) {
							await newCtx.sendUserMessage(initialPrompt, { expandPromptTemplates: true });
						}
					},
				});

				if (result.cancelled) {
					ctx.ui.notify("No new chat was created.", "info");
				}
			} finally {
				switching = false;
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}
