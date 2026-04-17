export const userLanguageRule =
	"Match the user's language as closely as possible for plan titles, goals, architecture notes, step text, brainstorm questions, research notes, review notes, verification checklists, and log entries unless the user explicitly requests another language. Keep code, commands, file paths, API names, and quoted external text in their original form.";

export const userLanguageSection = [
	"## Language Consistency",
	"",
	"Match the user's language as closely as possible across all plan artifacts.",
	"- Write plan titles, goals, architecture notes, step text, brainstorm questions, research notes, review notes, verification checklists, and log entries in the user's language unless the user explicitly requests another language.",
	"- If the user mixes languages, follow the dominant language of the current request.",
	"- Keep code, commands, file paths, API names, and quoted external text in their original form.",
].join("\n");
