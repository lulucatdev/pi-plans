import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir: string) {
	fs.mkdirSync(dir, { recursive: true });
}

export function slugify(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "plan";
}

export function ts(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function logTs(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function findProjectRoot(cwd: string): string {
	let cur = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(cur, ".git"))) return cur;
		const parent = path.dirname(cur);
		if (parent === cur) return path.resolve(cwd);
		cur = parent;
	}
}

export function plansDir(cwd: string): string {
	return path.join(findProjectRoot(cwd), ".pi", "plans");
}

export function activeDir(cwd: string): string {
	return path.join(plansDir(cwd), "active");
}

export function pendingDir(cwd: string): string {
	return path.join(plansDir(cwd), "pending");
}

export function doneDir(cwd: string): string {
	return path.join(plansDir(cwd), "done");
}

export function abortedDir(cwd: string): string {
	return path.join(plansDir(cwd), "aborted");
}

export function planFile(planDir: string): string {
	return path.join(planDir, "plan.md");
}

export function logFile(planDir: string): string {
	return path.join(planDir, "log.md");
}

export function researchDir(cwd: string, planSlug?: string): string {
	return path.join(plansDir(cwd), "research", planSlug ?? "_standalone");
}

export function planResearchDir(planDir: string): string {
	return path.join(planDir, "research");
}

/** Extract slug from plan folder name: "20260323074203-auth-refactor" -> "auth-refactor" */
export function extractSlugFromPlanPath(planPath: string): string {
	const folderName = path.basename(planPath);
	// Remove YYYYMMDDHHmmss- prefix (14 digits + hyphen)
	return folderName.replace(/^\d{14}-/, "") || folderName;
}

/** Return a non-conflicting path. If dest exists (file or directory), appends -2, -3, etc. */
export function safeDestPath(dest: string): string {
	if (!fs.existsSync(dest)) return dest;
	let i = 2;
	while (fs.existsSync(`${dest}-${i}`)) i++;
	return `${dest}-${i}`;
}

/** Validate that a path is a directory within .pi/plans/. Resolves symlinks. */
export function validatePlanPath(filePath: string, cwd: string): void {
	const abs = path.resolve(filePath);
	const plans = path.resolve(plansDir(cwd));
	// Resolve symlinks if the path exists to prevent symlink escape
	const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
	const realPlans = fs.existsSync(plans) ? fs.realpathSync(plans) : plans;
	if (!real.startsWith(realPlans + path.sep) && real !== realPlans) {
		throw new Error(`Path is not within .pi/plans/: ${filePath}`);
	}
}
