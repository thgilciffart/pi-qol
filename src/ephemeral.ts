/**
 * Ephemeral chats for pi.
 *
 * `/ephemeral` starts a new chat that is never written to disk. The active
 * chat is never converted, because pi fixes persistence when a session is
 * created; on a saved chat the plugin asks whether to create a new ephemeral
 * chat instead.
 */

import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";

/** Footer status key for the ephemeral badge. */
const STATUS_KEY = "ephemeral";

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
	pi.registerCommand("ephemeral", {
		description: "Start a new chat that is never saved to disk",
		handler: async (args, ctx) => {
			if (!isPersisted(ctx)) {
				ctx.ui.notify("This chat is already ephemeral. Nothing is saved to disk.", "info");
				refreshStatus(ctx);
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("Creating an ephemeral chat needs an interactive UI.", "error");
				return;
			}

			const confirmed = await ctx.ui.confirm(
				"Start a new ephemeral chat?",
				"This chat is saved and can't be turned into an ephemeral chat.\n\n" +
					"Create a new chat that is never written to disk?",
			);
			if (!confirmed) {
				ctx.ui.notify("No new chat was created.", "info");
				return;
			}

			const initialPrompt = args.trim();
			let inMemory = false;

			// The current ctx is stale after a successful replacement. Any work that
			// needs the new session must run in withSession().
			const result = await ctx.newSession({
				setup: async (sessionManager) => {
					inMemory = makeSessionInMemory(sessionManager);
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
