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
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
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

/** Return a non-conflicting path. If dest exists, appends -2, -3, etc. before .md */
export function safeDestPath(dest: string): string {
	if (!fs.existsSync(dest)) return dest;
	const dir = path.dirname(dest);
	const ext = path.extname(dest);
	const base = path.basename(dest, ext);
	let i = 2;
	while (fs.existsSync(path.join(dir, `${base}-${i}${ext}`))) i++;
	return path.join(dir, `${base}-${i}${ext}`);
}

/** Validate that a path is within .pi/plans/ and is a .md file. Resolves symlinks. */
export function validatePlanPath(filePath: string, cwd: string): void {
	const abs = path.resolve(filePath);
	const plans = path.resolve(plansDir(cwd));
	// Resolve symlinks if the file exists to prevent symlink escape
	const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
	const realPlans = fs.existsSync(plans) ? fs.realpathSync(plans) : plans;
	if (!real.startsWith(realPlans + path.sep) && real !== realPlans) {
		throw new Error(`Path is not within .pi/plans/: ${filePath}`);
	}
	if (!real.endsWith(".md")) {
		throw new Error(`Not a plan file (must be .md): ${filePath}`);
	}
}
