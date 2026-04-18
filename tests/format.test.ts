import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseSteps, completeStep, addStep, renderPlan, renderResearchDoc, renderReviewDoc, renderLogHeader, appendLog, markAsDraft } from "../extensions/lib/format.js";

const samplePlan = `# Test Plan

> Created: 2026-03-23 14:00

**Goal:** Test the parser

---

## Steps

- [x] Step one done
- [ ] **Step two current** ← current
- [ ] Step three pending
`;

describe("parseSteps", () => {
	it("parses steps within ## Steps section only", () => {
		const steps = parseSteps(samplePlan);
		expect(steps).toHaveLength(3);
		expect(steps[0].done).toBe(true);
		expect(steps[0].text).toBe("Step one done");
		expect(steps[1].done).toBe(false);
		expect(steps[1].isCurrent).toBe(true);
		expect(steps[1].text).toBe("Step two current");
		expect(steps[2].done).toBe(false);
		expect(steps[2].isCurrent).toBe(false);
	});

	it("does NOT parse checkboxes outside ## Steps", () => {
		const steps = parseSteps(samplePlan);
		const texts = steps.map((s) => s.text);
		expect(texts).not.toContain("Feature works correctly");
		expect(texts).not.toContain("No regressions");
	});

	it("handles case-insensitive ## Steps heading", () => {
		const plan = "## steps\n\n- [ ] A step\n\n## Verification\n";
		const steps = parseSteps(plan);
		expect(steps).toHaveLength(1);
		expect(steps[0].text).toBe("A step");
	});

	it("returns empty array when no ## Steps section", () => {
		const steps = parseSteps("# No steps here\n\nJust text.\n");
		expect(steps).toHaveLength(0);
	});
});

describe("completeStep", () => {
	it("marks a step as done and advances current", () => {
		const result = completeStep(samplePlan, 1);
		const steps = parseSteps(result);
		expect(steps[1].done).toBe(true);
		expect(steps[1].isCurrent).toBe(false);
		expect(steps[2].isCurrent).toBe(true);
	});

	it("allows completing non-current step (out of order)", () => {
		const result = completeStep(samplePlan, 2);
		const steps = parseSteps(result);
		expect(steps[2].done).toBe(true);
		// Current should point to earliest remaining incomplete (step 2, index 1)
		const currentSteps = steps.filter((s) => s.isCurrent);
		expect(currentSteps.length).toBe(1);
		expect(currentSteps[0].index).toBe(1);
	});

	it("throws on already completed step", () => {
		expect(() => completeStep(samplePlan, 0)).toThrow("already completed");
	});

	it("throws on out-of-range step", () => {
		expect(() => completeStep(samplePlan, 99)).toThrow("not found");
	});
});

describe("addStep", () => {
	it("appends step after last step by default", () => {
		const result = addStep(samplePlan, "New step");
		const steps = parseSteps(result);
		expect(steps).toHaveLength(4);
		expect(steps[3].text).toBe("New step");
	});

	it("inserts step after specified index", () => {
		const result = addStep(samplePlan, "Inserted", 0);
		const steps = parseSteps(result);
		expect(steps).toHaveLength(4);
		expect(steps[1].text).toBe("Inserted");
	});

	it("marks new step as current when all steps are done", () => {
		const allDone = `## Steps\n\n- [x] Done one\n- [x] Done two\n`;
		const result = addStep(allDone, "New work");
		const steps = parseSteps(result);
		expect(steps[2].isCurrent).toBe(true);
		expect(steps[2].text).toBe("New work");
	});

	it("does not mark as current when a current already exists", () => {
		const result = addStep(samplePlan, "Extra step");
		const steps = parseSteps(result);
		const newStep = steps.find((s) => s.text === "Extra step");
		expect(newStep?.isCurrent).toBe(false);
	});
});

describe("appendLog", () => {
	let tmpDir: string;
	let logPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-log-"));
		logPath = path.join(tmpDir, "log.md");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates log file with header if it doesn't exist", () => {
		appendLog(logPath, "First entry");
		const content = fs.readFileSync(logPath, "utf-8");
		expect(content).toContain("# Plan Log");
		expect(content).toContain("First entry");
	});

	it("appends to existing log file", () => {
		appendLog(logPath, "First");
		appendLog(logPath, "Second");
		const content = fs.readFileSync(logPath, "utf-8");
		expect(content).toContain("First");
		expect(content).toContain("Second");
	});

	it("includes timestamps", () => {
		appendLog(logPath, "Test entry");
		const content = fs.readFileSync(logPath, "utf-8");
		expect(content).toMatch(/\*\*\d{4}-\d{2}-\d{2} \d{2}:\d{2}\*\* -- Test entry/);
	});
});

describe("renderPlan", () => {
	it("generates plan with goal and steps, no log section", () => {
		const result = renderPlan("Test", "Build a thing", ["Step A", "Step B"]);
		expect(result).toContain("# Test");
		expect(result).toContain("**Goal:** Build a thing");
		expect(result).toContain("- [ ] **Step A** ← current");
		expect(result).toContain("- [ ] Step B");
		expect(result).toContain("## Steps");
		expect(result).not.toContain("## Log");
	});

	it("includes architecture when provided", () => {
		const result = renderPlan("T", "G", ["S"], "Use microservices");
		expect(result).toContain("**Architecture:** Use microservices");
	});
});

describe("markAsDraft", () => {
	it("appends a draft marker to rendered plan content", () => {
		const result = markAsDraft("# Test\n\nBody\n");
		expect(result).toBe("# Test\n\nBody\n\n<!-- DRAFT -->\n");
	});

	it("does not duplicate an existing draft marker", () => {
		const result = markAsDraft("# Test\n\nBody\n\n<!-- DRAFT -->\n\n");
		expect(result).toBe("# Test\n\nBody\n\n<!-- DRAFT -->\n");
	});
});

describe("renderResearchDoc", () => {
	it("generates research doc with topic and plan name", () => {
		const result = renderResearchDoc("OAuth best practices", "Auth Refactor");
		expect(result).toContain("# Research: OAuth best practices");
		expect(result).toContain("> Plan: Auth Refactor");
		expect(result).toContain("## Findings");
		expect(result).toContain("## Conclusion");
	});

	it("uses 'standalone' when no plan name", () => {
		const result = renderResearchDoc("General topic");
		expect(result).toContain("> Plan: standalone");
	});
});

describe("renderReviewDoc", () => {
	it("generates review doc with round and plan name", () => {
		const result = renderReviewDoc(1, "Auth Refactor");
		expect(result).toContain("# Code Review — Round 1");
		expect(result).toContain("> Plan: Auth Refactor");
		expect(result).toContain("## Changes Reviewed");
		expect(result).toContain("## Findings");
		expect(result).toContain("## Response");
	});

	it("uses 'unknown' when no plan name", () => {
		const result = renderReviewDoc(3);
		expect(result).toContain("# Code Review — Round 3");
		expect(result).toContain("> Plan: unknown");
	});
});

describe("renderLogHeader", () => {
	it("generates log header", () => {
		const result = renderLogHeader();
		expect(result).toContain("# Plan Log");
		expect(result).toContain("Append-only");
	});
});
