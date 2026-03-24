import fs from "node:fs";
import { logTs } from "./utils.js";
import type { Step, Verification } from "./types.js";

export function renderPlan(title: string, goal: string, steps: string[], architecture?: string, verification?: Verification): string {
	const lines: string[] = [];
	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`> Created: ${logTs()}`);
	lines.push("");
	lines.push(`**Goal:** ${goal}`);
	if (architecture) {
		lines.push("");
		lines.push(`**Architecture:** ${architecture}`);
	}
	lines.push("");
	lines.push("---");
	lines.push("");
	lines.push("## Steps");
	lines.push("");
	for (let i = 0; i < steps.length; i++) {
		const marker = i === 0 ? "**" : "";
		const arrow = i === 0 ? " ← current" : "";
		lines.push(`- [ ] ${marker}${steps[i]}${marker}${arrow}`);
	}
	lines.push("");
	if (verification && (verification.automated?.length || verification.manual?.length)) {
		lines.push("## Verification");
		lines.push("");
		if (verification.automated?.length) {
			lines.push("### Automated Checks");
			for (const cmd of verification.automated) {
				lines.push(`- \`${cmd}\``);
			}
			lines.push("");
		}
		if (verification.manual?.length) {
			lines.push("### Manual Acceptance");
			for (const item of verification.manual) {
				lines.push(`- [ ] ${item}`);
			}
			lines.push("");
		}
	}
	return lines.join("\n");
}

/** Extract manual acceptance items from plan content. Case-insensitive, tolerates formatting variations. */
export function parseManualAcceptance(content: string): string[] {
	const lines = content.split("\n");
	let inSection = false;
	const items: string[] = [];

	for (const line of lines) {
		if (/^#{2,4}\s+manual\s+acceptance/i.test(line)) {
			inSection = true;
			continue;
		}
		if (inSection && (/^#{2,4}\s+/.test(line) || /^---+\s*$/.test(line))) {
			break;
		}
		if (!inSection) continue;

		const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.+)/);
		if (m) {
			const text = m[1].replace(/\*\*/g, "").trim();
			if (text) items.push(text);
		}
	}
	return items;
}

/** Parse step lines from plan content. Only parses checkboxes within the ## Steps section. */
export function parseSteps(content: string): Step[] {
	const lines = content.split("\n");
	const steps: Step[] = [];
	let inSteps = false;
	let stepIdx = 0;
	for (let i = 0; i < lines.length; i++) {
		if (/^##\s+steps/i.test(lines[i])) { inSteps = true; continue; }
		if (inSteps && /^##\s+/.test(lines[i])) break;
		if (!inSteps) continue;
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

export function completeStep(content: string, stepIndex: number): string {
	const lines = content.split("\n");
	const steps = parseSteps(content);
	const step = steps[stepIndex];
	if (!step) throw new Error(`Step ${stepIndex + 1} not found. Plan has ${steps.length} steps.`);
	if (step.done) throw new Error(`Step ${stepIndex + 1} is already completed.`);

	// Clear ALL existing current markers first
	for (const s of steps) {
		if (s.isCurrent) {
			lines[s.lineNum] = lines[s.lineNum]
				.replace(/\*\*/g, "")
				.replace(/\s*← current\s*$/, "");
		}
	}

	// Mark the step as done
	lines[step.lineNum] = `- [x] ${step.text}`;

	// Find earliest remaining incomplete step and mark it as current
	const nextIncomplete = steps.find((s) => s.index !== stepIndex && !s.done);
	if (nextIncomplete) {
		const plainText = lines[nextIncomplete.lineNum].match(/^- \[[ xX]\] (.+)/)?.[1]?.replace(/\*\*/g, "").replace(/\s*← current\s*$/, "").trim() || nextIncomplete.text;
		lines[nextIncomplete.lineNum] = `- [ ] **${plainText}** ← current`;
	}

	return lines.join("\n");
}

export function addStep(content: string, text: string, afterIndex?: number): string {
	const lines = content.split("\n");
	const steps = parseSteps(content);

	// If no incomplete step has current marker, this new step should become current
	const hasCurrent = steps.some((s) => s.isCurrent);
	const allDone = steps.length > 0 && steps.every((s) => s.done);
	const markAsCurrent = !hasCurrent || allDone;
	const newLine = markAsCurrent ? `- [ ] **${text}** ← current` : `- [ ] ${text}`;

	if (afterIndex !== undefined) {
		const after = steps[afterIndex];
		if (!after) throw new Error(`Step ${afterIndex + 1} not found.`);
		lines.splice(after.lineNum + 1, 0, newLine);
	} else {
		const lastStep = steps[steps.length - 1];
		if (lastStep) {
			lines.splice(lastStep.lineNum + 1, 0, newLine);
		} else {
			// No steps found — append at the end of the steps section or file
			lines.push(newLine, "");
		}
	}

	return lines.join("\n");
}

export function renderResearchDoc(topic: string, planName?: string): string {
	const lines: string[] = [];
	lines.push(`# Research: ${topic}`);
	lines.push("");
	lines.push(`> Date: ${logTs()}`);
	lines.push(`> Plan: ${planName ?? "standalone"}`);
	lines.push("");
	lines.push("## Findings");
	lines.push("");
	lines.push("");
	lines.push("## Conclusion");
	lines.push("");
	lines.push("");
	return lines.join("\n");
}

/** Render a minimal draft plan.md. Used when /start-plan creates a placeholder before brainstorming. */
export function renderDraftPlan(title: string): string {
	const lines: string[] = [];
	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`> Created: ${logTs()}`);
	lines.push("");
	lines.push("<!-- DRAFT -->");
	lines.push("");
	return lines.join("\n");
}

export function markAsDraft(content: string): string {
	const withoutMarker = content.replace(/\n*<!-- DRAFT -->\s*$/, "").trimEnd();
	return `${withoutMarker}\n\n<!-- DRAFT -->\n`;
}

export function renderReviewDoc(round: number, planName?: string): string {
	const lines: string[] = [];
	lines.push(`# Code Review — Round ${round}`);
	lines.push("");
	lines.push(`> Date: ${logTs()}`);
	lines.push(`> Plan: ${planName ?? "unknown"}`);
	lines.push("");
	lines.push("## Changes Reviewed");
	lines.push("");
	lines.push("");
	lines.push("## Findings");
	lines.push("");
	lines.push("");
	lines.push("## Response");
	lines.push("");
	lines.push("");
	return lines.join("\n");
}

/** Return initial content for a new log.md file. */
export function renderLogHeader(): string {
	return `# Plan Log\n\n> Append-only operation log\n`;
}

/** Append a timestamped log entry to a log file. Creates the file with a header if it doesn't exist. */
export function appendLog(logFilePath: string, message: string): void {
	let content: string;
	if (fs.existsSync(logFilePath)) {
		content = fs.readFileSync(logFilePath, "utf-8");
	} else {
		content = renderLogHeader();
	}
	const trimmed = content.trimEnd();
	const updated = `${trimmed}\n\n**${logTs()}** -- ${message}\n`;
	fs.writeFileSync(logFilePath, updated, "utf-8");
}
