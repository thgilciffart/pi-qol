import { describe, expect, test } from "bun:test";
import plugin from "../src/ephemeral.ts";

/**
 * Minimal structural stand-in for the host SessionManager. The plugin only
 * reads isPersisted()/getSessionFile()/getSessionDir(), and converts a fresh
 * manager by writing the private `persist`, `sessionFile`, and `sessionDir`
 * fields that SessionManager.inMemory() also sets.
 */
class FakeSessionManager {
	persist: boolean;
	sessionFile: string | undefined;
	sessionDir: string;

	constructor(persist: boolean, sessionFile: string | undefined, sessionDir = "/tmp/pi-sessions") {
		this.persist = persist;
		this.sessionFile = sessionFile;
		this.sessionDir = sessionDir;
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}
}

interface Notification {
	message: string;
	type?: "info" | "warning" | "error";
}

interface StatusUpdate {
	key: string;
	text: string | undefined;
}

interface HarnessOptions {
	persistent?: boolean;
	/** Replacement manager returned by the fake newSession(). Defaults to a file-backed one. */
	nextManager?: unknown;
}

function createHarness(options: HarnessOptions = {}) {
	const recorded = {
		notifications: [] as Notification[],
		statuses: [] as StatusUpdate[],
		confirmations: 0,
		newSessions: 0,
		sentMessages: [] as string[],
		nextManagers: [] as unknown[],
	};
	let confirmResult = true;

	type Command = { handler: (args: string, ctx: unknown) => Promise<void> };
	type Handler = (event: unknown, ctx: unknown) => Promise<void>;

	const commands = new Map<string, Command>();
	const handlers = new Map<string, Handler>();
	const pi = {
		registerCommand: (name: string, command: Command) => {
			commands.set(name, command);
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
	};
	plugin(pi as never);

	const persistent = options.persistent ?? true;
	const currentManager = new FakeSessionManager(persistent, persistent ? "/tmp/pi-sessions/current.jsonl" : undefined);

	const ui = {
		theme: { fg: (_color: string, text: string) => text },
		notify: (message: string, type?: "info" | "warning" | "error") => {
			recorded.notifications.push({ message, type });
		},
		setStatus: (key: string, text: string | undefined) => {
			recorded.statuses.push({ key, text });
		},
		confirm: async () => {
			recorded.confirmations += 1;
			return confirmResult;
		},
	};

	function makeContext(sessionManager: unknown) {
		return {
			mode: "tui",
			hasUI: true,
			sessionManager,
			ui,
			newSession: async (newSessionOptions?: {
				setup?: (manager: unknown) => Promise<void>;
				withSession?: (ctx: unknown) => Promise<void>;
			}) => {
				recorded.newSessions += 1;
				const next = options.nextManager ?? new FakeSessionManager(true, "/tmp/pi-sessions/next.jsonl");
				recorded.nextManagers.push(next);
				if (newSessionOptions?.setup) {
					await newSessionOptions.setup(next);
				}
				if (newSessionOptions?.withSession) {
					await newSessionOptions.withSession(makeContext(next));
				}
				return { cancelled: false };
			},
			sendUserMessage: async (content: unknown) => {
				recorded.sentMessages.push(String(content));
			},
		};
	}

	return {
		commands,
		handlers,
		recorded,
		currentManager,
		ctx: makeContext(currentManager),
		setConfirmResult: (value: boolean) => {
			confirmResult = value;
		},
		run: (args = "") => {
			const command = commands.get("ephemeral");
			if (!command) throw new Error("command not registered");
			return command.handler(args, makeContext(currentManager));
		},
	};
}

describe("/ephemeral", () => {
	test("asks before creating a chat when the current chat is saved", async () => {
		const harness = createHarness();
		await harness.run();

		expect(harness.recorded.confirmations).toBe(1);
		expect(harness.recorded.newSessions).toBe(1);
	});

	test("leaves the session untouched when the user declines", async () => {
		const harness = createHarness();
		harness.setConfirmResult(false);
		await harness.run();

		expect(harness.recorded.confirmations).toBe(1);
		expect(harness.recorded.newSessions).toBe(0);
		expect(harness.recorded.notifications.at(-1)?.message).toBe("No new chat was created.");
	});

	test("does not ask when the current chat is already ephemeral", async () => {
		const harness = createHarness({ persistent: false });
		await harness.run();

		expect(harness.recorded.confirmations).toBe(0);
		expect(harness.recorded.newSessions).toBe(0);
		expect(harness.recorded.notifications[0]?.message).toContain("already ephemeral");
	});

	test("makes the replacement session in-memory", async () => {
		const harness = createHarness();
		await harness.run();

		const next = harness.recorded.nextManagers[0];
		expect(next).toBeInstanceOf(FakeSessionManager);
		const manager = next as FakeSessionManager;
		expect(manager.isPersisted()).toBe(false);
		expect(manager.getSessionFile()).toBeUndefined();
		expect(manager.getSessionDir()).toBe("");
		expect(harness.recorded.notifications.some((n) => n.message.includes("Ephemeral chat started"))).toBe(true);
	});

	test("sends the initial prompt into the new chat", async () => {
		const harness = createHarness();
		await harness.run("  explain the build  ");

		expect(harness.recorded.sentMessages).toEqual(["explain the build"]);
	});

	test("reports an error when persistence cannot be disabled", async () => {
		const stubborn = {
			persist: undefined,
			isPersisted: () => true,
			getSessionFile: () => "/tmp/pi-sessions/stubborn.jsonl",
			getSessionDir: () => "/tmp/pi-sessions",
		};
		const harness = createHarness({ nextManager: stubborn });
		await harness.run("private initial prompt");

		expect(
			harness.recorded.notifications.some((n) => n.type === "error" && n.message.includes("will be saved")),
		).toBe(true);
		expect(harness.recorded.sentMessages).toEqual([]);
	});

	test("shows the badge on an ephemeral chat and clears it on a saved chat", async () => {
		const ephemeral = createHarness({ persistent: false });
		const onSessionStart = ephemeral.handlers.get("session_start");
		if (!onSessionStart) throw new Error("session_start handler not registered");
		await onSessionStart({ type: "session_start" }, ephemeral.ctx);
		expect(ephemeral.recorded.statuses.at(-1)).toEqual({ key: "ephemeral", text: "◌ ephemeral" });

		const saved = createHarness();
		const onSavedSessionStart = saved.handlers.get("session_start");
		if (!onSavedSessionStart) throw new Error("session_start handler not registered");
		await onSavedSessionStart({ type: "session_start" }, saved.ctx);
		expect(saved.recorded.statuses.at(-1)).toEqual({ key: "ephemeral", text: undefined });
	});
});
