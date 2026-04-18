export interface Step {
	index: number;
	done: boolean;
	text: string;
	isCurrent: boolean;
	lineNum: number;
}

export interface PlanEntry {
	name: string;
	path: string;
	summary: string;
}

export interface SessionState {
	focusedPlan: string | undefined;
	planGate: { planPath: string; satisfied: boolean } | undefined;
}
