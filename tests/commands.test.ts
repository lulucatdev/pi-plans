import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerCommands } from "../extensions/lib/commands.js";
import { userLanguageSection } from "../extensions/lib/prompting.js";
import type { SessionState } from "../extensions/lib/types.js";

interface RegisteredCommand {
	handler: (args: string | undefined, ctx: any) => Promise<void>;
}

function createHarness(session: SessionState) {
	const commands = new Map<string, RegisteredCommand>();
	const sentMessages: Array<{ customType: string; content: string; display: boolean }> = [];

	registerCommands({
		registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
		sendMessage: (message: { customType: string; content: string; display: boolean }) => sentMessages.push(message),
	} as any, session);

	return { commands, sentMessages };
}

describe("registerCommands", () => {
	let tmpDir: string;
	let session: SessionState;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-commands-"));
		session = { focusedPlan: undefined, planGate: undefined };
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("adds language guidance to brainstorm and plan prompts", async () => {
		const { commands, sentMessages } = createHarness(session);
		const ctx = {
			cwd: tmpDir,
			ui: { notify: () => undefined },
		};

		await commands.get("just-brainstorm")!.handler("界面改造", ctx);
		await commands.get("start-brainstorm")!.handler("界面改造", ctx);
		await commands.get("start-plan")!.handler("界面改造", ctx);

		expect(sentMessages).toHaveLength(3);
		for (const message of sentMessages) {
			expect(message.content).toContain(userLanguageSection);
			expect(message.content).toContain("Match the user's language as closely as possible");
		}
	});
});
