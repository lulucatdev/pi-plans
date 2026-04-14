import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDraftPlan } from "../extensions/lib/state.js";
import { pendingDir, activeDir, planFile } from "../extensions/lib/utils.js";
import type { SessionState } from "../extensions/lib/types.js";

describe("createDraftPlan", () => {
	let tmpDir: string;
	let session: SessionState;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-state-"));
		session = { focusedPlan: undefined, planGate: undefined };
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates draft plans in pending without activating them", () => {
		const draftPath = createDraftPlan(tmpDir, "auth refactor", session);

		expect(draftPath.startsWith(pendingDir(tmpDir))).toBe(true);
		expect(fs.existsSync(planFile(draftPath))).toBe(true);
		expect(fs.existsSync(activeDir(tmpDir))).toBe(false);
		expect(session.focusedPlan).toBe(draftPath);
	});
});
