import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { slugify, safeDestPath, validatePlanPath, extractSlugFromPlanPath } from "../extensions/lib/utils.js";

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
		const dest = path.join(tmpDir, "test.md");
		expect(safeDestPath(dest)).toBe(dest);
	});

	it("appends -2 when file exists", () => {
		const dest = path.join(tmpDir, "test.md");
		fs.writeFileSync(dest, "");
		expect(safeDestPath(dest)).toBe(path.join(tmpDir, "test-2.md"));
	});

	it("increments suffix until non-conflicting", () => {
		const dest = path.join(tmpDir, "test.md");
		fs.writeFileSync(dest, "");
		fs.writeFileSync(path.join(tmpDir, "test-2.md"), "");
		fs.writeFileSync(path.join(tmpDir, "test-3.md"), "");
		expect(safeDestPath(dest)).toBe(path.join(tmpDir, "test-4.md"));
	});
});

describe("validatePlanPath", () => {
	let tmpDir: string;

	beforeEach(() => {
		// Use realpathSync to resolve macOS /var -> /private/var symlinks
		tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-validate-")));
		// Create a fake .git so findProjectRoot works
		fs.mkdirSync(path.join(tmpDir, ".git"));
		fs.mkdirSync(path.join(tmpDir, ".pi", "plans", "active"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("accepts valid plan path", () => {
		expect(() => validatePlanPath(
			path.join(tmpDir, ".pi", "plans", "active", "test.md"),
			tmpDir,
		)).not.toThrow();
	});

	it("rejects path outside .pi/plans/", () => {
		expect(() => validatePlanPath(
			path.join(tmpDir, "README.md"),
			tmpDir,
		)).toThrow("not within .pi/plans/");
	});

	it("rejects non-.md files", () => {
		expect(() => validatePlanPath(
			path.join(tmpDir, ".pi", "plans", "active", "test.txt"),
			tmpDir,
		)).toThrow("must be .md");
	});
});

describe("extractSlugFromPlanPath", () => {
	it("extracts slug from timestamped filename", () => {
		expect(extractSlugFromPlanPath("/path/to/20260323-1430-auth-refactor.md")).toBe("auth-refactor");
	});

	it("returns full basename when no timestamp prefix", () => {
		expect(extractSlugFromPlanPath("/path/to/my-plan.md")).toBe("my-plan");
	});
});
