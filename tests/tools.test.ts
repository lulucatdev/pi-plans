import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerTools } from "../extensions/lib/tools.js";
import { activeDir, pendingDir, planFile, logFile } from "../extensions/lib/utils.js";
import { VERIFICATION_READY_MARKER, VERIFIED_MARKER } from "../extensions/lib/format.js";
import type { SessionState } from "../extensions/lib/types.js";

interface ToolSpec {
	execute: (id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, ctx: any) => Promise<any>;
	renderResult?: (result: any, options: unknown, theme: any) => { text: string };
}

function registerTestTools(session: SessionState): Map<string, ToolSpec> {
	const tools = new Map<string, ToolSpec>();
	registerTools({ registerTool: (tool: ToolSpec & { name: string }) => tools.set(tool.name, tool) } as any, session);
	return tools;
}

function createCtx(cwd: string): any {
	const unexpected = () => {
		throw new Error("UI should not be called in this workflow");
	};
	return {
		cwd,
		ui: {
			select: unexpected,
			input: unexpected,
			notify: unexpected,
		},
	};
}

function createTheme() {
	return {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
		bold: (text: string) => text,
	};
}

describe("plan tools", () => {
	let tmpDir: string;
	let session: SessionState;
	let tools: Map<string, ToolSpec>;
	let ctx: any;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-tools-"));
		session = { focusedPlan: undefined, planGate: undefined };
		tools = registerTestTools(session);
		ctx = createCtx(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates and activates a plan immediately by default", async () => {
		const result = await tools.get("plan_create")!.execute("1", {
			name: "auth-refactor",
			goal: "Refactor authentication.",
			steps: ["Update the auth module and verify with tests."],
		}, undefined, undefined, ctx);

		const planPath = result.details.planPath as string;
		expect(planPath.startsWith(activeDir(tmpDir))).toBe(true);
		expect(fs.existsSync(planFile(planPath))).toBe(true);
		expect(session.focusedPlan).toBe(planPath);
		expect(result.content[0].text).toContain("activated");
	});

	it("can create a pending plan without activating it", async () => {
		const result = await tools.get("plan_create")!.execute("1", {
			name: "auth-refactor",
			goal: "Refactor authentication.",
			activate: false,
			steps: ["Update the auth module and verify with tests."],
		}, undefined, undefined, ctx);

		const planPath = result.details.planPath as string;
		expect(planPath.startsWith(pendingDir(tmpDir))).toBe(true);
		expect(fs.existsSync(planFile(planPath))).toBe(true);
		expect(session.focusedPlan).toBeUndefined();
		expect(result.content[0].text).toContain("saved for later");
	});

	it("uses explicit verification preparation before recording approval", async () => {
		const created = await tools.get("plan_create")!.execute("1", {
			name: "auth-refactor",
			goal: "Refactor authentication.",
			steps: ["Update the auth module and verify with tests."],
			verification: {
				manual: ["Login succeeds with a valid account"],
			},
		}, undefined, undefined, ctx);
		const planPath = created.details.planPath as string;

		await expect(
			tools.get("plan_verify")!.execute("2", { status: "approved" }, undefined, undefined, ctx),
		).rejects.toThrow("Run plan_prepare_to_verify first");

		const prepared = await tools.get("plan_prepare_to_verify")!.execute("3", {
			automated_results: "npm test: 12 passed",
		}, undefined, undefined, ctx);
		expect(prepared.content[0].text).toContain("Ask the user to perform these checks");
		expect(fs.readFileSync(planFile(planPath), "utf-8")).toContain(VERIFICATION_READY_MARKER);
		expect(fs.readFileSync(logFile(planPath), "utf-8")).toContain("Verification prepared");

		const verified = await tools.get("plan_verify")!.execute("4", {
			status: "approved",
			feedback: "Manual checks passed.",
		}, undefined, undefined, ctx);
		expect(verified.content[0].text).toContain("plan_finish");

		const content = fs.readFileSync(planFile(planPath), "utf-8");
		expect(content).not.toContain(VERIFICATION_READY_MARKER);
		expect(content).toContain(VERIFIED_MARKER);
	});

	it("renders plan_log results with the logged message inline", async () => {
		await tools.get("plan_create")!.execute("1", {
			name: "auth-refactor",
			goal: "Refactor authentication.",
			steps: ["Update the auth module and verify with tests."],
		}, undefined, undefined, ctx);

		const result = await tools.get("plan_log")!.execute("2", {
			message: "Record the migration decision for the shared Exa helper.",
		}, undefined, undefined, ctx);
		const rendered = tools.get("plan_log")!.renderResult!(result, undefined, createTheme());
		expect(rendered.text).toContain("log: Record the migration decision for the shared Exa helper.");
		expect(rendered.text).toContain("auth-refactor");
	});

	it("renders plan_update results with the updated content inline", async () => {
		await tools.get("plan_create")!.execute("1", {
			name: "auth-refactor",
			goal: "Refactor authentication.",
			steps: ["Update the auth module and verify with tests."],
		}, undefined, undefined, ctx);

		const result = await tools.get("plan_update")!.execute("2", {
			log: "Start moving the Exa-specific commands into the new package.",
		}, undefined, undefined, ctx);
		const rendered = tools.get("plan_update")!.renderResult!(result, undefined, createTheme());
		expect(rendered.text).toContain("log: Start moving the Exa-specific commands into the new package.");
		expect(rendered.text).toContain("auth-refactor");
	});

	it("renders plan_abort as a single-line summary", async () => {
		await tools.get("plan_create")!.execute("1", {
			name: "auth-refactor",
			goal: "Refactor authentication.",
			steps: ["Update the auth module and verify with tests."],
		}, undefined, undefined, ctx);

		const result = await tools.get("plan_abort")!.execute("2", {
			reason: "The dependency was removed upstream.",
		}, undefined, undefined, ctx);
		const rendered = tools.get("plan_abort")!.renderResult!(result, undefined, createTheme());
		expect(rendered.text).toContain("aborted: The dependency was removed upstream.");
		expect(rendered.text).toContain("auth-refactor");
		expect(rendered.text).not.toContain("\n");
	});

	it("renders plan_resume as a single-line summary", async () => {
		await tools.get("plan_create")!.execute("1", {
			name: "auth-refactor",
			goal: "Refactor authentication.",
			steps: ["Update the auth module and verify with tests."],
		}, undefined, undefined, ctx);

		const aborted = await tools.get("plan_abort")!.execute("2", {
			reason: "Paused for later.",
		}, undefined, undefined, ctx);
		const result = await tools.get("plan_resume")!.execute("3", {
			plan_path: aborted.details.planPath,
			reason: "The work is back in scope.",
		}, undefined, undefined, ctx);
		const rendered = tools.get("plan_resume")!.renderResult!(result, undefined, createTheme());
		expect(rendered.text).toContain("resumed and activated:");
		expect(rendered.text).toContain("auth-refactor");
		expect(rendered.text).not.toContain("\n");
	});

	it("renders plan_activate as a single-line summary", async () => {
		const created = await tools.get("plan_create")!.execute("1", {
			name: "auth-refactor",
			goal: "Refactor authentication.",
			activate: false,
			steps: ["Update the auth module and verify with tests."],
		}, undefined, undefined, ctx);

		const result = await tools.get("plan_activate")!.execute("2", {
			plan_path: created.details.planPath,
		}, undefined, undefined, ctx);
		const rendered = tools.get("plan_activate")!.renderResult!(result, undefined, createTheme());
		expect(rendered.text).toContain("activated:");
		expect(rendered.text).toContain("auth-refactor");
		expect(rendered.text).not.toContain("\n");
	});

	it("returns a detailed summary from plan_finish", async () => {
		await tools.get("plan_create")!.execute("1", {
			name: "auth-refactor",
			goal: "Refactor authentication.",
			steps: ["Update the auth module and verify with tests."],
			verification: { manual: ["Login succeeds with a valid account"] },
		}, undefined, undefined, ctx);
		await tools.get("plan_update")!.execute("2", { complete_step: 1 }, undefined, undefined, ctx);
		await tools.get("plan_prepare_to_verify")!.execute("3", {
			automated_results: "npm test: 12 passed",
		}, undefined, undefined, ctx);
		await tools.get("plan_verify")!.execute("4", {
			status: "approved",
			feedback: "Manual checks passed.",
		}, undefined, undefined, ctx);

		const result = await tools.get("plan_finish")!.execute("5", {
			summary: "Moved the shared Exa integration into its own package, updated the registration flow, and verified the resulting plan workflow with automated and manual checks.",
		}, undefined, undefined, ctx);
		expect(result.content[0].text).toContain("Plan completed: auth-refactor");
		expect(result.content[0].text).toContain("Summary:");
		expect(result.content[0].text).toContain("Moved the shared Exa integration into its own package");
		expect(result.content[0].text).toContain("Archived at:");
	});
});
