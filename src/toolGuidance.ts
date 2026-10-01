export function articlePathNotFoundMessage(path: string): string {
	return `Article path not found: "${path}". Call wiki_search first and use an exact path returned by that tool.`;
}

export function repeatedToolCallMessage(toolName: string): string {
	if (toolName === "wiki_fetch") {
		return "Repeated identical wiki_fetch call. Use the earlier result. To continue, copy section_id and section_page from its next object unchanged; if next is null, stop fetching this article.";
	}
	if (toolName === "wiki_sections") {
		return "Repeated identical wiki_sections call. Use the earlier section list, or change the article path.";
	}
	if (toolName === "wiki_search") {
		return "Repeated identical wiki_search call. Use the earlier results, or retry with fewer, more distinctive terms.";
	}
	return `Repeated identical ${toolName} call. Use the earlier result, or change the arguments.`;
}