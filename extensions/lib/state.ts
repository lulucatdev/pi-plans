import fs from "node:fs";
import path from "node:path";
import { activeDir, pendingDir, doneDir, abortedDir, ensureDir, safeDestPath, planFile, logFile, validatePlanPath, ts, slugify } from "./utils.js";
import { parseSteps, appendLog, renderDraftPlan, renderLogHeader, clearVerificationMarkers, hasVerified } from "./format.js";
import type { PlanEntry, SessionState } from "./types.js";

/** Shared mutable session state. */
export const session: SessionState = {
	focusedPlan: undefined,
	planGate: undefined,
};

/** Returns true if the given directory is a valid plan folder (contains plan.md). */
function isPlanDir(dirPath: string): boolean {
	try {
		const stat = fs.statSync(dirPath);
		return stat.isDirectory() && fs.existsSync(planFile(dirPath));
	} catch {
		return false;
	}
}

/** Returns all plan folders in active/. */
export function getActivePlans(cwd: string): string[] {
	const dir = activeDir(cwd);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.map((f) => path.join(dir, f))
		.filter(isPlanDir);
}

/** Returns the single plan folder in active/ if there is exactly one, or undefined. */
export function getActivePlan(cwd: string): string | undefined {
	const plans = getActivePlans(cwd);
	return plans.length === 1 ? plans[0] : undefined;
}

