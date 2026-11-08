import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSessionInMemory, saveSessionToDisk } from "../src/ephemeral.ts";

/**
 * The conversion writes private SessionManager fields, so verify it against
 * the real host class when the host package is installed. `bun install`
 * installs the peer dependency; without it this file is skipped.
 */
let SessionManager: typeof import("@earendil-works/pi-coding-agent").SessionManager | undefined;
try {
	({ SessionManager } = await import("@earendil-works/pi-coding-agent"));
} catch {
	SessionManager = undefined;
}

const disabled = SessionManager === undefined;

function makeTempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "pi-ephemeral-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("makeSessionInMemory", () => {
	test.skipIf(disabled)("converts a file-backed manager into an in-memory one", () => {
		const { dir, cleanup } = makeTempDir();
		try {
			const sessionDir = join(dir, "sessions");
			const manager = SessionManager!.create(dir, sessionDir);
			expect(manager.isPersisted()).toBe(true);
			expect(manager.getSessionFile()).toBeDefined();

			expect(makeSessionInMemory(manager)).toBe(true);
			expect(manager.isPersisted()).toBe(false);
			expect(manager.getSessionFile()).toBeUndefined();
			expect(manager.getSessionDir()).toBe("");
		} finally {
			cleanup();
		}
	});

	test.skipIf(disabled)("keeps messages in memory instead of writing a session file", () => {
		const { dir, cleanup } = makeTempDir();
		try {
			const sessionDir = join(dir, "sessions");

			// Control: a file-backed manager writes once the conversation starts.
			const persisted = SessionManager!.create(dir, sessionDir);
			persisted.appendMessage({ role: "user", content: [{ type: "text", text: "saved" }], timestamp: Date.now() });
			expect(existsSync(persisted.getSessionFile()!)).toBe(true);

			// Converted manager: the same append stays in memory.
			const ephemeral = SessionManager!.create(dir, sessionDir);
			expect(makeSessionInMemory(ephemeral)).toBe(true);
			ephemeral.appendMessage({ role: "user", content: [{ type: "text", text: "temporary" }], timestamp: Date.now() });
			ephemeral.appendModelChange("provider", "model");
			expect(readdirSync(sessionDir)).toHaveLength(1);
			expect(ephemeral.getEntries().some((entry) => entry.type === "message")).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("saveSessionToDisk", () => {
	test.skipIf(disabled)("writes an in-memory session to a new file and appends later entries to it", async () => {
		const { dir, cleanup } = makeTempDir();
		const sessionDir = join(dir, "sessions");
		const manager = SessionManager!.create(dir, sessionDir);
		// An ephemeral manager has no session dir, so /save falls back to the default
		// one. Point the default at the temp dir for the test.
		const create = spyOn(SessionManager!, "create").mockReturnValue({ getSessionDir: () => sessionDir } as InstanceType<typeof SessionManager>);
		try {
			expect(makeSessionInMemory(manager)).toBe(true);
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "temporary" }], timestamp: Date.now() });
			expect(readdirSync(sessionDir)).toHaveLength(0);

			const path = await saveSessionToDisk(manager);
			expect(manager.isPersisted()).toBe(true);
			expect(manager.getSessionFile()).toBe(path);
			expect(path.startsWith(sessionDir)).toBe(true);
			const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(lines[0].type).toBe("session");
			expect(lines).toHaveLength(2);
			expect(lines[1].message.content[0].text).toBe("temporary");

			// After saving, new entries append to the same file like a normal session.
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: Date.now() } as never);
			expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3);
			expect(readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"))).toHaveLength(1);
		} finally {
			create.mockRestore();
			cleanup();
		}
	});

	test.skipIf(disabled)("fails without modifying the session when the target file already exists", async () => {
		const { dir, cleanup } = makeTempDir();
		const sessionDir = join(dir, "sessions");
		const manager = SessionManager!.create(dir, sessionDir);
		const create = spyOn(SessionManager!, "create").mockReturnValue({ getSessionDir: () => sessionDir } as InstanceType<typeof SessionManager>);
		const RealDate = globalThis.Date;
		const fixed = new RealDate("2026-01-02T03:04:05.678Z").getTime();
		class FixedDate extends RealDate {
			constructor(...args: any[]) { super(...(args.length ? args : [fixed]) as [number]); }
			static override now() { return fixed; }
		}
		try {
			expect(makeSessionInMemory(manager)).toBe(true);
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "temporary" }], timestamp: fixed });
			// Occupy the exact name the save would use.
			const { mkdirSync, writeFileSync } = await import("node:fs");
			mkdirSync(sessionDir, { recursive: true });
			const clash = join(sessionDir, `2026-01-02T03-04-05-678Z_${manager.getSessionId()}.jsonl`);
			writeFileSync(clash, "occupied\n");
			globalThis.Date = FixedDate as DateConstructor;
			await expect(saveSessionToDisk(manager)).rejects.toThrow(/Could not create/);
			expect(manager.isPersisted()).toBe(false);
			expect(manager.getSessionFile()).toBeUndefined();
			expect(readFileSync(clash, "utf8")).toBe("occupied\n");
		} finally {
			globalThis.Date = RealDate;
			create.mockRestore();
			cleanup();
		}
	});
});
