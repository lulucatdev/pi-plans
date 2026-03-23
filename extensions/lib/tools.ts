import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ensureDir, pendingDir, activeDir, doneDir, abortedDir, plansDir, researchDir, planResearchDir, planFile, logFile, extractSlugFromPlanPath, ts, slugify, safeDestPath, validatePlanPath } from "./utils.js";
import { renderPlan, renderResearchDoc, renderLogHeader, parseSteps, parseManualAcceptance, completeStep, addStep, appendLog } from "./format.js";
import { getActivePlans, getActivePlan, resolvePlanArg, parkActivePlan, planSummary, listAllPlans } from "./state.js";
import type { SessionState } from "./types.js";

export function registerTools(pi: ExtensionAPI, session: SessionState): void {
	// -- plan_focus ----------------------------------------------------------

	pi.registerTool({
		name: "plan_focus",
		label: "plan focus",
		description:
			"Bind this session to a specific plan. After focusing, all plan tools " +
			"(plan_update, plan_execute, plan_verify, etc.) default to this plan " +
			"without needing plan_path on every call. Useful when multiple plans are active.",
		parameters: Type.Object({
			plan_path: Type.String({ description: "Path to the plan folder to focus on" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const abs = path.isAbsolute(params.plan_path) ? params.plan_path : path.resolve(ctx.cwd, params.plan_path);
			validatePlanPath(abs, ctx.cwd);
			if (!fs.existsSync(abs)) throw new Error(`Plan not found: ${abs}`);
			const activePlans = getActivePlans(ctx.cwd);
			if (!activePlans.some((a) => path.resolve(a) === path.resolve(abs))) {
				throw new Error(`Plan is not active: ${abs}\nOnly active plans can be focused. Use plan_activate first.`);
			}
			session.focusedPlan = abs;
			const summary = planSummary(abs);
			return {
				content: [{ type: "text", text: `Session focused on: ${summary}\nAll plan tools will default to this plan.` }],
				details: { planPath: abs },
			};
		},
	});

	// -- plan_research -------------------------------------------------------

	pi.registerTool({
		name: "plan_research",
		label: "plan research",
		description:
			"Initiate a research phase. When linked to a plan, creates a research document inside the plan's " +
			"research/ subfolder. For standalone research (no plan), uses .pi/plans/research/_standalone/. " +
			"Returns the file path. Write your research findings into this file using the write tool. " +
			"Available at every stage: before brainstorming, during planning, or mid-execution.",
		parameters: Type.Object({
			topic: Type.String({ description: "What you need to research, e.g. 'OAuth 2.0 PKCE flow best practices'" }),
			plan_path: Type.Optional(Type.String({ description: "Explicit plan folder path to log to (default: active plan, if any)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Resolve plan for logging and research folder placement
			let planPath: string | undefined;
			let planName: string | undefined;
			if (params.plan_path) {
				const abs = path.isAbsolute(params.plan_path) ? params.plan_path : path.resolve(ctx.cwd, params.plan_path);
				validatePlanPath(abs, ctx.cwd);
				planPath = abs;
			} else {
				const candidate = session.focusedPlan ?? getActivePlan(ctx.cwd);
				if (candidate) {
					const activePlans = getActivePlans(ctx.cwd);
					if (activePlans.some((a) => path.resolve(a) === path.resolve(candidate))) {
						planPath = candidate;
					}
				}
			}

			if (planPath) {
				const content = fs.readFileSync(planFile(planPath), "utf-8");
				const titleMatch = content.match(/^# (.+)/m);
				planName = titleMatch?.[1] ?? extractSlugFromPlanPath(planPath);
			}

			// Create research document — inside plan folder or standalone
			let rDir: string;
			if (planPath) {
				rDir = planResearchDir(planPath);
			} else {
				rDir = researchDir(ctx.cwd);
			}
			ensureDir(rDir);
			const researchFile = safeDestPath(path.join(rDir, `${ts()}-${slugify(params.topic)}.md`));
			fs.writeFileSync(researchFile, renderResearchDoc(params.topic, planName), "utf-8");

			// Log to plan's log.md
			if (planPath) {
				const relResearch = path.relative(planPath, researchFile);
				appendLog(logFile(planPath), `Researching: ${params.topic} → ${relResearch}`);
			}

			const relPath = path.relative(ctx.cwd, researchFile);
			const guidance = [
				`## Research: ${params.topic}`,
				"",
				`**Research document created:** ${relPath}`,
				"",
				"Write your findings into this file as you research. Use the write tool to update it with:",
				"- Key facts and data points discovered",
				"- Code patterns and examples found",
				"- Links to relevant documentation",
				"- Conclusions and recommendations",
				"",
				"### Research Approaches",
				"",
				"**Parallel research** — use tasks to investigate multiple areas simultaneously",
				"**Sequential research** — read files, grep for patterns, trace code paths",
				"**Web research** — use exa, web_search, or WebFetch for external knowledge",
				"",
				"### If Debugging a Problem",
				"",
				"1. **Root cause investigation** — read the error, reproduce consistently, check recent changes",
				"2. **Pattern analysis** — find working examples, compare, identify the difference",
				"3. **Hypothesis & test** — one hypothesis, one variable, verify before continuing",
				"4. **Implement fix** — single targeted change, then verify",
			].join("\n");

			return {
				content: [{ type: "text", text: guidance }],
				details: { researchFile, planPath },
			};
		},
	});

	// -- plan_brainstorm -----------------------------------------------------

	pi.registerTool({
		name: "plan_brainstorm",
		label: "plan brainstorm",
		description:
			"Ask the user a single question during brainstorming via a UI dialog. " +
			"Use for ALL user interactions before plan_create. " +
			"If options provided → selection dialog; if not → free-text input. " +
			"Call multiple times, one question at a time. Prefer options when possible. " +
			"Returns the user's answer or 'dismissed' if they cancelled.",
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask. Be specific and concise." }),
			context: Type.Optional(Type.String({
				description: "Background info shown with the question (trade-offs, approach details)",
			})),
			options: Type.Optional(Type.Array(Type.String(), {
				description: "Multiple-choice options. Shows select dialog instead of text input.",
			})),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const title = params.context
				? `${params.question}\n\n${params.context}`
				: params.question;

			let answer: string | undefined;
			if (params.options && params.options.length > 0) {
				answer = await ctx.ui.select(title, params.options);
			} else {
				answer = await ctx.ui.input(title, "Type your answer...");
			}

			// Return full Q&A record so it remains visible in conversation history
			const record = [
				`**Q:** ${params.question}`,
				params.context ? `\n${params.context}` : "",
				params.options?.length ? `\nOptions: ${params.options.join(" / ")}` : "",
				`\n**A:** ${answer ?? "(dismissed)"}`,
			].filter(Boolean).join("");

			return {
				content: [{ type: "text", text: record }],
				details: {},
			};
		},
	});

	// -- plan_create ---------------------------------------------------------

	pi.registerTool({
		name: "plan_create",
		label: "plan create",
		description:
			"Create a new plan document with a goal, architecture overview, and detailed steps. " +
			"Use after researching the codebase and agreeing on the approach with the user. " +
			"Each step should be a single concrete action. Include: affected files, what to do, and how to verify. " +
			"Code snippets and exact commands are encouraged but not mandatory for every step.",
		parameters: Type.Object({
			name: Type.String({ description: "Short plan name, e.g. 'auth-refactor'" }),
			goal: Type.String({ description: "1-3 sentence description of what this builds" }),
			architecture: Type.Optional(Type.String({ description: "2-3 sentences about the approach, key design decisions, and tech involved" })),
			steps: Type.Array(Type.String(), {
				minItems: 1,
				description:
					"Ordered list of implementation steps (at least one). Each step should be a single action with: " +
					"1) what to do, 2) which files are affected, 3) how to verify it worked. " +
					"Include code snippets and commands where they add clarity. Avoid vague steps like 'add validation' — be specific about what and where.",
			}),
			verification: Type.Optional(Type.Object({
				automated: Type.Optional(Type.Array(Type.String(), {
					description: "Commands to run for automated verification, e.g. 'npm test', 'npm run build', 'npm run lint'",
				})),
				manual: Type.Optional(Type.Array(Type.String(), {
					description: "Items for the user to manually verify, e.g. 'OAuth login flow works with Google', 'Error page renders correctly'",
				})),
			}, { description: "Verification criteria defined upfront. Automated commands + manual acceptance checklist. Used by plan_verify at the end." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Create plan folder in pending/
			const dir = pendingDir(ctx.cwd);
			ensureDir(dir);
			const folderName = `${ts()}-${slugify(params.name)}`;
			const planDir = safeDestPath(path.join(dir, folderName));
			ensureDir(planDir);

			const title = params.name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
			fs.writeFileSync(planFile(planDir), renderPlan(title, params.goal, params.steps, params.architecture, params.verification), "utf-8");
			fs.writeFileSync(logFile(planDir), renderLogHeader(), "utf-8");
			appendLog(logFile(planDir), "Plan created.");

			const relPath = path.relative(ctx.cwd, planDir);
			const choice = await ctx.ui.select(`Plan created: ${relPath}\nWhat next?`, [
				"Start now",
				"Save for later",
				"I have feedback",
			]);

			if (choice === "Start now") {
				const dest = safeDestPath(path.join(activeDir(ctx.cwd), path.basename(planDir)));
				ensureDir(activeDir(ctx.cwd));
				fs.renameSync(planDir, dest);
				session.focusedPlan = dest; // Auto-focus this session on the new plan
				return {
					content: [{ type: "text", text: `Plan created, activated, and focused: ${dest}\nCall plan_execute to begin execution with guidelines.` }],
					details: { planPath: dest },
				};
			}

			if (choice === "Save for later") {
				return {
					content: [{ type: "text", text: `Plan saved for later: ${planDir}\nUse plan_activate or /activate-plan to activate it when ready.` }],
					details: { planPath: planDir },
				};
			}

			// "I have feedback" or dismissed — ask for input
			const feedback = await ctx.ui.input("What would you like to change?", "e.g. step 3 should come before step 2");
			if (feedback) {
				pi.sendMessage(
					{
						customType: "plan-feedback",
						content: `The user has feedback on the plan at ${planDir}:\n\n${feedback}\n\nRead the plan, discuss with the user, and update or recreate it.`,
						display: true,
					},
					{ triggerTurn: true },
				);
				return {
					content: [{ type: "text", text: `Plan saved: ${planDir}\nDiscussing feedback with user.` }],
					details: { planPath: planDir },
				};
			}

			return {
				content: [{ type: "text", text: `Plan saved: ${planDir}` }],
				details: { planPath: planDir },
			};
		},
	});

	// -- plan_execute --------------------------------------------------------

	pi.registerTool({
		name: "plan_execute",
		label: "plan execute",
		description:
			"Begin executing the active plan. Reads the plan and returns it with execution guidelines. " +
			"Call this after plan_create when the user chose 'Start now', or when resuming work on an active plan.",
		parameters: Type.Object({
			plan_path: Type.Optional(Type.String({ description: "Explicit plan folder path (default: active plan)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanArg(params.plan_path, ctx.cwd, session.focusedPlan);
			session.focusedPlan = planPath; // Auto-focus on execute
			const content = fs.readFileSync(planFile(planPath), "utf-8");
			const steps = parseSteps(content);
			const current = steps.find((s) => s.isCurrent);

			appendLog(logFile(planPath), "Execution started.");

			const guidelines = [
				"## Execution Guidelines",
				"",
				"Execute the plan step by step. For each step:",
				"1. `plan_update(log: \"Starting step N: ...\")` — log what you're about to do",
				"2. Do the work",
				"3. **Verify** — run the relevant test/build/check command and confirm it passes before proceeding",
				"4. `plan_update(complete_step: N)` — mark it done only AFTER verification passes",
				"",
				"### Verification Rule",
				"**No completion without evidence.** Before marking any step complete:",
				"- Identify what command proves the step works (test, build, lint, manual check)",
				"- Run the command, read the full output, check the exit code",
				"- Only mark complete if the output confirms success",
				"- Never say 'should work' or 'probably passes' — run it and see",
				"",
				"### Research During Execution",
				"When you need to investigate something:",
				"- Call `plan_research(topic)` to log it and get methodology guidance",
				"- Use **tasks** to run parallel research across multiple areas",
				"- Use **exa**, **web_search**, or other web tools for external lookups",
				"- Or do focused sequential research — whatever fits the question",
				"",
				"### When Something Breaks — Systematic Debugging",
				"If you hit an error or unexpected behavior, do NOT guess-and-fix. Follow this sequence:",
				"1. **Investigate root cause** — read the error carefully, reproduce consistently, check recent changes",
				"2. **Analyze patterns** — find working examples, compare against them, identify the difference",
				"3. **Form one hypothesis, test it** — change one variable at a time, verify before continuing",
				"4. **Implement the fix** — single targeted change, then verify",
				"",
				"### Staying on Track",
				"- **Default: execute faithfully.** Follow the plan as written.",
				"- If you discover something that makes a step impossible or wrong, log it and discuss with the user before changing course.",
				"- Minor adjustments (reordering, small scope tweaks) are fine — log them.",
				"- Major pivots require user approval via discussion.",
				"- Use `plan_update(add_step: ...)` if new work is discovered.",
				"",
				"### Finishing Up",
				"When all steps are complete, call `plan_verify` (NOT `plan_finish` directly):",
				"1. Run ALL automated checks (full test suite, build, lint)",
				"2. Prepare an acceptance checklist for the user",
				"3. Call `plan_verify` with results + checklist",
				"4. Only call `plan_finish` after the user approves verification",
			].join("\n");

			return {
				content: [
					{ type: "text", text: `Executing plan: ${planPath}\nCurrent step: ${current ? `${current.index + 1}. ${current.text}` : "none"}\n\n${guidelines}\n\n---\n\n${content}` },
				],
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
			"Operates on the active plan by default.",
		parameters: Type.Object({
			complete_step: Type.Optional(Type.Integer({
				minimum: 1,
				description: "1-based step number to mark as complete. Automatically advances the current marker.",
			})),
			add_step: Type.Optional(Type.String({ description: "Text of a new step to add" })),
			after_step: Type.Optional(Type.Integer({ minimum: 1, description: "1-based step number to insert the new step after (default: append at end)" })),
			log: Type.Optional(Type.String({ description: "A timestamped log entry to append (progress, decisions, notes)" })),
			plan_path: Type.Optional(Type.String({ description: "Explicit plan folder path (default: active plan)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.complete_step === undefined && !params.add_step && !params.log) {
				throw new Error("No action specified. Provide at least one of: complete_step, add_step, log.");
			}
			const planPath = resolvePlanArg(params.plan_path, ctx.cwd, session.focusedPlan);
			let content = fs.readFileSync(planFile(planPath), "utf-8");
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

			// Invalidate verification when steps change (not on log-only updates)
			if (params.complete_step !== undefined || params.add_step) {
				content = content.replaceAll("<!-- VERIFIED -->", "");
			}

			fs.writeFileSync(planFile(planPath), content, "utf-8");

			if (params.log) {
				appendLog(logFile(planPath), params.log);
				actions.push("added log entry");
			}

			return {
				content: [{ type: "text", text: `Updated plan: ${actions.join(", ")}\n${planPath}` }],
				details: { planPath },
			};
		},
	});

	// -- plan_log ------------------------------------------------------------

	pi.registerTool({
		name: "plan_log",
		label: "plan log",
		description: "Add a log entry to the plan's log.md.",
		parameters: Type.Object({
			message: Type.String({ description: "The log message to append" }),
			plan_path: Type.Optional(Type.String({ description: "Explicit plan folder path (default: active plan)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanArg(params.plan_path, ctx.cwd, session.focusedPlan);
			appendLog(logFile(planPath), params.message);
			return {
				content: [{ type: "text", text: `Logged to ${planPath}` }],
				details: { planPath },
			};
		},
	});

	// -- plan_verify ---------------------------------------------------------

	pi.registerTool({
		name: "plan_verify",
		label: "plan verify",
		description:
			"Run the verification/acceptance phase before finishing a plan. " +
			"Call this BEFORE plan_finish. Two stages: " +
			"1) Run all automated checks from the plan's Verification section (or provide your own) and report results. " +
			"2) Present the manual acceptance checklist from the plan to the user via UI dialog. " +
			"Only call plan_finish after the user approves.",
		parameters: Type.Object({
			automated_results: Type.String({
				description: "Summary of automated test/build/lint results you already ran. Include commands executed, pass/fail counts, and any failures.",
			}),
			acceptance_checklist: Type.Optional(Type.Array(Type.String(), {
				description: "Manual acceptance items. If omitted, reads from the plan's '## Verification / ### Manual Acceptance' section.",
			})),
			plan_path: Type.Optional(Type.String({ description: "Explicit plan folder path (default: active plan)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanArg(params.plan_path, ctx.cwd, session.focusedPlan);
			let content = fs.readFileSync(planFile(planPath), "utf-8");

			// Extract manual checklist from plan if not provided
			let checklist = params.acceptance_checklist;
			if (!checklist || checklist.length === 0) {
				checklist = parseManualAcceptance(content);
			}
			if (!checklist || checklist.length === 0) {
				checklist = ["All features work as described in the plan goal"];
			}

			// Clear any previous verification marker before starting new verification
			content = content.replaceAll("<!-- VERIFIED -->", "");
			fs.writeFileSync(planFile(planPath), content, "utf-8");

			// Log the verification attempt
			appendLog(logFile(planPath), `Verification started. Automated: ${params.automated_results.split("\n")[0]}`);

			// Show automated results + acceptance checklist to user
			const checklistText = checklist
				.map((item, i) => `${i + 1}. ${item}`)
				.join("\n");

			const dialogTitle = [
				"Automated test results:",
				params.automated_results,
				"",
				"Please verify these items manually:",
				checklistText,
			].join("\n");

			const choice = await ctx.ui.select(dialogTitle, [
				"All verified, ready to finish",
				"Some items failed — need fixes",
				"Skip verification for now",
			]);

			if (choice === "All verified, ready to finish") {
				content = fs.readFileSync(planFile(planPath), "utf-8");
				content += "\n<!-- VERIFIED -->\n";
				fs.writeFileSync(planFile(planPath), content, "utf-8");
				appendLog(logFile(planPath), "Verification passed. User approved.");
				return {
					content: [{ type: "text", text: "Verification passed. Call `plan_finish` to complete the plan." }],
					details: { planPath, verified: true },
				};
			}

			if (choice === "Some items failed — need fixes") {
				const feedback = await ctx.ui.input("What needs to be fixed?", "Describe what failed or needs changes");
				appendLog(logFile(planPath), `Verification failed. User feedback: ${feedback ?? "(no details)"}`);
				return {
					content: [{ type: "text", text: `Verification failed. Fix the issues and re-verify.\nUser feedback: ${feedback ?? "(no details)"}` }],
					details: { planPath, verified: false },
				};
			}

			// Skipped or dismissed
			return {
				content: [{ type: "text", text: "Verification skipped. You can run `plan_verify` again later." }],
				details: { planPath, verified: false },
			};
		},
	});

	// -- plan_finish ---------------------------------------------------------

	pi.registerTool({
		name: "plan_finish",
		label: "plan finish",
		description:
			"Mark the active plan as completed. Logs a completion entry and moves it to done/. " +
			"You should call plan_verify BEFORE this to run the acceptance phase.",
		parameters: Type.Object({
			summary: Type.Optional(Type.String({ description: "Brief completion summary to log" })),
			plan_path: Type.Optional(Type.String({ description: "Explicit plan folder path (default: active plan)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanArg(params.plan_path, ctx.cwd, session.focusedPlan);
			const content = fs.readFileSync(planFile(planPath), "utf-8");

			// Check completion prerequisites
			const steps = parseSteps(content);
			const incomplete = steps.filter((s) => !s.done);
			if (incomplete.length > 0) {
				throw new Error(`Cannot finish: ${incomplete.length} step(s) still incomplete. Complete all steps or use plan_abort.`);
			}
			const hasVerification = content.includes("<!-- VERIFIED -->");
			if (!hasVerification) {
				throw new Error("Cannot finish: no verification record found. Run plan_verify first, or use plan_abort to skip.");
			}

			const logMsg = params.summary ? `Plan completed. ${params.summary}` : "Plan completed.";
			appendLog(logFile(planPath), logMsg);

			const dest = safeDestPath(path.join(doneDir(ctx.cwd), path.basename(planPath)));
			ensureDir(doneDir(ctx.cwd));
			fs.renameSync(planPath, dest);
			if (session.focusedPlan && path.resolve(session.focusedPlan) === path.resolve(planPath)) session.focusedPlan = undefined;
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
			"Abort the active plan. Logs the reason and moves it to aborted/.",
		parameters: Type.Object({
			reason: Type.Optional(Type.String({ description: "Why the plan was aborted" })),
			plan_path: Type.Optional(Type.String({ description: "Explicit plan folder path (default: active plan)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanArg(params.plan_path, ctx.cwd, session.focusedPlan);

			const logMsg = params.reason ? `Plan aborted. Reason: ${params.reason}` : "Plan aborted.";
			appendLog(logFile(planPath), logMsg);

			const dest = safeDestPath(path.join(abortedDir(ctx.cwd), path.basename(planPath)));
			ensureDir(abortedDir(ctx.cwd));
			fs.renameSync(planPath, dest);
			if (session.focusedPlan && path.resolve(session.focusedPlan) === path.resolve(planPath)) session.focusedPlan = undefined;
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
			"Resume a pending, done, or aborted plan. Moves it to active/, clears stale verification, " +
			"and logs a resumption entry. Multiple plans can be active simultaneously.",
		parameters: Type.Object({
			plan_path: Type.String({ description: "Path to the plan folder (in pending/, done/, or aborted/)" }),
			reason: Type.Optional(Type.String({ description: "Why the plan is being resumed" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = path.isAbsolute(params.plan_path) ? params.plan_path : path.resolve(ctx.cwd, params.plan_path);
			validatePlanPath(planPath, ctx.cwd);
			if (!fs.existsSync(planPath)) throw new Error(`Plan not found: ${planPath}`);
			const parentDir = path.basename(path.dirname(planPath));
			if (parentDir === "active") throw new Error(`Plan is already active: ${planPath}`);
			if (parentDir !== "pending" && parentDir !== "done" && parentDir !== "aborted") {
				throw new Error(`Can only resume plans from pending/, done/, or aborted/, not ${parentDir}/`);
			}

			// Clear stale verification from plan.md
			let content = fs.readFileSync(planFile(planPath), "utf-8");
			content = content.replaceAll("<!-- VERIFIED -->", "");
			fs.writeFileSync(planFile(planPath), content, "utf-8");

			const logMsg = params.reason ? `Plan resumed. ${params.reason}` : "Plan resumed.";
			appendLog(logFile(planPath), logMsg);

			const dest = safeDestPath(path.join(activeDir(ctx.cwd), path.basename(planPath)));
			ensureDir(activeDir(ctx.cwd));
			fs.renameSync(planPath, dest);

			const summary = planSummary(dest);
			return {
				content: [{ type: "text", text: `Resumed and activated: ${summary}\n${dest}` }],
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
				return { content: [{ type: "text", text: `No plans found in ${plansDir(ctx.cwd)}` }], details: {} };
			}
			const text = plans.map((p) => `${p.summary}\n    ${p.path}`).join("\n");
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	// -- plan_activate --------------------------------------------------------

	pi.registerTool({
		name: "plan_activate",
		label: "plan activate",
		description:
			"Activate a plan by moving it from pending/ to active/. " +
			"Multiple plans can be active simultaneously (for parallel agent instances). " +
			"Active plans are indicated with ● in plan_list.",
		parameters: Type.Object({
			plan_path: Type.String({ description: "Path to the plan folder to activate" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const abs = path.isAbsolute(params.plan_path) ? params.plan_path : path.resolve(ctx.cwd, params.plan_path);
			validatePlanPath(abs, ctx.cwd);
			if (!fs.existsSync(abs)) throw new Error(`Plan not found: ${abs}`);
			const parentDir = path.basename(path.dirname(abs));
			if (parentDir === "active") {
				const summary = planSummary(abs);
				return { content: [{ type: "text", text: `Already active: ${summary}\n${abs}` }], details: {} };
			}
			if (parentDir !== "pending") throw new Error(`Can only activate plans from pending/, not ${parentDir}/. Use plan_resume for done/ or aborted/ plans.`);

			appendLog(logFile(abs), "Plan activated.");

			const dest = safeDestPath(path.join(activeDir(ctx.cwd), path.basename(abs)));
			ensureDir(activeDir(ctx.cwd));
			fs.renameSync(abs, dest);
			const summary = planSummary(dest);
			const activeCount = getActivePlans(ctx.cwd).length;
			const countNote = activeCount > 1 ? ` (${activeCount} plans now active)` : "";
			return {
				content: [{ type: "text", text: `Activated: ${summary}${countNote}\n${dest}` }],
				details: { planPath: dest },
			};
		},
	});
}
