/**
 * Plan Mode Extension
 *
 * A text-based project manager. Plans are plain markdown files stored under
 * <project>/.pi/plans/{active,pending,done}/YYYYMMDD-HHmm-<slug>.md with
 * checkbox steps and a timestamped log. Directory = status. The agent reads,
 * updates, and tracks the plan as a living document throughout development.
 *
 * Tools:  plan_create, plan_update, plan_list, plan_focus
 * Command: /plans
 */

import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string) {
	fs.mkdirSync(dir, { recursive: true });
}

function slugify(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "plan";
}

function ts(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function logTs(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function findProjectRoot(cwd: string): string {
	let cur = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(cur, ".git"))) return cur;
		const parent = path.dirname(cur);
		if (parent === cur) return path.resolve(cwd);
		cur = parent;
	}
}

function plansDir(cwd: string): string {
	return path.join(findProjectRoot(cwd), ".pi", "plans");
}

function activeDir(cwd: string): string {
	return path.join(plansDir(cwd), "active");
}

function pendingDir(cwd: string): string {
	return path.join(plansDir(cwd), "pending");
}

function doneDir(cwd: string): string {
	return path.join(plansDir(cwd), "done");
}

/** Returns the single plan in active/, or undefined if empty. */
function getActivePlan(cwd: string): string | undefined {
	const dir = activeDir(cwd);
	if (!fs.existsSync(dir)) return undefined;
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
	return files.length > 0 ? path.join(dir, files[0]) : undefined;
}

/** Move the current active plan to pending/ (if one exists). */
function parkActivePlan(cwd: string) {
	const current = getActivePlan(cwd);
	if (!current) return;
	const dest = path.join(pendingDir(cwd), path.basename(current));
	ensureDir(pendingDir(cwd));
	fs.renameSync(current, dest);
}

function resolvePlanArg(planPath: string | undefined, cwd: string): string {
	if (planPath) {
		return path.isAbsolute(planPath) ? planPath : path.resolve(cwd, planPath);
	}
	const active = getActivePlan(cwd);
	if (!active) throw new Error("No active plan. Use plan_focus to set one, or pass plan_path explicitly.");
	return active;
}

// ---------------------------------------------------------------------------
// Plan file format
// ---------------------------------------------------------------------------

function renderPlan(title: string, goal: string, steps: string[]): string {
	const lines: string[] = [];
	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`> Created: ${logTs()}`);
	lines.push("");
	lines.push(goal);
	lines.push("");
	lines.push("## Steps");
	lines.push("");
	for (let i = 0; i < steps.length; i++) {
		const marker = i === 0 ? "**" : "";
		const arrow = i === 0 ? " ← current" : "";
		lines.push(`- [ ] ${marker}${steps[i]}${marker}${arrow}`);
	}
	lines.push("");
	lines.push("## Log");
	lines.push("");
	lines.push(`**${logTs()}** — Plan created.`);
	lines.push("");
	return lines.join("\n");
}

/** Parse step lines from plan content. Returns {index, done, text, isCurrent} for each. */
function parseSteps(content: string): { index: number; done: boolean; text: string; isCurrent: boolean; lineNum: number }[] {
	const lines = content.split("\n");
	const steps: { index: number; done: boolean; text: string; isCurrent: boolean; lineNum: number }[] = [];
	let stepIdx = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^- \[([ xX])\] (.+)/);
		if (m) {
			const done = m[1] !== " ";
			const isCurrent = lines[i].includes("← current");
			const text = m[2].replace(/\*\*/g, "").replace(/\s*← current\s*$/, "").trim();
			steps.push({ index: stepIdx, done, text, isCurrent, lineNum: i });
			stepIdx++;
		}
	}
	return steps;
}

