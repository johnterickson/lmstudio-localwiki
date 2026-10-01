import assert from "node:assert/strict";
import test from "node:test";
import { articlePathNotFoundMessage, repeatedToolCallMessage } from "./toolGuidance";

test("missing article guidance directs callers through wiki_search", () => {
	const message = articlePathNotFoundMessage("George H. W. Bush");
	assert.match(message, /Call wiki_search first/);
	assert.match(message, /exact path returned/);
});

test("repeated fetch guidance directs callers through the native next pointer", () => {
	const message = repeatedToolCallMessage("wiki_fetch");
	assert.match(message, /section_id/);
	assert.match(message, /section_page/);
	assert.match(message, /next object unchanged/);
	assert.match(message, /next is null, stop/);
});

test("repeated search and section guidance tells callers how to make progress", () => {
	assert.match(repeatedToolCallMessage("wiki_search"), /fewer, more distinctive terms/);
	assert.match(repeatedToolCallMessage("wiki_sections"), /earlier section list/);
});