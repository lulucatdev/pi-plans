import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { ensureDir, pendingDir, activeDir, plansDir, researchDir, planResearchDir, planReviewDir, planFile, logFile, extractSlugFromPlanPath, ts, slugify, safeDestPath, validatePlanPath } from "./utils.js";
import { renderPlan, renderResearchDoc, renderReviewDoc, renderLogHeader, parseSteps, parseManualAcceptance, completeStep, addStep, appendLog, clearVerificationMarkers, hasPreparedVerification, hasVerified, markVerificationPrepared, markVerified } from "./format.js";
import { getActivePlans, getActivePlan, resolvePlanArg, parkActivePlan, planSummary, listAllPlans, finishPlan, abortPlan, resumePlan, activatePlan } from "./state.js";
import type { SessionState } from "./types.js";
import { userLanguageRule } from "./prompting.js";

interface BrainstormQuestion {
	id: string;
	question: string;
	context?: string;
	options: string[];
	recommended?: number; // 0-based index of the recommended option
}

interface BrainstormAnswer {
	id: string;
	question: string;
	answer: string;
	wasCustom: boolean;
}

interface BrainstormResult {
	questions: BrainstormQuestion[];
	answers: BrainstormAnswer[];
	cancelled: boolean;
}

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
			"Start researching a topic and save findings in a persistent research document. " +
			"Use this only when the task is non-trivial and genuinely needs investigation before you can proceed. " +
			"For simple questions, direct answers, or small one-shot edits, do not open a research document. " +
			"When linked to a plan, files go in the plan's research/ subfolder; otherwise .pi/plans/research/_standalone/. " +
			userLanguageRule,
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
				if (candidate && fs.existsSync(planFile(candidate))) {
					planPath = candidate;
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
				userLanguageRule,
				"",
				"Investigate this topic thoroughly and write only the findings that materially affect the task.",
				"",
				"Use this tool for non-trivial investigation. If the issue turns out to be straightforward, stop here and continue directly instead of expanding the research scope.",
				"If your investigation raises a distinct follow-up topic that is still substantial, call `plan_research` again for that separate topic.",
				"",
				"### If Debugging a Problem",
				"",
				"1. **Root cause** — read the error, reproduce, check recent changes",
				"2. **Pattern analysis** — find working examples, compare, spot the difference",
				"3. **Hypothesis & test** — one variable at a time, verify before continuing",
				"4. **Fix** — single targeted change, then verify",
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
			"Ask the user one or more planning questions via a UI questionnaire. " +
			"Use this only after the user has chosen a brainstorming or planning flow, or explicitly asked to compare approaches before `plan_create`. " +
			"Do not use it for ordinary chat, simple direct questions, or one-shot edits. " +
			"Each question can have suggested options, but always includes free-text input. " +
			"Use `recommended` to mark the best option (shown with ★, cursor defaults to it). " +
			"Batch related questions into one call. Returns Q&A records. " +
			userLanguageRule,
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					id: Type.String({ description: "Short identifier, e.g. 'scope', 'priority'" }),
					question: Type.String({ description: "The question to ask" }),
					context: Type.Optional(Type.String({ description: "Background info (trade-offs, details)" })),
					options: Type.Optional(Type.Array(Type.String(), { description: "Suggested answers" })),
					recommended: Type.Optional(Type.Integer({ minimum: 0, description: "0-based index of the recommended option. Shown with ★ and cursor defaults to it." })),
				}),
				{ minItems: 1 },
			),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: { questions: [], answers: [], cancelled: true } as BrainstormResult,
				};
			}

			// Normalize questions and validate unique ids
			const seenIds = new Set<string>();
			const questions: BrainstormQuestion[] = params.questions.map((q, i) => {
				let id = q.id;
				if (seenIds.has(id)) id = `${id}-${i + 1}`;
				seenIds.add(id);
				const opts = q.options ?? [];
				const rec = q.recommended !== undefined && q.recommended >= 0 && q.recommended < opts.length ? q.recommended : undefined;
				return { ...q, id, options: opts, recommended: rec };
			});

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result = await ctx.ui.custom<BrainstormResult>((tui, theme, _kb, done) => {
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, BrainstormAnswer>();
				const drafts = new Map<string, string>(); // per-question unsaved editor text

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					// Return answers in question definition order
					const ordered = questions.map((q) => answers.get(q.id)).filter((a): a is BrainstormAnswer => !!a);
					done({ questions, answers: ordered, cancelled });
				}

				function currentQuestion(): BrainstormQuestion | undefined {
					return questions[currentTab];
				}

				/** Options to display: the question's options + always a "Write your own..." entry. */
				function displayOptions(): Array<{ label: string; isCustom?: boolean }> {
					const q = currentQuestion();
					if (!q) return [];
					const opts: Array<{ label: string; isCustom?: boolean }> = q.options.map((o) => ({ label: o }));
					opts.push({ label: "Write your own answer...", isCustom: true });
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				/** Restore UI state when entering a question tab. */
				function enterQuestion(q: BrainstormQuestion) {
					const existing = answers.get(q.id);
					const draft = drafts.get(q.id);
					if (q.options.length === 0) {
						// No options — go straight to editor
						inputMode = true;
						inputQuestionId = q.id;
						editor.setText(draft ?? (existing?.wasCustom ? existing.answer : ""));
					} else if (existing?.wasCustom) {
						// Previously wrote custom answer — point cursor at "Write your own..."
						optionIndex = q.options.length; // last item = custom entry
					} else if (existing && !existing.wasCustom) {
						// Restore option cursor to previously selected option
						const idx = q.options.indexOf(existing.answer);
						optionIndex = idx >= 0 ? idx : 0;
					} else {
						// Default to recommended option, or first
						optionIndex = q.recommended ?? 0;
					}
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else optionIndex = 0;
					refresh();
				}

				function saveAnswer(qId: string, value: string, wasCustom: boolean) {
					const q = questions.find((qq) => qq.id === qId);
					answers.set(qId, { id: qId, question: q?.question ?? qId, answer: value, wasCustom });
				}

				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim();
					if (!trimmed) {
						// Reject empty submissions — keep editor open
						refresh();
						return;
					}
					drafts.delete(inputQuestionId); // clear draft on successful submit
					saveAnswer(inputQuestionId, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				/** Save current editor text as draft and exit input mode. */
				function exitEditor() {
					if (inputQuestionId) {
						const text = editor.getText();
						if (text.trim()) drafts.set(inputQuestionId, text);
						else drafts.delete(inputQuestionId);
					}
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
				}

				// Initialize first question state
				enterQuestion(questions[0]);

				function handleInput(data: string) {
					// Input mode: route to editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							const q = currentQuestion();
							if (q && q.options.length === 0 && !isMulti) {
								// Single question with no options — cancel entirely
								submit(true);
							} else {
								// Exit editor, save draft for later
								exitEditor();
								refresh();
							}
							return;
						}
						// Allow tab navigation even while in input mode (multi-question only)
						if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
							exitEditor();
							if (matchesKey(data, Key.tab)) {
								currentTab = (currentTab + 1) % totalTabs;
							} else {
								currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							}
							const nq = currentQuestion();
							if (nq) enterQuestion(nq);
							else optionIndex = 0;
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = displayOptions();

					// Tab navigation (multi-question only)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							const nq = currentQuestion();
							if (nq) enterQuestion(nq);
							else optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							const nq = currentQuestion();
							if (nq) enterQuestion(nq);
							else optionIndex = 0;
							refresh();
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					// Select option or enter editor for no-option questions
					if (matchesKey(data, Key.enter) && q) {
						if (q.options.length === 0 || opts[optionIndex]?.isCustom) {
							// Enter editor — restore draft first, then saved answer
							inputMode = true;
							inputQuestionId = q.id;
							const draft = drafts.get(q.id);
							const existing = answers.get(q.id);
							editor.setText(draft ?? (existing?.wasCustom ? existing.answer : ""));
							refresh();
							return;
						}
						const opt = opts[optionIndex];
						saveAnswer(q.id, opt.label, false);
						advanceAfterAnswer();
						return;
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const q = currentQuestion();
					const opts = displayOptions();
					const add = (s: string) => lines.push(truncateToWidth(s, width));
				const addWrapped = (s: string) => lines.push(...wrapTextWithAnsi(s, width));

					add(theme.fg("accent", "\u2500".repeat(width)));

					// Tab bar (multi-question only)
					if (isMulti) {
						const tabs: string[] = ["\u2190 "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].id;
							const box = isAnswered ? "\u25A0" : "\u25A1";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${lbl} `;
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " \u2713 Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} \u2192`);
						add(` ${tabs.join("")}`);
						lines.push("");
					}

					// Render options list
					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const color = selected ? "accent" : "text";
							const isRecommended = !opt.isCustom && q && q.recommended === i;
							const recTag = isRecommended ? theme.fg("success", " \u2605") : "";
							if (opt.isCustom && inputMode) {
								add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} \u270E`));
							} else {
								add(prefix + theme.fg(color, `${i + 1}. ${opt.label}`) + recTag);
							}
						}
					}

					// Content
					if (inputMode && q) {
						addWrapped(theme.fg("text", ` ${q.question}`));
						if (q.context) {
							addWrapped(theme.fg("muted", ` ${q.context}`));
						}
						lines.push("");
						if (q.options.length > 0) {
							renderOptions();
							lines.push("");
						}
						add(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(width - 2)) {
							add(` ${line}`);
						}
						lines.push("");
						add(theme.fg("dim", " Enter to submit \u2022 Esc to cancel"));
					} else if (currentTab === questions.length) {
						// Submit tab
						add(theme.fg("accent", theme.bold(" Ready to submit")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								const prefix = answer.wasCustom ? "(wrote) " : "";
								add(`${theme.fg("muted", ` ${question.id}: `)}${theme.fg("text", prefix + answer.answer)}`);
							} else {
								add(`${theme.fg("muted", ` ${question.id}: `)}${theme.fg("warning", "(unanswered)")}`);
							}
						}
						lines.push("");
						if (allAnswered()) {
							add(theme.fg("success", " Press Enter to submit"));
						} else {
							const missing = questions
								.filter((qq) => !answers.has(qq.id))
								.map((qq) => qq.id)
								.join(", ");
							add(theme.fg("warning", ` Unanswered: ${missing}`));
						}
					} else if (q) {
						// Question view
						addWrapped(theme.fg("text", ` ${q.question}`));
						if (q.context) {
							addWrapped(theme.fg("muted", ` ${q.context}`));
						}
						const existing = answers.get(q.id);
						if (existing) {
							const prefix = existing.wasCustom ? "(wrote) " : "";
							add(theme.fg("dim", ` Current: ${prefix}${existing.answer}`));
						}
						lines.push("");
						if (q.options.length > 0) {
							renderOptions();
						} else {
							// No options — show prompt to enter editor
							add(theme.fg("muted", " Press Enter to write your answer"));
						}
					}

					lines.push("");
					if (!inputMode) {
						const help = isMulti
							? " Tab/\u2190\u2192 navigate \u2022 \u2191\u2193 select \u2022 Enter confirm \u2022 Esc cancel"
							: " \u2191\u2193 navigate \u2022 Enter select \u2022 Esc cancel";
						add(theme.fg("dim", help));
					}
					add(theme.fg("accent", "\u2500".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => { cachedLines = undefined; },
					handleInput,
				};
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "(brainstorm dismissed)" }],
					details: result,
				};
			}

			// Build Q&A records for conversation history
			const records = result.answers.map((a) => {
				const q = questions.find((qq) => qq.id === a.id);
				const lines = [`**Q:** ${a.question}`];
				if (q?.context) lines.push(`\n${q.context}`);
				if (q && q.options.length > 0) lines.push(`\nOptions: ${q.options.join(" / ")}`);
				lines.push(`\n**A:** ${a.answer}`);
				return lines.filter(Boolean).join("");
			});

			return {
				content: [{ type: "text", text: records.join("\n\n---\n\n") }],
				details: result,
			};
		},

		renderCall(args, theme) {
			const qs = (args.questions as Array<{ id: string; question: string }>) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("brainstorm "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as BrainstormResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "(dismissed)"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				const prefix = a.wasCustom ? "(wrote) " : "";
				return `${theme.fg("success", "\u2713 ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", prefix)}${a.answer}`;
			});
			return new Text(lines.join("\n"), 0, 0);
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
			"Code snippets and exact commands are encouraged but not mandatory for every step. " +
			userLanguageRule,
		parameters: Type.Object({
			name: Type.String({ description: "Short plan name, e.g. 'auth-refactor'" }),
			goal: Type.String({ description: "1-3 sentence description of what this builds" }),
			architecture: Type.Optional(Type.String({ description: "2-3 sentences about the approach, key design decisions, and tech involved" })),
			activate: Type.Optional(Type.Boolean({ description: "Activate immediately after creation (default: true). Set false to leave the plan in pending/." })),
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
			}, { description: "Verification criteria defined upfront. Automated commands + manual acceptance checklist. Used by plan_prepare_to_verify and plan_verify at the end." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const title = params.name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
			const planContent = renderPlan(title, params.goal, params.steps, params.architecture, params.verification);
			const activateNow = params.activate !== false;

			const finalizePlanPath = (planPath: string): string => {
				const parentDir = path.basename(path.dirname(planPath));
				if (activateNow) {
					if (parentDir === "pending") {
						appendLog(logFile(planPath), "Plan activated.");
						const dest = safeDestPath(path.join(activeDir(ctx.cwd), path.basename(planPath)));
						ensureDir(activeDir(ctx.cwd));
						fs.renameSync(planPath, dest);
						return dest;
					}
					return planPath;
				}

				if (parentDir === "active") {
					return parkActivePlan(ctx.cwd, planPath);
				}
				return planPath;
			};

			// Check if there's a focused draft plan we should update in-place
			const draft = session.focusedPlan;
			const isDraft = draft && fs.existsSync(planFile(draft)) && fs.readFileSync(planFile(draft), "utf-8").includes("<!-- DRAFT -->");

			if (isDraft) {
				fs.writeFileSync(planFile(draft), planContent, "utf-8");
				appendLog(logFile(draft), "Plan created.");
				const dest = finalizePlanPath(draft);
				session.focusedPlan = activateNow ? dest : undefined;

				if (activateNow) {
					return {
						content: [{ type: "text", text: `Plan created, activated, and focused: ${dest}\nCall plan_execute to begin execution with guidelines.` }],
						details: { planPath: dest },
					};
				}

				return {
					content: [{ type: "text", text: `Plan created and saved for later: ${dest}\nUse plan_activate or /activate-plan when ready.` }],
					details: { planPath: dest },
				};
			}

			// No draft — create a new plan folder directly in its target status directory.
			const dir = activateNow ? activeDir(ctx.cwd) : pendingDir(ctx.cwd);
			ensureDir(dir);
			const folderName = `${ts()}-${slugify(params.name)}`;
			const planDir = safeDestPath(path.join(dir, folderName));
			ensureDir(planDir);

			fs.writeFileSync(planFile(planDir), planContent, "utf-8");
			fs.writeFileSync(logFile(planDir), renderLogHeader(), "utf-8");
			appendLog(logFile(planDir), "Plan created.");

			if (activateNow) {
				appendLog(logFile(planDir), "Plan activated.");
				session.focusedPlan = planDir;
				return {
					content: [{ type: "text", text: `Plan created, activated, and focused: ${planDir}\nCall plan_execute to begin execution with guidelines.` }],
					details: { planPath: planDir },
				};
			}

			session.focusedPlan = undefined;
			return {
				content: [{ type: "text", text: `Plan created and saved for later: ${planDir}\nUse plan_activate or /activate-plan when ready.` }],
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
			"Call this after plan_create activates a plan, or when resuming work on an active plan. " +
			userLanguageRule,
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
				userLanguageRule,
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
				"When a step depends on unfamiliar or uncertain information, do not guess.",
				"Call `plan_research(topic)` only for substantial investigation. Skip it for straightforward steps that you can verify directly.",
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
				"When all steps are complete:",
				"1. **Review** — call `plan_review` to start a code review round. Run an external reviewer, document findings and responses.",
				"2. **Prepare verification** — run ALL automated checks (full test suite, build, lint). Call `plan_prepare_to_verify` with the results and checklist, then wait for the user's manual verification.",
				"3. **Record the outcome** — after the user reports manual verification, call `plan_verify` with status `approved` or `changes_requested`.",
				"4. **Finish** — only call `plan_finish` after `plan_verify` records approval.",
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
			"Operates on the active plan by default. " +
			userLanguageRule,
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
				content = clearVerificationMarkers(content);
			}

			fs.writeFileSync(planFile(planPath), content, "utf-8");

			// Auto-log step changes
			if (params.complete_step !== undefined) {
				const steps = parseSteps(content);
				const step = steps.find((s) => s.index === params.complete_step! - 1);
				appendLog(logFile(planPath), `Completed step ${params.complete_step}${step ? `: ${step.text}` : ""}`);
			}
			if (params.add_step) {
				appendLog(logFile(planPath), `Added step: ${params.add_step}`);
			}

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
		description: "Add a log entry to the plan's log.md. " + userLanguageRule,
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

	// -- plan_review ---------------------------------------------------------

	pi.registerTool({
		name: "plan_review",
		label: "plan review",
		description:
			"Start a code review round. Creates a review document in the plan's reviews/ subfolder. " +
			"Typically called after steps are complete, before plan_prepare_to_verify — but can be used mid-execution too. " +
			"After calling this tool: run an external review (codex, gemini, etc.), write findings into the review doc, " +
			"discuss with the user, make fixes, then write your responses into the Response section. " +
			"Multiple rounds are supported — call again for each round. " +
			userLanguageRule,
		parameters: Type.Object({
			plan_path: Type.Optional(Type.String({ description: "Explicit plan folder path (default: active plan)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanArg(params.plan_path, ctx.cwd, session.focusedPlan);
			const content = fs.readFileSync(planFile(planPath), "utf-8");
			const titleMatch = content.match(/^# (.+)/m);
			const planName = titleMatch?.[1] ?? path.basename(planPath);

			// Determine round number from existing review files (parse max round from filenames)
			const rvDir = planReviewDir(planPath);
			ensureDir(rvDir);
			const existing = fs.existsSync(rvDir) ? fs.readdirSync(rvDir).filter((f) => f.endsWith(".md")) : [];
			let maxRound = 0;
			for (const f of existing) {
				const m = f.match(/round-(\d+)\.md$/);
				if (m) maxRound = Math.max(maxRound, parseInt(m[1], 10));
			}
			const round = maxRound + 1;

			// Create review document
			const reviewFile = safeDestPath(path.join(rvDir, `${ts()}-round-${round}.md`));
			fs.writeFileSync(reviewFile, renderReviewDoc(round, planName), "utf-8");

			const relPath = path.relative(planPath, reviewFile);
			appendLog(logFile(planPath), `Code review round ${round} started → ${relPath}`);

			const relFromCwd = path.relative(ctx.cwd, reviewFile);
			const guidance = [
				`## Code Review — Round ${round}`,
				"",
				`**Review document created:** ${relFromCwd}`,
				"",
				userLanguageRule,
				"",
				"### Steps",
				"",
				"1. **Run external review** — pipe the relevant diff/files to an external reviewer (codex, gemini, or similar) via bash",
				"2. **Record findings** — write the reviewer's output into the `## Findings` section of the review doc",
				"3. **Discuss with user** — go through each finding, decide what to fix vs reject",
				"4. **Make fixes** — implement accepted changes",
				"5. **Record responses** — write your response to each finding in the `## Response` section (accepted/rejected with reasoning)",
				"6. **Log outcome** — call `plan_log` with a summary of the review outcome",
				"",
				"If another round is needed, call `plan_review` again.",
			].join("\n");

			return {
				content: [{ type: "text", text: guidance }],
				details: { reviewFile, planPath, round },
			};
		},
	});

	// -- plan_prepare_to_verify ---------------------------------------------

	pi.registerTool({
		name: "plan_prepare_to_verify",
		label: "plan prepare to verify",
		description:
			"Present the automated verification results and manual checklist that the user must test next. " +
			"Call this after implementation and automated checks are complete, before the user performs manual verification. " +
			"After the user reports the outcome, call plan_verify to record approval or requested changes. " +
			userLanguageRule,
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

			let checklist = params.acceptance_checklist;
			if (!checklist || checklist.length === 0) {
				checklist = parseManualAcceptance(content);
			}
			if (!checklist || checklist.length === 0) {
				checklist = ["All features work as described in the plan goal"];
			}

			content = markVerificationPrepared(content);
			fs.writeFileSync(planFile(planPath), content, "utf-8");
			appendLog(logFile(planPath), `Verification prepared. Automated: ${params.automated_results.split("\n")[0]}`);

			const checklistText = checklist
				.map((item, i) => `${i + 1}. ${item}`)
				.join("\n");

			return {
				content: [{
					type: "text",
					text: [
						`Verification ready: ${planPath}`,
						"",
						userLanguageRule,
						"",
						"Automated test results:",
						params.automated_results,
						"",
						"Manual acceptance checklist:",
						checklistText,
						"",
						"Ask the user to perform these checks. After the user reports the outcome, call `plan_verify` with status `approved` or `changes_requested`.",
					].join("\n"),
				}],
				details: { planPath, checklist, prepared: true },
			};
		},
	});

	// -- plan_verify ---------------------------------------------------------

	pi.registerTool({
		name: "plan_verify",
		label: "plan verify",
		description:
			"Record the outcome of manual verification after the user has completed the checks prepared by plan_prepare_to_verify. " +
			"Call this BEFORE plan_finish. If the user approves, the plan becomes finishable. If the user requests changes, fix them and run plan_prepare_to_verify again later. " +
			userLanguageRule,
		parameters: Type.Object({
			status: Type.Union([
				Type.Literal("approved"),
				Type.Literal("changes_requested"),
			], {
				description: "Outcome after the user completes manual verification.",
			}),
			feedback: Type.Optional(Type.String({
				description: "Optional notes from the user. Useful for manual test observations or requested fixes.",
			})),
			plan_path: Type.Optional(Type.String({ description: "Explicit plan folder path (default: active plan)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanArg(params.plan_path, ctx.cwd, session.focusedPlan);
			let content = fs.readFileSync(planFile(planPath), "utf-8");

			if (hasVerified(content) && !hasPreparedVerification(content) && params.status === "approved") {
				return {
					content: [{ type: "text", text: "Verification is already recorded. Call `plan_finish` to complete the plan." }],
					details: { planPath, verified: true },
				};
			}

			if (!hasPreparedVerification(content)) {
				throw new Error("Verification is not prepared. Run plan_prepare_to_verify first.");
			}

			if (params.status === "approved") {
				content = markVerified(content);
				fs.writeFileSync(planFile(planPath), content, "utf-8");
				appendLog(logFile(planPath), params.feedback ? `Verification passed. User approved. Notes: ${params.feedback}` : "Verification passed. User approved.");
				return {
					content: [{ type: "text", text: "Verification passed. Call `plan_finish` to complete the plan." }],
					details: { planPath, verified: true },
				};
			}

			content = clearVerificationMarkers(content);
			fs.writeFileSync(planFile(planPath), content, "utf-8");
			appendLog(logFile(planPath), `Verification failed. User feedback: ${params.feedback ?? "(no details)"}`);
			return {
				content: [{ type: "text", text: `Verification failed. Fix the issues and run \`plan_prepare_to_verify\` again when ready.\nUser feedback: ${params.feedback ?? "(no details)"}` }],
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
			"You should call plan_prepare_to_verify and plan_verify BEFORE this to run the acceptance phase.",
		parameters: Type.Object({
			summary: Type.Optional(Type.String({ description: "Brief completion summary to log" })),
			plan_path: Type.Optional(Type.String({ description: "Explicit plan folder path (default: active plan)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanArg(params.plan_path, ctx.cwd, session.focusedPlan);
			const dest = finishPlan(planPath, ctx.cwd, session, params.summary);
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
			const dest = abortPlan(planPath, ctx.cwd, session, params.reason);
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
			const dest = resumePlan(planPath, ctx.cwd, params.reason);
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
			// Special case: already active — return info instead of error
			if (path.basename(path.dirname(abs)) === "active" && fs.existsSync(abs)) {
				const summary = planSummary(abs);
				return { content: [{ type: "text", text: `Already active: ${summary}\n${abs}` }], details: {} };
			}
			const dest = activatePlan(abs, ctx.cwd);
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
