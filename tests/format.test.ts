import { describe, it, expect } from "vitest";
import { parseSteps, completeStep, addStep, appendLog, parseManualAcceptance, renderPlan, renderResearchDoc } from "../extensions/lib/format.js";

const samplePlan = `# Test Plan

> Created: 2026-03-23 14:00

**Goal:** Test the parser

---

## Steps

- [x] Step one done
- [ ] **Step two current** ← current
- [ ] Step three pending

## Verification

### Automated Checks
- \`npm test\`

### Manual Acceptance
- [ ] Feature works correctly
- [ ] No regressions

## Log

**2026-03-23 14:00** — Plan created.
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
		// Manual Acceptance has checkboxes too — they should NOT be parsed
		const steps = parseSteps(samplePlan);
		const texts = steps.map((s) => s.text);
		expect(texts).not.toContain("Feature works correctly");
		expect(texts).not.toContain("No regressions");
	});

	it("handles case-insensitive ## Steps heading", () => {
		const plan = "## steps\n\n- [ ] A step\n\n## Log\n";
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
		const result = completeStep(samplePlan, 1); // complete step 2 (0-indexed)
		const steps = parseSteps(result);
		expect(steps[1].done).toBe(true);
		expect(steps[1].isCurrent).toBe(false);
		expect(steps[2].isCurrent).toBe(true);
	});

	it("allows completing non-current step (out of order)", () => {
		// Complete step 3 (index 2) while step 2 is current — should work
		const result = completeStep(samplePlan, 2);
		const steps = parseSteps(result);
		expect(steps[2].done).toBe(true);
		// Should not have multiple current markers
		const currentSteps = steps.filter((s) => s.isCurrent);
		expect(currentSteps.length).toBeLessThanOrEqual(1);
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
		const allDone = `## Steps\n\n- [x] Done one\n- [x] Done two\n\n## Log\n`;
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
	it("appends a timestamped entry", () => {
		const result = appendLog("## Log\n\nOld entry.\n", "New entry.");
		expect(result).toContain("New entry.");
		expect(result).toMatch(/\*\*\d{4}-\d{2}-\d{2} \d{2}:\d{2}\*\* — New entry\./);
	});
});

describe("parseManualAcceptance", () => {
	it("extracts items from ### Manual Acceptance", () => {
		const items = parseManualAcceptance(samplePlan);
		expect(items).toEqual(["Feature works correctly", "No regressions"]);
	});

	it("handles case-insensitive heading", () => {
		const plan = "### manual acceptance\n- [ ] Item A\n- Item B\n## Log\n";
		const items = parseManualAcceptance(plan);
		expect(items).toEqual(["Item A", "Item B"]);
	});

	it("returns empty array when section missing", () => {
		const items = parseManualAcceptance("# Just a title\n");
		expect(items).toEqual([]);
	});

	it("handles numbered lists", () => {
		const plan = "### Manual Acceptance\n1. First\n2. Second\n## Log\n";
		const items = parseManualAcceptance(plan);
		expect(items).toEqual(["First", "Second"]);
	});
});

describe("renderPlan", () => {
	it("generates plan with goal and steps", () => {
		const result = renderPlan("Test", "Build a thing", ["Step A", "Step B"]);
		expect(result).toContain("# Test");
		expect(result).toContain("**Goal:** Build a thing");
		expect(result).toContain("- [ ] **Step A** ← current");
		expect(result).toContain("- [ ] Step B");
		expect(result).toContain("## Steps");
		expect(result).toContain("## Log");
	});

	it("includes architecture when provided", () => {
		const result = renderPlan("T", "G", ["S"], "Use microservices");
		expect(result).toContain("**Architecture:** Use microservices");
	});

	it("includes verification section when provided", () => {
		const result = renderPlan("T", "G", ["S"], undefined, {
			automated: ["npm test"],
			manual: ["Check UI"],
		});
		expect(result).toContain("### Automated Checks");
		expect(result).toContain("- `npm test`");
		expect(result).toContain("### Manual Acceptance");
		expect(result).toContain("- [ ] Check UI");
	});

	it("omits verification section when empty", () => {
		const result = renderPlan("T", "G", ["S"]);
		expect(result).not.toContain("## Verification");
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
