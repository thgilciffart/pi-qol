import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSessionInMemory } from "../src/ephemeral.ts";

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