/** Move a specific active plan folder to pending/. Validates the plan is in active/. Returns dest path. */
export function parkActivePlan(cwd: string, planPath: string): string {
	const parentDir = path.basename(path.dirname(planPath));
	if (parentDir !== "active") throw new Error(`Can only deactivate plans in active/, not ${parentDir}/: ${planPath}`);
	appendLog(logFile(planPath), "Plan deactivated.");
	const dest = safeDestPath(path.join(pendingDir(cwd), path.basename(planPath)));
	ensureDir(pendingDir(cwd));
	fs.renameSync(planPath, dest);
	return dest;
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

/** Extract planPath from a prompt string (for child worker gate). Only matches .pi/plans/ folder paths. Handles paths with spaces when backtick-quoted. */
export function extractPlanPath(prompt: string): string | undefined {
	const m = prompt.match(/planPath\s*[:=]\s*`([^`]*\.pi\/plans\/[^`]+?)\/?`/i)      // backtick-quoted (handles spaces)
		?? prompt.match(/planPath\s*[:=]\s*([^\s`]*\.pi\/plans\/[^\s`]+?)\/?(?=[\s`]|$)/i) // unquoted (no spaces)
		?? prompt.match(/`([^`]*\.pi\/plans\/[^`]+?)\/?`/)                                 // any backtick-quoted .pi/plans path
		?? prompt.match(/(\/[^\s`"']*\.pi\/plans\/[^\s`"']+?)\/?(?=[\s`"']|$)/);           // bare absolute path (no spaces)
	return m?.[1];
}

export function isReadOnlyTool(name: string): boolean {
	return ["read", "list", "ls", "grep", "glob", "find", "plan_list", "plan_brainstorm"].includes(name);
}

/** Derive status from the plan folder's parent directory name. */
export function statusFromPath(planPath: string): string {
	const dir = path.basename(path.dirname(planPath));
	if (dir === "active") return "active";
	if (dir === "pending") return "pending";
	if (dir === "done") return "done";
	if (dir === "aborted") return "aborted";
	return "unknown";
}

export function planSummary(planPath: string): string {
	const content = fs.readFileSync(planFile(planPath), "utf-8");
	const steps = parseSteps(content);
	const done = steps.filter((s) => s.done).length;
	const total = steps.length;
	const status = statusFromPath(planPath);
	const titleMatch = content.match(/^# (.+)/m);
	const title = titleMatch?.[1] ?? path.basename(planPath);
	const current = steps.find((s) => s.isCurrent);
	const currentText = current ? ` → ${current.text}` : "";
	return `[${status}] ${done}/${total} ${title}${currentText}`;
}

/** Create a draft plan folder in pending/, with minimal plan.md + log.md. Returns the plan path. */
export function createDraftPlan(cwd: string, topic: string, session: SessionState): string {
	const slug = slugify(topic || "plan");
	const folderName = `${ts()}-${slug}`;
	const dir = pendingDir(cwd);
	ensureDir(dir);
	const planDir = safeDestPath(path.join(dir, folderName));
	ensureDir(planDir);
	const title = (topic || "Plan").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
	fs.writeFileSync(planFile(planDir), renderDraftPlan(title), "utf-8");
	fs.writeFileSync(logFile(planDir), renderLogHeader(), "utf-8");
	appendLog(logFile(planDir), "Draft plan created.");
	session.focusedPlan = planDir;
	return planDir;
}

// -- Shared lifecycle transitions -------------------------------------------

/** Finish a plan: validate prerequisites, log, move to done/. Returns dest path. */
export function finishPlan(planPath: string, cwd: string, session: SessionState, summary?: string): string {
	const content = fs.readFileSync(planFile(planPath), "utf-8");
	const steps = parseSteps(content);
	const incomplete = steps.filter((s) => !s.done);
	if (incomplete.length > 0) {
		throw new Error(`Cannot finish: ${incomplete.length} step(s) still incomplete. Complete all steps or use plan_abort.`);
	}
	if (!hasVerified(content)) {
		throw new Error("Cannot finish: no verification record found. Run plan_prepare_to_verify and plan_verify first, or use plan_abort to skip.");
	}
	appendLog(logFile(planPath), summary ? `Plan completed. ${summary}` : "Plan completed.");
	const dest = safeDestPath(path.join(doneDir(cwd), path.basename(planPath)));
	ensureDir(doneDir(cwd));
	fs.renameSync(planPath, dest);
	if (session.focusedPlan && path.resolve(session.focusedPlan) === path.resolve(planPath)) session.focusedPlan = undefined;
	return dest;
}

/** Abort a plan: log reason, move to aborted/. Returns dest path. */
export function abortPlan(planPath: string, cwd: string, session: SessionState, reason?: string): string {
	appendLog(logFile(planPath), reason ? `Plan aborted. Reason: ${reason}` : "Plan aborted.");
	const dest = safeDestPath(path.join(abortedDir(cwd), path.basename(planPath)));
	ensureDir(abortedDir(cwd));
	fs.renameSync(planPath, dest);
	if (session.focusedPlan && path.resolve(session.focusedPlan) === path.resolve(planPath)) session.focusedPlan = undefined;
	return dest;
}

/** Resume a plan from pending/done/aborted to active/. Clears stale verification. Returns dest path. */
export function resumePlan(planPath: string, cwd: string, reason?: string): string {
	validatePlanPath(planPath, cwd);
	if (!fs.existsSync(planPath)) throw new Error(`Plan not found: ${planPath}`);
	const parentDir = path.basename(path.dirname(planPath));
	if (parentDir === "active") throw new Error(`Plan is already active: ${planPath}`);
	if (parentDir !== "pending" && parentDir !== "done" && parentDir !== "aborted") {
		throw new Error(`Can only resume plans from pending/, done/, or aborted/, not ${parentDir}/`);
	}
	let content = fs.readFileSync(planFile(planPath), "utf-8");
	content = clearVerificationMarkers(content);
	fs.writeFileSync(planFile(planPath), content, "utf-8");
	appendLog(logFile(planPath), reason ? `Plan resumed. ${reason}` : "Plan resumed.");
	const dest = safeDestPath(path.join(activeDir(cwd), path.basename(planPath)));
	ensureDir(activeDir(cwd));
	fs.renameSync(planPath, dest);
	return dest;
}

/** Activate a plan from pending/ to active/. Returns dest path. */
export function activatePlan(planPath: string, cwd: string): string {
	validatePlanPath(planPath, cwd);
	if (!fs.existsSync(planPath)) throw new Error(`Plan not found: ${planPath}`);
	const parentDir = path.basename(path.dirname(planPath));
	if (parentDir === "active") throw new Error(`Already active: ${planPath}`);
	if (parentDir !== "pending") throw new Error(`Can only activate plans from pending/, not ${parentDir}/. Use plan_resume for done/ or aborted/ plans.`);
	appendLog(logFile(planPath), "Plan activated.");
	const dest = safeDestPath(path.join(activeDir(cwd), path.basename(planPath)));
	ensureDir(activeDir(cwd));
	fs.renameSync(planPath, dest);
	return dest;
}

export function listAllPlans(cwd: string, statusFilter?: string): PlanEntry[] {
	const dirs = [activeDir(cwd), pendingDir(cwd), doneDir(cwd), abortedDir(cwd)];
	const results: { name: string; path: string; summary: string; isActive: boolean }[] = [];

	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const f of fs.readdirSync(dir)) {
			const fullPath = path.join(dir, f);
			if (!isPlanDir(fullPath)) continue;
			const summary = planSummary(fullPath);
			const isActive = path.basename(dir) === "active";
			results.push({ name: f, path: fullPath, summary, isActive });
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
