import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { slugify, safeDestPath, validatePlanPath, extractSlugFromPlanPath, planFile, logFile } from "../extensions/lib/utils.js";

describe("slugify", () => {
	it("converts text to lowercase hyphenated slug", () => {
		expect(slugify("Auth Refactor")).toBe("auth-refactor");
	});

	it("removes special characters", () => {
		expect(slugify("hello@world!")).toBe("hello-world");
	});

	it("truncates to 48 characters", () => {
		const long = "a".repeat(100);
		expect(slugify(long).length).toBeLessThanOrEqual(48);
	});

	it("returns 'plan' for empty/non-ascii input", () => {
		expect(slugify("")).toBe("plan");
		expect(slugify("中文名称")).toBe("plan");
	});

	it("strips leading/trailing hyphens", () => {
		expect(slugify("--test--")).toBe("test");
	});
});

describe("safeDestPath", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns original path when no conflict", () => {
		const dest = path.join(tmpDir, "test-plan");
		expect(safeDestPath(dest)).toBe(dest);
	});

	it("appends -2 when path exists (folder)", () => {
		const dest = path.join(tmpDir, "test-plan");
		fs.mkdirSync(dest);
		expect(safeDestPath(dest)).toBe(path.join(tmpDir, "test-plan-2"));
	});

	it("increments suffix until non-conflicting", () => {
		const dest = path.join(tmpDir, "test-plan");
		fs.mkdirSync(dest);
		fs.mkdirSync(path.join(tmpDir, "test-plan-2"));
		fs.mkdirSync(path.join(tmpDir, "test-plan-3"));
		expect(safeDestPath(dest)).toBe(path.join(tmpDir, "test-plan-4"));
	});
});

describe("validatePlanPath", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-validate-")));
		fs.mkdirSync(path.join(tmpDir, ".git"));
		fs.mkdirSync(path.join(tmpDir, ".pi", "plans", "active", "20260323074203-test"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("accepts valid plan folder path", () => {
		expect(() => validatePlanPath(
			path.join(tmpDir, ".pi", "plans", "active", "20260323074203-test"),
			tmpDir,
		)).not.toThrow();
	});

	it("rejects path outside .pi/plans/", () => {
		expect(() => validatePlanPath(
			path.join(tmpDir, "some-other-dir"),
			tmpDir,
		)).toThrow("not within .pi/plans/");
	});
});

describe("extractSlugFromPlanPath", () => {
	it("extracts slug from timestamped folder name", () => {
		expect(extractSlugFromPlanPath("/path/to/20260323074203-auth-refactor")).toBe("auth-refactor");
	});

	it("returns full name when no timestamp prefix", () => {
		expect(extractSlugFromPlanPath("/path/to/my-plan")).toBe("my-plan");
	});
});

describe("planFile / logFile", () => {
	it("returns plan.md path inside folder", () => {
		expect(planFile("/path/to/plan-folder")).toBe("/path/to/plan-folder/plan.md");
	});

	it("returns log.md path inside folder", () => {
		expect(logFile("/path/to/plan-folder")).toBe("/path/to/plan-folder/log.md");
	});
});
