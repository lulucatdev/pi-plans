/**
 * Plan Mode Extension
 *
 * A text-based project manager. Plans are folders stored under
 * <project>/.pi/plans/{active,pending,done,aborted}/YYYYMMDDHHmmss-<slug>/
 * containing plan.md (steps), log.md (append-only log), and research/.
 * Directory = status. The agent reads, updates, and tracks the plan as a
 * living document throughout development.
 *
 * Tools:  plan_focus, plan_research, plan_brainstorm, plan_create, plan_execute,
 *         plan_update, plan_log, plan_verify, plan_finish, plan_abort, plan_resume,
 *         plan_list, plan_activate
 * Commands: /plans, /start-plan, /finish-plan, /abort-plan, /resume-plan,
 *           /activate-plan, /deactivate-plan
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { session } from "./lib/state.js";
import { registerTools } from "./lib/tools.js";
import { registerCommands } from "./lib/commands.js";
import { registerHooks } from "./lib/hooks.js";

export default function planModeExtension(pi: ExtensionAPI) {
	registerTools(pi, session);
	registerCommands(pi, session);
	registerHooks(pi, session);
}
