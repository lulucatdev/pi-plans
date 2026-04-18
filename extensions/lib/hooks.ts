import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getActivePlans } from "./state.js";
import { extractPlanPath, isReadOnlyTool } from "./state.js";
import type { SessionState } from "./types.js";
import { userLanguageRule } from "./prompting.js";

export function registerHooks(pi: ExtensionAPI, session: SessionState): void {
	// -- System prompt (conditional) -----------------------------------------
	//
	// Only inject plan tracking instructions when a plan is active.
	// Without an active plan, nothing is injected — the user must explicitly
	// /start-plan or /plans to enter plan mode.

	pi.on("before_agent_start", async (event) => {
		const childType = process.env.PI_CHILD_TYPE;

		// Child workers: enforce plan-read-first gate if planPath was given
		if (childType) {
			const found = extractPlanPath(event.prompt);
			session.planGate = found
				? { planPath: path.isAbsolute(found) ? found : path.resolve(process.cwd(), found), satisfied: false }
				: undefined;
			if (!session.planGate) return; // No plan context for this child — inject nothing
			return {
				systemPrompt: event.systemPrompt +
					`\n\n## Active Plan\n\nA planPath was provided: ${session.planGate.planPath}. ` +
					"Read plan.md inside that folder before editing any files. Use `plan_update` to mark steps complete and log progress as you work. " +
					`${userLanguageRule}\n`,
			};
		}

		// Root session: only inject if there are active plans
		const activePlans = getActivePlans(process.cwd());
		if (activePlans.length === 0) return; // No active plans — silent, no injection

		const plansList = activePlans.length === 1
			? `A plan is active: ${activePlans[0]}`
			: `${activePlans.length} plans are active:\n${activePlans.map((p) => `- ${p}`).join("\n")}\n\nUse plan_path parameter to specify which plan you're working on.`;

		return {
			systemPrompt: event.systemPrompt +
				"\n\n## Active Plans\n\n" +
				`${plansList}\n` +
				"Only use plan tracking when the current user request is actually part of one of these active plans. For unrelated one-shot work, continue normally and do not force plan tools.\n" +
				`${userLanguageRule}\n` +
				"If the request belongs to an active plan, read the plan before editing files. Use `plan_execute` to begin with full execution guidelines, or work through steps directly:\n" +
				"- `plan_update(complete_step: N)` when you finish a step.\n" +
				"- `plan_update(log: \"...\")` to record decisions, progress, or blockers.\n" +
				"- `plan_update(add_step: \"...\")` if new work is discovered.\n" +
				"- `plan_review` for external code review. `plan_finish` after the user confirms satisfaction. `plan_abort` if the plan is no longer viable.\n" +
				"\n**Research during execution:** Call `plan_research(topic)` only when the active plan requires non-trivial investigation. Skip it for straightforward edits or direct answers.\n" +
				"**Pivot policy:** Execute faithfully by default. If you find a must-fix issue, discuss with the user before changing course.\n",
		};
	});

	// -- Plan-read-first gate ------------------------------------------------

	pi.on("tool_call", async (event) => {
		if (!session.planGate || session.planGate.satisfied) return;
		if (isReadOnlyTool(event.toolName)) return;
		return { block: true, reason: `Read the plan first: ${session.planGate.planPath}` };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!session.planGate || session.planGate.satisfied) return;
		if (event.toolName !== "read") return;
		const raw = typeof event.input.path === "string" ? event.input.path : "";
		if (!raw) return;
		const resolved = path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);
		// Plan paths are now folders. Satisfy the gate if the agent reads any file
		// inside the plan folder (e.g. plan.md, log.md, research/*).
		const planDir = session.planGate.planPath;
		if (resolved === planDir || resolved.startsWith(planDir + path.sep)) {
			session.planGate.satisfied = true;
		}
	});
}
