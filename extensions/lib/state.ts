import fs from "node:fs";
import path from "node:path";
import { activeDir, pendingDir, doneDir, plansDir, ensureDir, safeDestPath } from "./utils.js";
import { parseSteps } from "./format.js";
import type { PlanEntry, SessionState } from "./types.js";

/** Shared mutable session state. */
export const session: SessionState = {
	focusedPlan: undefined,
	planGate: undefined,
};

/** Returns all plans in active/. */
export function getActivePlans(cwd: string): string[] {
	const dir = activeDir(cwd);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => path.join(dir, f));
}

/** Returns the single plan in active/ if there is exactly one, or undefined. */
export function getActivePlan(cwd: string): string | undefined {
	const plans = getActivePlans(cwd);
	return plans.length === 1 ? plans[0] : undefined;
}

/** Move a specific active plan to pending/. Validates the plan is in active/. */
export function parkActivePlan(cwd: string, planPath: string) {
	const parentDir = path.basename(path.dirname(planPath));
	if (parentDir !== "active") throw new Error(`Can only deactivate plans in active/, not ${parentDir}/: ${planPath}`);
	const dest = safeDestPath(path.join(pendingDir(cwd), path.basename(planPath)));
	ensureDir(pendingDir(cwd));
	fs.renameSync(planPath, dest);
}

export function resolvePlanArg(planPath: string | undefined, cwd: string, focused?: string): string {
	const activePlans = getActivePlans(cwd);
	const isActive = (p: string) => activePlans.some((a) => path.resolve(a) === path.resolve(p));

	if (planPath) {
		const abs = path.isAbsolute(planPath) ? planPath : path.resolve(cwd, planPath);
		if (!isActive(abs)) throw new Error(`Plan is not active: ${abs}\nActive plans:\n${activePlans.map((p) => `  ${p}`).join("\n") || "  (none)"}`);
		return abs;
	}
	if (focused) {
		if (isActive(focused)) return focused;
		throw new Error(`Focused plan is no longer active: ${focused}\nUse plan_focus to rebind, or pass plan_path.`);
	}
	if (activePlans.length === 0) throw new Error("No active plan. Use plan_activate to set one, or pass plan_path explicitly.");
	if (activePlans.length > 1) throw new Error(`Multiple active plans. Use plan_focus to bind this session, or pass plan_path:\n${activePlans.map((p) => `  ${p}`).join("\n")}`);
	return activePlans[0];
}

/** Extract planPath from a prompt string (for child worker gate). Only matches .pi/plans/ paths. */
export function extractPlanPath(prompt: string): string | undefined {
	const m = prompt.match(/planPath\s*[:=]\s*`?([^\s`]*\.pi\/plans\/[^\s`]*\.md)`?/i)
		?? prompt.match(/(\/[^\s`"']*\.pi\/plans\/[^\s`"']*\.md)/);
	return m?.[1];
}

export function isReadOnlyTool(name: string): boolean {
	return ["read", "list", "ls", "grep", "glob", "find", "plan_list", "plan_brainstorm"].includes(name);
}

/** Derive status from the plan's parent directory name. */
export function statusFromPath(planPath: string): string {
	const dir = path.basename(path.dirname(planPath));
	if (dir === "active") return "active";
	if (dir === "pending") return "pending";
	if (dir === "done") return "done";
	return "unknown";
}

export function planSummary(planPath: string): string {
	const content = fs.readFileSync(planPath, "utf-8");
	const steps = parseSteps(content);
	const done = steps.filter((s) => s.done).length;
	const total = steps.length;
	const status = statusFromPath(planPath);
	const titleMatch = content.match(/^# (.+)/m);
	const title = titleMatch?.[1] ?? path.basename(planPath, ".md");
	const current = steps.find((s) => s.isCurrent);
	const currentText = current ? ` → ${current.text}` : "";
	return `[${status}] ${done}/${total} ${title}${currentText}`;
}

export function listAllPlans(cwd: string, statusFilter?: string): PlanEntry[] {
	const dirs = [activeDir(cwd), pendingDir(cwd), doneDir(cwd)];
	const results: { name: string; path: string; summary: string; isActive: boolean }[] = [];

	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
			const fullPath = path.join(dir, f);
			const summary = planSummary(fullPath);
			const isActive = path.basename(dir) === "active";
			results.push({ name: f.replace(/\.md$/, ""), path: fullPath, summary, isActive });
		}
	}

	return results
		.filter((p) => !statusFilter || p.summary.startsWith(`[${statusFilter}]`))
		.sort((a, b) => {
			if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
			return b.name.localeCompare(a.name);
		})
		.map((p) => ({
			name: p.name,
			path: p.path,
			summary: (p.isActive ? "● " : "  ") + p.summary,
		}));
}
