import assert from "node:assert/strict";
import test from "node:test";
import * as cheerio from "cheerio";
import { tableToMarkdown } from "./toolsProvider";

test("tableToMarkdown preserves line breaks inside cells", () => {
	const $ = cheerio.load(`
		<table>
			<tr><th>Field size</th><td><b>Left Field</b> - 347 feet<br><b>Center Field</b> - 415 feet<br>Backstop - 56 feet</td></tr>
		</table>
	`);

	assert.equal(
		tableToMarkdown($("table"), $),
		"| Field size | Left Field - 347 feet<br>Center Field - 415 feet<br>Backstop - 56 feet |\n| --- | --- |",
	);
});