import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "../extensions/lib/hooks.js";
import { userLanguageRule } from "../extensions/lib/prompting.js";
import type { SessionState } from "../extensions/lib/types.js";

function createActivePlan(root: string): string {
	const planDir = path.join(root, ".pi", "plans", "active", "20260417000000-language-test");
	fs.mkdirSync(planDir, { recursive: true });
	fs.writeFileSync(path.join(planDir, "plan.md"), "# Language Test\n", "utf-8");
	return planDir;
}

describe("registerHooks", () => {
	let tmpDir: string;
	let previousCwd: string;
	let previousChildType: string | undefined;
	let session: SessionState;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-hooks-"));
		previousCwd = process.cwd();
		previousChildType = process.env.PI_CHILD_TYPE;
		session = { focusedPlan: undefined, planGate: undefined };
		process.chdir(tmpDir);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		if (previousChildType === undefined) {
			delete process.env.PI_CHILD_TYPE;
		} else {
			process.env.PI_CHILD_TYPE = previousChildType;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("injects language guidance into the root active-plan system prompt", async () => {
		createActivePlan(tmpDir);
		const handlers = new Map<string, Function>();

		registerHooks({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any, session);

		const result = await handlers.get("before_agent_start")!({ systemPrompt: "Base prompt", prompt: "Implement this change" });
		expect(result?.systemPrompt).toContain("## Active Plans");
		expect(result?.systemPrompt).toContain(userLanguageRule);
	});

	it("injects language guidance into child worker prompts with planPath", async () => {
		const planDir = createActivePlan(tmpDir);
		process.env.PI_CHILD_TYPE = "task";
		const handlers = new Map<string, Function>();

		registerHooks({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any, session);

		const result = await handlers.get("before_agent_start")!({
			systemPrompt: "Base prompt",
			prompt: `Worker instructions\nplanPath: ${planDir}`,
		});
		expect(result?.systemPrompt).toContain("## Active Plan");
		expect(result?.systemPrompt).toContain(userLanguageRule);
	});
});