function completeStep(content: string, stepIndex: number): string {
	const lines = content.split("\n");
	const steps = parseSteps(content);
	const step = steps[stepIndex];
	if (!step) throw new Error(`Step ${stepIndex + 1} not found. Plan has ${steps.length} steps.`);
	if (step.done) throw new Error(`Step ${stepIndex + 1} is already completed.`);

	// Mark the step as done, remove current marker and bold
	lines[step.lineNum] = `- [x] ${step.text}`;

	// Find next incomplete step and mark it as current
	const nextIncomplete = steps.find((s) => s.index > stepIndex && !s.done);
	if (nextIncomplete) {
		const nextText = nextIncomplete.text;
		lines[nextIncomplete.lineNum] = `- [ ] **${nextText}** ← current`;
	}

	return lines.join("\n");
}

function addStep(content: string, text: string, afterIndex?: number): string {
	const lines = content.split("\n");
	const steps = parseSteps(content);

	if (afterIndex !== undefined) {
		const after = steps[afterIndex];
		if (!after) throw new Error(`Step ${afterIndex + 1} not found.`);
		lines.splice(after.lineNum + 1, 0, `- [ ] ${text}`);
	} else {
		// Append after last step
		const lastStep = steps[steps.length - 1];
		if (lastStep) {
			lines.splice(lastStep.lineNum + 1, 0, `- [ ] ${text}`);
		} else {
			// No steps section found, append before ## Log
			const logIdx = lines.findIndex((l) => l.startsWith("## Log"));
			const insertAt = logIdx >= 0 ? logIdx : lines.length;
			lines.splice(insertAt, 0, `- [ ] ${text}`, "");
		}
	}

	return lines.join("\n");
}

function appendLog(content: string, message: string): string {
	// Append before trailing whitespace
	const trimmed = content.trimEnd();
	return `${trimmed}\n\n**${logTs()}** — ${message}\n`;
}

/** Derive status from the plan's parent directory name. */
function statusFromPath(planPath: string): string {
	const dir = path.basename(path.dirname(planPath));
	if (dir === "active") return "active";
	if (dir === "pending") return "pending";
	if (dir === "done") return "done";
	return "unknown";
}

