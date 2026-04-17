import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { plansDir, planFile, validatePlanPath } from "./utils.js";
import { getActivePlans, resolvePlanArg, parkActivePlan, planSummary, listAllPlans, finishPlan, abortPlan, resumePlan, activatePlan, createDraftPlan } from "./state.js";
import type { SessionState } from "./types.js";
import { userLanguageSection } from "./prompting.js";

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

	pi.registerCommand("just-brainstorm", {
		description: "Pure brainstorming session: ask questions, explore ideas, no research or plan creation",
		handler: async (args, ctx) => {
			const topic = args?.trim() || "";
			const prompt = [
				"We are having a pure brainstorming session. No research phase, no plan creation — just a focused conversation to explore ideas.",
				"",
				userLanguageSection,
				"",
				"Use the `plan_brainstorm` tool for EVERY question. Do NOT use regular text messages to ask questions. Batch related questions into a single call — present 2-5 questions at once for a natural brainstorm flow. Always provide suggested options for each question.",
				"",
				"1. **Understand the idea** — ask about goals, context, constraints",
				"2. **Explore angles** — trade-offs, alternatives, edge cases, implications",
				"3. **Propose directions** — present options with trade-offs when patterns emerge",
				"4. **Keep going** — continue as long as the user wants to explore",
				"",
				"Do NOT research the codebase or create plans unless the user explicitly asks.",
				topic ? `\nTopic: ${topic}` : "",
			].filter(Boolean).join("\n");

			pi.sendMessage(
				{ customType: "just-brainstorm", content: prompt, display: true },
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("start-brainstorm", {
		description: "Start an open-ended brainstorming session: research and explore ideas freely",
		handler: async (args, ctx) => {
			const topic = args?.trim() || "";
			const prompt = [
				"We are starting an open-ended brainstorming session. This is exploratory — we may or may not end up creating a formal plan.",
				"",
				userLanguageSection,
				"",
				"## Phase 1: Research",
				"",
				"Build context before asking the user anything. Be resourceful — use whatever tools make sense to understand the problem space quickly and thoroughly.",
				"",
				"Call `plan_research(topic)` whenever you're investigating something worth documenting. This creates a persistent research file — write your findings there as you go. Don't hesitate to create multiple research docs for different aspects of the problem.",
				"",
				"## Phase 2: Brainstorm",
				"",
				"Use the `plan_brainstorm` tool for EVERY question to the user. Do NOT use regular text messages to ask questions. Batch related questions into a single call — present 2-5 questions at once for a natural brainstorm flow. Always provide suggested options for each question.",
				"",
				"1. **Explore the idea** — ask about goals, motivations, constraints. Prefer multiple-choice options when possible.",
				"2. **Investigate angles** — dig into trade-offs, alternatives, implications.",
				"3. **Synthesize** — summarize what we've learned and propose possible directions.",
				"",
				"## What Happens Next",
				"",
				"After brainstorming, ask the user what they'd like to do:",
				"- **Create a plan** — if we've converged on something actionable, use `plan_create` to formalize it",
				"- **Keep exploring** — continue researching and brainstorming",
				"- **Done for now** — wrap up, research docs are already saved",
				topic ? `\nTopic: ${topic}` : "",
			].filter(Boolean).join("\n");

			pi.sendMessage(
				{ customType: "start-brainstorm", content: prompt, display: true },
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("start-plan", {
		description: "Start a planning session: research, brainstorm, and create a tracked plan",
		handler: async (args, ctx) => {
			const topic = args?.trim() || "";
			// Reuse existing focused draft if available, otherwise create new
			let draftPath = session.focusedPlan;
			const hasDraft = draftPath && fs.existsSync(planFile(draftPath)) && fs.readFileSync(planFile(draftPath), "utf-8").includes("<!-- DRAFT -->");
			if (!hasDraft) {
				draftPath = createDraftPlan(ctx.cwd, topic, session);
			}
			const prompt = [
				"We are starting a planning session. Follow this pipeline in order:",
				"",
				userLanguageSection,
				"",
				`A draft plan folder has been created and focused: ${draftPath}`,
				"All research will be saved inside this plan folder.",
				"",
				"## Phase 1: Research",
				"",
				"Build context before asking the user anything. Be resourceful — use whatever tools make sense to understand the problem space quickly and thoroughly.",
				"",
				"Call `plan_research(topic)` whenever you're investigating something worth documenting. This creates a persistent research file — write your findings there as you go. Don't hesitate to create multiple research docs for different aspects of the problem.",
				"",
				"## Phase 2: Brainstorm",
				"",
				"Use the `plan_brainstorm` tool for EVERY question to the user. Do NOT use regular text messages to ask questions. Batch related questions into a single call — present 2-5 questions at once for a natural brainstorm flow. Always provide suggested options for each question.",
				"",
				"1. **Clarify and explore** — batch questions about scope, constraints, ambiguities, and approach preferences. Provide multiple-choice options with context for trade-offs.",
				"2. **Propose approaches** — present 2-3 approaches with trade-offs using `plan_brainstorm`. Put detailed explanations in the `context` parameter.",
				"3. **Refine** — ask follow-up questions based on the chosen approach.",
				"4. **Define verification** — ask what automated checks to run (build, test, lint commands) and what the user wants to manually verify. These become the plan's acceptance criteria.",
				"5. **Confirm design** — before asking for approval, write the full proposed plan in a normal assistant message. Include the title, goal, architecture, every planned step with affected files and verification notes, and the verification checklist. The user should be able to review or edit the plan without opening any file.",
				"6. **Ask for approval** — once the full draft is visible in chat, ask for approval with options like: 'Looks good, create the plan' / 'I have changes' / 'Start over'.",
				"",
				"## Phase 3: Create Plan",
				"",
				"Only after the user approves the detailed in-chat draft, call `plan_create` with the same detailed steps.",
				"Use `activate: false` only if the user explicitly wants to save the plan without starting work yet.",
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
				"If the user wants to begin implementation immediately, call `plan_execute` right after `plan_create` succeeds.",
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
			try {
				const dest = finishPlan(planPath, ctx.cwd, session, args?.trim() || undefined);
				ctx.ui.notify(`Completed: ${planSummary(dest)}`, "info");
			} catch (e: any) { ctx.ui.notify(e.message, "error"); }
		},
	});

	pi.registerCommand("abort-plan", {
		description: "Abort the active plan and move to aborted/",
		handler: async (args, ctx) => {
			let planPath: string;
			try { planPath = resolvePlanArg(undefined, ctx.cwd, session.focusedPlan); } catch (e: any) { ctx.ui.notify(e.message, "warning"); return; }
			const dest = abortPlan(planPath, ctx.cwd, session, args?.trim() || undefined);
			ctx.ui.notify(`Aborted: ${dest}`, "info");
		},
	});

	pi.registerCommand("resume-plan", {
		description: "Resume a plan by path (e.g. /resume-plan .pi/plans/done/20260322-auth)",
		handler: async (args, ctx) => {
			const raw = args?.trim();
			if (!raw) { ctx.ui.notify("Usage: /resume-plan <path>", "warning"); return; }
			const planPath = path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);
			try {
				const dest = resumePlan(planPath, ctx.cwd);
				ctx.ui.notify(`Resumed and activated: ${planSummary(dest)}`, "info");
			} catch (e: any) { ctx.ui.notify(e.message, "error"); }
		},
	});

	pi.registerCommand("activate-plan", {
		description: "Activate a plan by path (e.g. /activate-plan .pi/plans/pending/20260322-auth)",
		handler: async (args, ctx) => {
			const raw = args?.trim();
			if (!raw) { ctx.ui.notify("Usage: /activate-plan <path>", "warning"); return; }
			const abs = path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);
			try {
				const dest = activatePlan(abs, ctx.cwd);
				ctx.ui.notify(`Activated: ${planSummary(dest)}`, "info");
			} catch (e: any) { ctx.ui.notify(e.message, "error"); }
		},
	});

	pi.registerCommand("deactivate-plan", {
		description: "Deactivate an active plan (e.g. /deactivate-plan .pi/plans/active/20260322-auth)",
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
