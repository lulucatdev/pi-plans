import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ensureDir, activeDir, doneDir, plansDir, safeDestPath, validatePlanPath } from "./utils.js";
import { parseSteps, appendLog } from "./format.js";
import { getActivePlans, resolvePlanArg, parkActivePlan, planSummary, listAllPlans } from "./state.js";
import type { SessionState } from "./types.js";

export function registerCommands(pi: ExtensionAPI, session: SessionState): void {
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
		description: "Start a planning session: research, brainstorm, and create a tracked plan",
		handler: async (args, ctx) => {
			const topic = args?.trim() || "";
			const prompt = [
				"We are starting a planning session. Follow this pipeline in order:",
				"",
				"## Phase 1: Research",
				"",
				"Explore the codebase and external resources to understand the current state. Do NOT ask the user anything yet — gather context first.",
				"",
				"**Research tips:**",
				"- Use **tasks** to run parallel research across multiple areas of the codebase simultaneously, or do focused sequential research — whichever fits.",
				"- Use **exa**, **web_search**, or other web tools for external lookups (docs, APIs, libraries, best practices).",
				"- Read key files, understand the architecture, identify patterns and conventions.",
				"",
				"## Phase 2: Brainstorm",
				"",
				"Use the `plan_brainstorm` tool for EVERY question to the user. Do NOT use regular text messages to ask questions. One question at a time.",
				"",
				"1. **Clarify scope** — ask about ambiguities, constraints, priorities. Prefer multiple-choice options.",
				"2. **Propose approaches** — present 2-3 approaches with trade-offs using `plan_brainstorm`. Put detailed explanations in the `context` parameter.",
				"3. **Refine** — ask follow-up questions based on the chosen approach.",
				"4. **Define verification** — ask what automated checks to run (build, test, lint commands) and what the user wants to manually verify. These become the plan's acceptance criteria.",
				"5. **Confirm design** — summarize the final approach and ask for approval with options like: 'Looks good, create the plan' / 'I have changes' / 'Start over'.",
				"",
				"## Phase 3: Create Plan",
				"",
				"Only after the user approves the design, call `plan_create` with detailed steps.",
				"",
				"Write the plan assuming the implementer has zero context.",
				"",
				"**Each step should be a single concrete action.** Include:",
				"- What to do and which files are affected",
				"- How to verify it worked",
				"- Code snippets and commands where they add clarity (encouraged, not mandatory for every step)",
				"",
				"**Principles:** DRY, YAGNI, frequent commits. Follow existing codebase patterns.",
				"",
				"**Verification criteria:** Include the `verification` parameter with automated commands and manual acceptance items defined during brainstorming.",
				"",
				"## Phase 4: Execute",
				"",
				"When the user chooses 'Start now', call `plan_execute` to begin execution with guidelines.",
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
			let planPath: string;
			try { planPath = resolvePlanArg(undefined, ctx.cwd, session.focusedPlan); } catch (e: any) { ctx.ui.notify(e.message, "warning"); return; }
			const content = fs.readFileSync(planPath, "utf-8");
			const steps = parseSteps(content);
			const incomplete = steps.filter((s) => !s.done);
			if (incomplete.length > 0) { ctx.ui.notify(`Cannot finish: ${incomplete.length} step(s) still incomplete.`, "error"); return; }
			if (!content.includes("<!-- VERIFIED -->")) { ctx.ui.notify("Cannot finish: run plan_verify first, or use /abort-plan.", "error"); return; }
			const summary = args?.trim() || undefined;
			let updated = appendLog(content, summary ? `Plan completed. ${summary}` : "Plan completed.");
			const dest = safeDestPath(path.join(doneDir(ctx.cwd), path.basename(planPath)));
			ensureDir(doneDir(ctx.cwd));
			fs.writeFileSync(dest, updated, "utf-8");
			fs.unlinkSync(planPath);
			if (session.focusedPlan && path.resolve(session.focusedPlan) === path.resolve(planPath)) session.focusedPlan = undefined;
			ctx.ui.notify(`Completed: ${planSummary(dest)}`, "info");
		},
	});

	pi.registerCommand("abort-plan", {
		description: "Abort the active plan and move to done/",
		handler: async (args, ctx) => {
			let planPath: string;
			try { planPath = resolvePlanArg(undefined, ctx.cwd, session.focusedPlan); } catch (e: any) { ctx.ui.notify(e.message, "warning"); return; }
			const reason = args?.trim() || undefined;
			let content = fs.readFileSync(planPath, "utf-8");
			content = appendLog(content, reason ? `Plan aborted. Reason: ${reason}` : "Plan aborted.");
			const dest = safeDestPath(path.join(doneDir(ctx.cwd), path.basename(planPath)));
			ensureDir(doneDir(ctx.cwd));
			fs.writeFileSync(dest, content, "utf-8");
			fs.unlinkSync(planPath);
			if (session.focusedPlan && path.resolve(session.focusedPlan) === path.resolve(planPath)) session.focusedPlan = undefined;
			ctx.ui.notify(`Aborted: ${dest}`, "info");
		},
	});

	pi.registerCommand("resume-plan", {
		description: "Resume a plan by path (e.g. /resume-plan .pi/plans/done/20260322-1730-auth.md)",
		handler: async (args, ctx) => {
			const raw = args?.trim();
			if (!raw) { ctx.ui.notify("Usage: /resume-plan <path>", "warning"); return; }
			const planPath = path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);
			try { validatePlanPath(planPath, ctx.cwd); } catch (e: any) { ctx.ui.notify(e.message, "error"); return; }
			if (!fs.existsSync(planPath)) { ctx.ui.notify(`Not found: ${planPath}`, "error"); return; }
			const parentDir = path.basename(path.dirname(planPath));
			if (parentDir === "active") { ctx.ui.notify(`Plan is already active: ${planPath}`, "warning"); return; }
			if (parentDir !== "pending" && parentDir !== "done") { ctx.ui.notify(`Can only resume from pending/ or done/`, "error"); return; }
			let content = fs.readFileSync(planPath, "utf-8");
			content = content.replaceAll("<!-- VERIFIED -->", ""); // Clear stale verification
			content = appendLog(content, "Plan resumed.");
			const dest = safeDestPath(path.join(activeDir(ctx.cwd), path.basename(planPath)));
			ensureDir(activeDir(ctx.cwd));
			fs.writeFileSync(dest, content, "utf-8");
			fs.unlinkSync(planPath);
			ctx.ui.notify(`Resumed and activated: ${planSummary(dest)}`, "info");
		},
	});

	pi.registerCommand("activate-plan", {
		description: "Activate a plan by path (e.g. /activate-plan .pi/plans/pending/20260322-1730-auth.md)",
		handler: async (args, ctx) => {
			const raw = args?.trim();
			if (!raw) { ctx.ui.notify("Usage: /activate-plan <path>", "warning"); return; }
			const abs = path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);
			try { validatePlanPath(abs, ctx.cwd); } catch (e: any) { ctx.ui.notify(e.message, "error"); return; }
			if (!fs.existsSync(abs)) { ctx.ui.notify(`Not found: ${abs}`, "error"); return; }
			const parentDir = path.basename(path.dirname(abs));
			if (parentDir === "active") { ctx.ui.notify(`Already active: ${planSummary(abs)}`, "info"); return; }
			if (parentDir !== "pending") { ctx.ui.notify(`Can only activate from pending/. Use /resume-plan for done/ plans.`, "error"); return; }
			let content = fs.readFileSync(abs, "utf-8");
			content = appendLog(content, "Plan activated.");
			const dest = safeDestPath(path.join(activeDir(ctx.cwd), path.basename(abs)));
			ensureDir(activeDir(ctx.cwd));
			fs.writeFileSync(dest, content, "utf-8");
			fs.unlinkSync(abs);
			ctx.ui.notify(`Activated: ${planSummary(dest)}`, "info");
		},
	});

	pi.registerCommand("deactivate-plan", {
		description: "Deactivate an active plan (e.g. /deactivate-plan .pi/plans/active/20260322-1730-auth.md)",
		handler: async (args, ctx) => {
			const raw = args?.trim();
			if (raw) {
				// Deactivate specific plan
				const abs = path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);
				try { validatePlanPath(abs, ctx.cwd); } catch (e: any) { ctx.ui.notify(e.message, "error"); return; }
				if (!fs.existsSync(abs)) { ctx.ui.notify(`Not found: ${abs}`, "error"); return; }
				try { parkActivePlan(ctx.cwd, abs); } catch (e: any) { ctx.ui.notify(e.message, "error"); return; }
				if (session.focusedPlan && path.resolve(session.focusedPlan) === path.resolve(abs)) session.focusedPlan = undefined;
				ctx.ui.notify(`Deactivated: ${path.basename(abs)}`, "info");
				return;
			}
			// No arg: deactivate sole active plan, or error if multiple
			const plans = getActivePlans(ctx.cwd);
			if (plans.length === 0) { ctx.ui.notify("No active plan", "info"); return; }
			if (plans.length > 1) {
				ctx.ui.notify(`Multiple active plans. Specify which to deactivate:\n${plans.map((p) => `  ${p}`).join("\n")}`, "warning");
				return;
			}
			if (session.focusedPlan && path.resolve(session.focusedPlan) === path.resolve(plans[0])) session.focusedPlan = undefined;
			parkActivePlan(ctx.cwd, plans[0]);
			ctx.ui.notify("Plan deactivated and moved to pending/.", "info");
		},
	});
}