function planSummary(planPath: string): string {
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

function listAllPlans(cwd: string, statusFilter?: string): { name: string; path: string; summary: string }[] {
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

// For plan-read-first gate
function extractPlanPath(prompt: string): string | undefined {
	const m = prompt.match(/planPath\s*[:=]\s*`?([^\s`]+\.md)`?/i)
		?? prompt.match(/(\/[^\s`"']*\.md)/);
	return m?.[1];
}

function isReadOnlyTool(name: string): boolean {
	return ["read", "list", "ls", "grep", "glob", "find", "plan_list", "plan_focus"].includes(name);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function planModeExtension(pi: ExtensionAPI) {
	let planGate: { planPath: string; satisfied: boolean } | undefined;

	// -- plan_create ---------------------------------------------------------

	pi.registerTool({
		name: "plan_create",
		label: "plan create",
		description:
			"Create a new plan document with a goal and numbered steps. " +
			"The plan is saved and the user is prompted to choose: execute now, save for later, or discuss further. " +
			"Use after researching the codebase and agreeing on the approach with the user.",
		parameters: Type.Object({
			name: Type.String({ description: "Short plan name, e.g. 'auth-refactor'" }),
			goal: Type.String({ description: "1-3 sentence description of the goal" }),
			steps: Type.Array(Type.String(), { description: "Ordered list of implementation steps" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Write to pending/ first; user decides what to do next
			const dir = pendingDir(ctx.cwd);
			ensureDir(dir);
			const filename = `${ts()}-${slugify(params.name)}.md`;
			const planPath = path.join(dir, filename);
			const title = params.name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
			fs.writeFileSync(planPath, renderPlan(title, params.goal, params.steps), "utf-8");

			const choice = await ctx.ui.select("Plan created. What next?", [
				"Start now",
				"Save for later",
				"I have feedback",
			]);

			if (choice === "Start now") {
				parkActivePlan(ctx.cwd);
				const dest = path.join(activeDir(ctx.cwd), filename);
				ensureDir(activeDir(ctx.cwd));
				fs.renameSync(planPath, dest);
				return {
					content: [{ type: "text", text: `Plan created and focused: ${dest}\nProceeding with execution.` }],
					details: { planPath: dest },
				};
			}

			if (choice === "Save for later") {
				return {
					content: [{ type: "text", text: `Plan saved for later: ${planPath}\nUse plan_focus or /focus-plan to activate it when ready.` }],
					details: { planPath },
				};
			}

			// "I have feedback" or dismissed — ask for input
			const feedback = await ctx.ui.input("What would you like to change?", "e.g. step 3 should come before step 2");
			if (feedback) {
				pi.sendMessage(
					{
						customType: "plan-feedback",
						content: `The user has feedback on the plan at ${planPath}:\n\n${feedback}\n\nRead the plan, discuss with the user, and update or recreate it.`,
						display: true,
					},
					{ triggerTurn: true },
				);
				return {
					content: [{ type: "text", text: `Plan saved: ${planPath}\nDiscussing feedback with user.` }],
					details: { planPath },
				};
			}

			return {
				content: [{ type: "text", text: `Plan saved: ${planPath}` }],
				details: { planPath },
			};
		},
	});

	// -- plan_update ---------------------------------------------------------

	pi.registerTool({
		name: "plan_update",
		label: "plan update",
		description:
			"Update the active plan. Can complete a step, add a step, or append a log entry. " +
			"Multiple actions can be combined in one call. " +
			"Operates on the focused plan by default.",
		parameters: Type.Object({
			complete_step: Type.Optional(Type.Number({
				description: "1-based step number to mark as complete. Automatically advances the current marker.",
			})),
			add_step: Type.Optional(Type.String({ description: "Text of a new step to add" })),
			after_step: Type.Optional(Type.Number({ description: "1-based step number to insert the new step after (default: append at end)" })),
			log: Type.Optional(Type.String({ description: "A timestamped log entry to append (progress, decisions, notes)" })),
			plan_path: Type.Optional(Type.String({ description: "Explicit plan file path (default: active plan)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanArg(params.plan_path, ctx.cwd);
			let content = fs.readFileSync(planPath, "utf-8");
			const actions: string[] = [];

			if (params.complete_step !== undefined) {
				content = completeStep(content, params.complete_step - 1);
				actions.push(`completed step ${params.complete_step}`);
			}

			if (params.add_step) {
				const afterIdx = params.after_step !== undefined ? params.after_step - 1 : undefined;
				content = addStep(content, params.add_step, afterIdx);
				actions.push(`added step "${params.add_step}"`);
			}

			if (params.log) {
				content = appendLog(content, params.log);
				actions.push("added log entry");
			}

			fs.writeFileSync(planPath, content, "utf-8");
			return {
				content: [{ type: "text", text: `Updated plan: ${actions.join(", ")}\n${planPath}` }],
				details: { planPath },
			};
		},
	});

	// -- plan_finish ---------------------------------------------------------

	pi.registerTool({
		name: "plan_finish",
		label: "plan finish",
		description:
			"Mark the active plan as completed. Logs a completion entry and moves it to done/.",
		parameters: Type.Object({
			summary: Type.Optional(Type.String({ description: "Brief completion summary to log" })),
			plan_path: Type.Optional(Type.String({ description: "Explicit plan file path (default: active plan)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanArg(params.plan_path, ctx.cwd);
			let content = fs.readFileSync(planPath, "utf-8");

			const logMsg = params.summary ? `Plan completed. ${params.summary}` : "Plan completed.";
			content = appendLog(content, logMsg);

			const dest = path.join(doneDir(ctx.cwd), path.basename(planPath));
			ensureDir(doneDir(ctx.cwd));
			fs.writeFileSync(dest, content, "utf-8");
			fs.unlinkSync(planPath);
			return {
				content: [{ type: "text", text: `Plan completed: ${dest}` }],
				details: { planPath: dest },
			};
		},
	});

	// -- plan_abort -----------------------------------------------------------

	pi.registerTool({
		name: "plan_abort",
		label: "plan abort",
		description:
			"Abort the active plan. Logs the reason and moves it to done/.",
		parameters: Type.Object({
			reason: Type.Optional(Type.String({ description: "Why the plan was aborted" })),
			plan_path: Type.Optional(Type.String({ description: "Explicit plan file path (default: active plan)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanArg(params.plan_path, ctx.cwd);
			let content = fs.readFileSync(planPath, "utf-8");

			const logMsg = params.reason ? `Plan aborted. Reason: ${params.reason}` : "Plan aborted.";
			content = appendLog(content, logMsg);

			const dest = path.join(doneDir(ctx.cwd), path.basename(planPath));
			ensureDir(doneDir(ctx.cwd));
			fs.writeFileSync(dest, content, "utf-8");
			fs.unlinkSync(planPath);
			return {
				content: [{ type: "text", text: `Plan aborted: ${dest}` }],
				details: { planPath: dest },
			};
		},
	});

	// -- plan_resume ----------------------------------------------------------

	pi.registerTool({
		name: "plan_resume",
		label: "plan resume",
		description:
			"Resume a pending or done plan. Moves it to active/, logs a resumption entry. " +
			"If another plan is already active, it is moved to pending/ first.",
		parameters: Type.Object({
			plan_path: Type.String({ description: "Path to the plan file (in pending/ or done/)" }),
			reason: Type.Optional(Type.String({ description: "Why the plan is being resumed" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = path.isAbsolute(params.plan_path) ? params.plan_path : path.resolve(ctx.cwd, params.plan_path);
			if (!fs.existsSync(planPath)) throw new Error(`Plan not found: ${planPath}`);

			let content = fs.readFileSync(planPath, "utf-8");
			const logMsg = params.reason ? `Plan resumed. ${params.reason}` : "Plan resumed.";
			content = appendLog(content, logMsg);

			parkActivePlan(ctx.cwd);
			const dest = path.join(activeDir(ctx.cwd), path.basename(planPath));
			ensureDir(activeDir(ctx.cwd));
			fs.writeFileSync(dest, content, "utf-8");
			fs.unlinkSync(planPath);

			const summary = planSummary(dest);
			return {
				content: [{ type: "text", text: `Resumed and focused: ${summary}\n${dest}` }],
				details: { planPath: dest },
			};
		},
	});

	// -- plan_list -----------------------------------------------------------

	pi.registerTool({
		name: "plan_list",
		label: "plan list",
		description: "List plan documents under .pi/plans/. Shows status, step progress, and current step for each plan.",
		parameters: Type.Object({
			status: Type.Optional(Type.String({ description: "Filter by status: active, pending, done" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const plans = listAllPlans(ctx.cwd, params.status);
			if (plans.length === 0) {
				return { content: [{ type: "text", text: `No plans found in ${plansDir(ctx.cwd)}` }] };
			}
			const text = plans.map((p) => `${p.summary}\n    ${p.path}`).join("\n");
			return { content: [{ type: "text", text }] };
		},
	});

	// -- plan_focus -----------------------------------------------------------

	pi.registerTool({
		name: "plan_focus",
		label: "plan focus",
		description:
			"Focus on a plan by moving it to active/. " +
			"If another plan is already active, it is moved to pending/ first. " +
			"The active plan is indicated with ● in plan_list.",
		parameters: Type.Object({
			plan_path: Type.String({ description: "Path to the plan file to focus on" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const abs = path.isAbsolute(params.plan_path) ? params.plan_path : path.resolve(ctx.cwd, params.plan_path);
			if (!fs.existsSync(abs)) throw new Error(`Plan not found: ${abs}`);
			// Already active — nothing to do
			if (path.dirname(abs) === activeDir(ctx.cwd)) {
				const summary = planSummary(abs);
				return { content: [{ type: "text", text: `Already focused: ${summary}\n${abs}` }] };
			}
			parkActivePlan(ctx.cwd);
			const dest = path.join(activeDir(ctx.cwd), path.basename(abs));
			ensureDir(activeDir(ctx.cwd));
			fs.renameSync(abs, dest);
			const summary = planSummary(dest);
			return {
				content: [{ type: "text", text: `Focused: ${summary}\n${dest}` }],
				details: { planPath: dest },
			};
		},
	});

	// -- Commands ------------------------------------------------------------

	pi.registerCommand("plans", {
		description: "List saved plans for the current project",
		handler: async (_args, ctx) => {
			const plans = listAllPlans(ctx.cwd);
			if (plans.length === 0) {
				ctx.ui.notify(`No plans in ${plansDir(ctx.cwd)}`, "info");
				return;
			}
			ctx.ui.notify(plans.map((p) => `${p.summary}\n  ${p.path}`).join("\n"), "info");
		},
	});

	pi.registerCommand("start-plan", {
		description: "Start a planning session: research, discuss, and create a tracked plan",
		handler: async (args, ctx) => {
			const topic = args?.trim() || "";
			const prompt = [
				"We are starting a planning session. Before writing any code:",
				"",
				"1. Research the codebase to understand the current state relevant to this task.",
				"2. Ask me clarifying questions if anything is ambiguous.",
				"3. Propose an approach and discuss it with me.",
				"4. Once we agree, call `plan_create` to persist the plan with concrete steps.",
				"",
				"The plan is a living document. We will update it as we work.",
				topic ? `\nTask: ${topic}` : "",
			].filter(Boolean).join("\n");

			pi.sendMessage(
				{ customType: "start-plan", content: prompt, display: true },
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("finish-plan", {
		description: "Mark the active plan as completed and move to done/",
		handler: async (args, ctx) => {
			const planPath = getActivePlan(ctx.cwd);
			if (!planPath) { ctx.ui.notify("No active plan", "warning"); return; }
			const summary = args?.trim() || undefined;
			let content = fs.readFileSync(planPath, "utf-8");
			content = appendLog(content, summary ? `Plan completed. ${summary}` : "Plan completed.");
			const dest = path.join(doneDir(ctx.cwd), path.basename(planPath));
			ensureDir(doneDir(ctx.cwd));
			fs.writeFileSync(dest, content, "utf-8");
			fs.unlinkSync(planPath);
			ctx.ui.notify(`Completed: ${planSummary(dest)}`, "info");
		},
	});

	pi.registerCommand("abort-plan", {
		description: "Abort the active plan and move to done/",
		handler: async (args, ctx) => {
			const planPath = getActivePlan(ctx.cwd);
			if (!planPath) { ctx.ui.notify("No active plan", "warning"); return; }
			const reason = args?.trim() || undefined;
			let content = fs.readFileSync(planPath, "utf-8");
			content = appendLog(content, reason ? `Plan aborted. Reason: ${reason}` : "Plan aborted.");
			const dest = path.join(doneDir(ctx.cwd), path.basename(planPath));
			ensureDir(doneDir(ctx.cwd));
			fs.writeFileSync(dest, content, "utf-8");
			fs.unlinkSync(planPath);
			ctx.ui.notify(`Aborted: ${dest}`, "info");
		},
	});

	pi.registerCommand("resume-plan", {
		description: "Resume a plan by path (e.g. /resume-plan .pi/plans/done/20260322-1730-auth.md)",
		handler: async (args, ctx) => {
			const raw = args?.trim();
			if (!raw) { ctx.ui.notify("Usage: /resume-plan <path>", "warning"); return; }
			const planPath = path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);
			if (!fs.existsSync(planPath)) { ctx.ui.notify(`Not found: ${planPath}`, "error"); return; }
			let content = fs.readFileSync(planPath, "utf-8");
			content = appendLog(content, "Plan resumed.");
			parkActivePlan(ctx.cwd);
			const dest = path.join(activeDir(ctx.cwd), path.basename(planPath));
			ensureDir(activeDir(ctx.cwd));
			fs.writeFileSync(dest, content, "utf-8");
			fs.unlinkSync(planPath);
			ctx.ui.notify(`Resumed and focused: ${planSummary(dest)}`, "info");
		},
	});

	pi.registerCommand("focus-plan", {
		description: "Focus on a plan by path (e.g. /focus-plan .pi/plans/pending/20260322-1730-auth.md)",
		handler: async (args, ctx) => {
			const raw = args?.trim();
			if (!raw) { ctx.ui.notify("Usage: /focus-plan <path>", "warning"); return; }
			const abs = path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);
			if (!fs.existsSync(abs)) { ctx.ui.notify(`Not found: ${abs}`, "error"); return; }
			if (path.dirname(abs) === activeDir(ctx.cwd)) {
				ctx.ui.notify(`Already focused: ${planSummary(abs)}`, "info");
				return;
			}
			parkActivePlan(ctx.cwd);
			const dest = path.join(activeDir(ctx.cwd), path.basename(abs));
			ensureDir(activeDir(ctx.cwd));
			fs.renameSync(abs, dest);
			ctx.ui.notify(`Focused: ${planSummary(dest)}`, "info");
		},
	});

	pi.registerCommand("unfocus-plan", {
		description: "Move the active plan to pending/",
		handler: async (_args, ctx) => {
			const active = getActivePlan(ctx.cwd);
			if (!active) { ctx.ui.notify("No active plan", "info"); return; }
			parkActivePlan(ctx.cwd);
			ctx.ui.notify("Plan moved to pending/. System prompt injection stopped.", "info");
		},
	});

	// -- System prompt (conditional) -----------------------------------------
	//
	// Only inject plan tracking instructions when a plan is actually focused.
	// Without a focused plan, nothing is injected — the user must explicitly
	// /start-plan or /plans to enter plan mode.

	pi.on("before_agent_start", async (event) => {
		const childType = process.env.PI_CHILD_TYPE;

		// Child workers: enforce plan-read-first gate if planPath was given
		if (childType) {
			const found = extractPlanPath(event.prompt);
			planGate = found
				? { planPath: path.isAbsolute(found) ? found : path.resolve(process.cwd(), found), satisfied: false }
				: undefined;
			if (!planGate) return; // No plan context for this child — inject nothing
			return {
				systemPrompt: event.systemPrompt +
					`\n\n## Active Plan\n\nA planPath was provided: ${planGate.planPath}. ` +
					"Read it before editing any files. Use `plan_update` to mark steps complete and log progress as you work.\n",
			};
		}

		// Root session: only inject if there is an active (focused) plan
		const activePath = getActivePlan(process.cwd());
		if (!activePath) return; // No focused plan — silent, no injection

		return {
			systemPrompt: event.systemPrompt +
				"\n\n## Active Plan\n\n" +
				`A plan is focused: ${activePath}\n` +
				"Read this plan at the start of your work. As you implement:\n" +
				"- `plan_update(complete_step: N)` when you finish a step.\n" +
				"- `plan_update(log: \"...\")` to record decisions, progress, or blockers.\n" +
				"- `plan_update(add_step: \"...\")` if new work is discovered.\n" +
				"- `plan_finish` when all steps are done. `plan_abort` if the plan is no longer viable.\n",
		};
	});

	// -- Plan-read-first gate ------------------------------------------------

	pi.on("tool_call", async (event) => {
		if (!planGate || planGate.satisfied) return;
		if (isReadOnlyTool(event.toolName)) return;
		return { block: true, reason: `Read the plan first: ${planGate.planPath}` };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!planGate || planGate.satisfied) return;
		if (event.toolName !== "read") return;
		const raw = typeof event.input.path === "string" ? event.input.path : "";
		if (!raw) return;
		const resolved = path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);
		if (resolved === planGate.planPath) planGate.satisfied = true;
	});
}
