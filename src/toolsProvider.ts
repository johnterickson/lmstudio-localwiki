import { text, tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import fetch from "node-fetch";
import { configSchematics } from "./config";

const normalizeWhitespace = (s: string) => s.replace(/\s+/g, " ").trim();

function extractText(
	$el: cheerio.Cheerio<AnyNode>,
	$: cheerio.CheerioAPI,
	options: { removeSup?: boolean; externalLinksAsUrl?: boolean } = {}
): string {
	let result = "";
	$el.contents().each((_, node) => {
		if (node.type === "text") {
			result += $(node).text();
		} else if (node.type === "tag") {
			const tag = (node as Element).tagName?.toLowerCase();
			if (tag === "sup" && options.removeSup) {
				return;
			}
			if (tag === "a") {
				const href = $(node).attr("href") || "";
				const linkText = $(node).text().trim();
				if (options.externalLinksAsUrl && /^https?:\/\//i.test(href)) {
					result += `${linkText} <${href}>`;
				} else {
					result += linkText;
				}
			} else {
				result += extractText($(node), $, options);
			}
		}
	});
	return result;
}

function findSection(
	$: cheerio.CheerioAPI,
	headingText: string
): { $section: cheerio.Cheerio<AnyNode>; siblings: cheerio.Cheerio<AnyNode>[] } | null {
	const $heading = $("h1, h2, h3, h4, h5, h6")
	.filter((_, el) => $(el).text().trim().toLowerCase() === headingText)
	.first();
	if (!$heading.length) return null;

	let $section = $heading;
	if ($heading.parent().hasClass("mw-heading")) {
		$section = $heading.parent();
	}

	const headingTag = $heading.prop("tagName");
	if (!headingTag) return null;
	const level = parseInt(headingTag.substring(1));
	const siblings: cheerio.Cheerio<AnyNode>[] = [];
	let $next = $section.next();

	while ($next.length) {
		const tagName = $next.prop("tagName")?.toLowerCase();
		if (tagName && /^h[1-6]$/.test(tagName)) {
			const nextLevel = parseInt(tagName.substring(1));
			if (nextLevel <= level) break;
		} else if ($next.is("div.mw-heading")) {
			const innerH = $next.find("h1, h2, h3, h4, h5, h6").first();
			const innerTag = innerH.prop("tagName");
			if (innerTag) {
				const nextLevel = parseInt(innerTag.substring(1));
				if (nextLevel <= level) break;
			}
		}
		siblings.push($next);
		$next = $next.next();
	}

	return { $section, siblings };
}

function removeReferencesSection($: cheerio.CheerioAPI): void {
	const section = findSection($, "references");
	if (!section) return;
	section.siblings.forEach(el => $(el).remove());
	section.$section.remove();
}

const MAX_REDIRECTS = 5;

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly url: string,
		readonly responseBody: string
	) {
		super(`HTTP ${status}`);
		this.name = "HttpError";
	}
}

function summarizeResponseBody(body: string): string {
	if (!body) return "";
	const $ = cheerio.load(body);
	return normalizeWhitespace($.text()).slice(0, 200);
}

function decodeHtmlEntities(value: string): string {
	return cheerio.load(value).text();
}

async function fetchWithRedirects(
	initialUrl: string,
	redirectCount = 0
): Promise<{ html: string; finalUrl: string; fragment: string | null }> {
	if (redirectCount >= MAX_REDIRECTS) {
		throw new Error(`Too many redirects (limit: ${MAX_REDIRECTS}) while fetching ${initialUrl}`);
	}

	const resp = await fetch(initialUrl);
	if (!resp.ok) {
		const body = await resp.text().catch(() => "");
		throw new HttpError(resp.status, resp.url || initialUrl, body);
	}

	const currentUrl = resp.url;
	const html = await resp.text();

	const $ = cheerio.load(html);
	const metaRefresh = $('meta[http-equiv="refresh"]').first();
	if (metaRefresh.length) {
		const content = metaRefresh.attr("content") || "";
		const match = content.match(/^\d+\s*;\s*URL=(.*)$/i);
		if (match) {
			let refreshTarget = match[1].trim();
			if (refreshTarget.startsWith('"') && refreshTarget.endsWith('"')) {
				refreshTarget = refreshTarget.slice(1, -1);
			}
			if (refreshTarget.startsWith("'") && refreshTarget.endsWith("'")) {
				refreshTarget = refreshTarget.slice(1, -1);
			}
			const nextUrl = new URL(refreshTarget, currentUrl);
			const fragment = nextUrl.hash ? nextUrl.hash.slice(1) : null;
			const nextUrlWithoutHash = nextUrl.origin + nextUrl.pathname + nextUrl.search;
			const result = await fetchWithRedirects(nextUrlWithoutHash, redirectCount + 1);
			return {
				html: result.html,
				finalUrl: result.finalUrl,
				fragment: result.fragment ?? fragment,
			};
		}
	}

	const inputUrlObj = new URL(initialUrl);
	const fragmentFromInput = inputUrlObj.hash ? inputUrlObj.hash.slice(1) : null;
	return { html, finalUrl: currentUrl.split("#")[0], fragment: fragmentFromInput };
}

function tableToMarkdown($table: cheerio.Cheerio<AnyNode>, $: cheerio.CheerioAPI): string {
	const rows: string[][] = [];
	let maxCols = 0;
	let hasHeader = false;

	$table.find("tr").each((_, tr) => {
		const $tr = $(tr);
		const cells: string[] = [];
		$tr.children("th, td").each((_, cell) => {
			const $cell = $(cell);
			let cellText = normalizeWhitespace(
				extractText($cell, $, { removeSup: false, externalLinksAsUrl: true })
			);
			cellText = cellText.replace(/\|/g, "\\|");
			cells.push(cellText);
		});
		if (cells.length === 0) return;
		rows.push(cells);
		maxCols = Math.max(maxCols, cells.length);
		if (rows.length === 1 && $tr.children("th").length > 0) {
			hasHeader = true;
		}
	});

	if (rows.length === 0) return "";

	const paddedRows = rows.map(row => {
		while (row.length < maxCols) row.push("");
		return row;
	});

	const lines: string[] = [];
	for (let i = 0; i < paddedRows.length; i++) {
		const row = paddedRows[i];
		lines.push(`| ${row.join(" | ")} |`);
		if (hasHeader && i === 0) {
			const separator = Array(maxCols).fill("---").join(" | ");
			lines.push(`| ${separator} |`);
		}
	}
	return lines.join("\n");
}

type ArticleBlock = {
	text: string;
	tableHeader?: string[];
	tableRows?: string[];
};

type ArticleSection = {
	id: string;
	title: string;
	level: number;
	blocks: ArticleBlock[];
};

function headingDetails($el: cheerio.Cheerio<AnyNode>): Omit<ArticleSection, "blocks"> | null {
	const $heading = $el.is("h1, h2, h3, h4, h5, h6")
		? $el
		: $el.is("div.mw-heading")
			? $el.find("h1, h2, h3, h4, h5, h6").first()
			: null;
	if (!$heading?.length) return null;

	const tagName = $heading.prop("tagName")?.toLowerCase();
	if (!tagName) return null;
	const title = normalizeWhitespace($heading.clone().find(".mw-editsection").remove().end().text());
	return {
		id: $heading.attr("id") || $heading.find("[id]").first().attr("id") || title,
		title,
		level: Number(tagName.slice(1)),
	};
}

function elementToBlocks(
	$el: cheerio.Cheerio<AnyNode>,
	$: cheerio.CheerioAPI
): ArticleBlock[] {
	const tag = $el.prop("tagName")?.toLowerCase();
	if (!tag || ["figure", "style", "script"].includes(tag)) return [];

	const heading = headingDetails($el);
	if (heading) return [];

	if (tag === "p") {
		const paragraph = normalizeWhitespace(
			extractText($el, $, { removeSup: false, externalLinksAsUrl: true })
		);
		return paragraph ? [{ text: paragraph }] : [];
	}

	if (tag === "ul" || tag === "ol") {
		const marker = tag === "ol" ? "1." : "-";
		const items: ArticleBlock[] = [];
		$el.children("li").each((_, li) => {
			const item = normalizeWhitespace(
				extractText($(li), $, { removeSup: false, externalLinksAsUrl: true })
			);
			if (item) items.push({ text: `${marker} ${item}` });
		});
		return items;
	}

	if (tag === "table") {
		const nestedTables = $el.find("table").filter((_, table) =>
			$(table).parents("table").first().is($el)
		);
		if (nestedTables.length) {
			const blocks: ArticleBlock[] = [];
			nestedTables.each((_, table) => {
				blocks.push(...elementToBlocks($(table), $));
			});
			return blocks;
		}

		const markdown = tableToMarkdown($el, $);
		if (!markdown) return [];
		const lines = markdown.split("\n");
		const hasHeader = lines.length > 1 && /^\|(?:\s*---\s*\|)+$/.test(lines[1]);
		return [{
			text: markdown,
			tableHeader: hasHeader ? lines.slice(0, 2) : undefined,
			tableRows: hasHeader ? lines.slice(2) : lines,
		}];
	}

	if (tag === "div") {
		const blocks: ArticleBlock[] = [];
		$el.children().each((_, child) => {
			blocks.push(...elementToBlocks($(child), $));
		});
		if (blocks.length) return blocks;
	}

	const content = normalizeWhitespace(
		extractText($el, $, { removeSup: false, externalLinksAsUrl: true })
	);
	return content ? [{ text: content }] : [];
}

function parseArticle($: cheerio.CheerioAPI): ArticleSection[] {
	const container = $(".mw-parser-output").first();
	if (!container.length) return [];

	const sections: ArticleSection[] = [{ id: "lead", title: "Lead", level: 1, blocks: [] }];
	let currentSection = sections[0];
	container.children().each((_, element) => {
		const $element = $(element);
		const heading = headingDetails($element);
		if (heading) {
			currentSection = { ...heading, blocks: [] };
			sections.push(currentSection);
		}
		currentSection.blocks.push(...elementToBlocks($element, $));
	});
	return sections.filter(section => section.blocks.length > 0);
}

function splitTableBlock(block: ArticleBlock, limit: number): string[] {
	if (!block.tableRows || block.text.length <= limit) return [block.text];
	const header = block.tableHeader ?? [];
	const segments: string[] = [];
	let lines = [...header];

	for (const row of block.tableRows) {
		const candidate = [...lines, row].join("\n");
		if (lines.length > header.length && candidate.length > limit) {
			segments.push(lines.join("\n"));
			lines = [...header, row];
		} else {
			lines.push(row);
		}
	}
	if (lines.length > header.length || (header.length === 0 && lines.length > 0)) {
		segments.push(lines.join("\n"));
	}
	return segments;
}

function segmentBlocks(blocks: ArticleBlock[], limit: number): string[] {
	if (limit === -1) return [blocks.map(block => block.text).join("\n\n")];
	const atomicBlocks = blocks.flatMap(block => splitTableBlock(block, limit));
	const segments: string[] = [];
	let current = "";

	for (const block of atomicBlocks) {
		const candidate = current ? `${current}\n\n${block}` : block;
		if (current && candidate.length > limit) {
			segments.push(current);
			current = block;
		} else {
			current = candidate;
		}
	}
	if (current || segments.length === 0) segments.push(current);
	return segments;
}

export async function toolsProvider(ctl: ToolsProviderController) {
	const config = ctl.getPluginConfig(configSchematics);
	const baseUrl = config.get("kiwixBaseUrl");
	const searchLimit = config.get("searchLimit");
	const searchSummaryEnabled = config.get("searchSummary");
	const charLimit = config.get("charLimit");
	let bookNamePromise: Promise<string> | undefined;
	if (charLimit === 0 || charLimit < -1) {
		throw new Error("Character limit must be -1 or a positive integer");
	}

	const getBookName = () => {
		bookNamePromise ??= (async () => {
			const url = new URL("/catalog/v2/entries?count=-1", baseUrl).toString();
			const resp = await fetch(url);
			if (!resp.ok) {
				const body = await resp.text().catch(() => "");
				throw new Error(`Failed to fetch ${url} (${resp.status}): ${body.slice(0, 200)}`);
			}
			const xmlText = await resp.text();
			const $ = cheerio.load(xmlText, { xmlMode: true });
			const entry = $("entry").first();
			const linkHref = entry.find('link[type="text/html"]').attr("href")?.trim();
			const name = linkHref ? linkHref.replace(/^\/content\//, "") : "";
			if (!name) {
				throw new Error("Kiwix catalog does not contain a usable book");
			}
			return name;
		})();
		return bookNamePromise;
	};

	const searchArticles = async (query: string) => {
		const name = await getBookName();
		const params = new URLSearchParams({
			"books.name": name,
			pattern: query,
		});
		const url = new URL(`/search?${params.toString()}`, baseUrl).toString();
		const suggestionParams = new URLSearchParams({
			content: name,
			term: query,
			count: "1",
			start: "0",
		});
		const suggestionUrl = new URL(`/suggest?${suggestionParams.toString()}`, baseUrl).toString();
		let resp;
		let suggestionResp;
		try {
			[resp, suggestionResp] = await Promise.all([fetch(url), fetch(suggestionUrl)]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Unable to reach Kiwix while searching name="${name}" for query="${query}" at ${url}. ` +
				`Check the configured Kiwix Endpoint and confirm the server is running. Cause: ${message}`
			);
		}
		if (!resp.ok) {
			const body = await resp.text().catch(() => "");
			const responseSummary = summarizeResponseBody(body);
			throw new Error(
				`Kiwix returned HTTP ${resp.status} while searching name="${name}" for query="${query}" ` +
				`at ${resp.url || url}.${responseSummary ? ` Response: ${responseSummary}` : ""}`
			);
		}
		if (!suggestionResp.ok) {
			const body = await suggestionResp.text().catch(() => "");
			const responseSummary = summarizeResponseBody(body);
			throw new Error(
				`Kiwix returned HTTP ${suggestionResp.status} while finding an exact or prefix title match ` +
				`for name="${name}" and query="${query}" at ${suggestionResp.url || suggestionUrl}.` +
				`${responseSummary ? ` Response: ${responseSummary}` : ""}`
			);
		}

		let suggestions: unknown;
		try {
			suggestions = JSON.parse(await suggestionResp.text());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Kiwix returned invalid suggestion JSON from ${suggestionUrl}. Cause: ${message}`);
		}
		if (!Array.isArray(suggestions)) {
			throw new Error(`Kiwix returned an unexpected suggestion response from ${suggestionUrl}.`);
		}

		const prefixResults: Array<{ title: string; path: string }> = [];
		for (const suggestion of suggestions) {
			if (
				typeof suggestion === "object" &&
				suggestion !== null &&
				"kind" in suggestion &&
				suggestion.kind === "path" &&
				"value" in suggestion &&
				typeof suggestion.value === "string" &&
				"path" in suggestion &&
				typeof suggestion.path === "string"
			) {
				prefixResults.push({
					title: decodeHtmlEntities(suggestion.value),
					path: decodeHtmlEntities(suggestion.path),
				});
			}
		}

		const html = await resp.text();
		const $ = cheerio.load(html);

		const results: Array<{ title: string; path: string } & Partial<{ summary: string }>> = [];
		const prefix = `/content/${name}/`;
		$("div.results li").each((_, li) => {
			const $a = $(li).find("a").first();
			const title = $a.text().trim();
			const href = $a.attr("href") || "";
			if (!href.startsWith(prefix)) {
				console.warn(`Skipping search result with unexpected href: ${href}`);
				return;
			}
			const path = href.slice(prefix.length);
			if (title && path) {
				const result: any = { title, path };
				if (searchSummaryEnabled) {
					result.summary = normalizeWhitespace($(li).find("cite").text());
				}
				results.push(result);
			}
		});
		const seenPaths = new Set<string>();
		const mergedResults = [...prefixResults, ...results].filter(result => {
			if (seenPaths.has(result.path)) return false;
			seenPaths.add(result.path);
			return true;
		});

		return {
			results: mergedResults.slice(0, searchLimit),
			hint: text`If the results are irrelevant or empty, try shortening the search query.`
		};
	};

	const loadArticleSections = async (path: string) => {
		const name = await getBookName();
		const articlePath = path.split("#")[0];
		const initialUrl = new URL(`/content/${name}/${articlePath}`, baseUrl).toString();
		let result: Awaited<ReturnType<typeof fetchWithRedirects>>;

		try {
			result = await fetchWithRedirects(initialUrl);
		} catch (error) {
			if (error instanceof HttpError) {
				if (error.status === 404) return null;
				const responseSummary = summarizeResponseBody(error.responseBody);
				throw new Error(
					`Kiwix returned HTTP ${error.status} while fetching name="${name}" and path="${articlePath}" ` +
					`from ${error.url}.${responseSummary ? ` Response: ${responseSummary}` : ""}`
				);
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Unable to reach Kiwix while fetching name="${name}" and path="${articlePath}" from ${initialUrl}. ` +
				`Check the configured Kiwix Endpoint and confirm the server is running. Cause: ${message}`
			);
		}

		const $ = cheerio.load(result.html);
		if (!$(`.mw-parser-output`).length) {
			throw new Error(`Article content not found after following redirects (final URL: ${result.finalUrl})`);
		}
		removeReferencesSection($);
		return parseArticle($);
	};

	const wikiSearchTool = tool({
		name: "wiki_search",
		description: text`
		Search the local Wikipedia book for articles. Returns the first exact or prefix title match first,
		followed by full-text matches, with duplicate paths removed.
		Parameters:
		- query (required): search term.
		Returns relevant articles with 'title' and 'path'.
		There could be an extra 'summary' section if the user enables it.
		Use the 'path' field (NOT 'title') in 'wiki_fetch' tool to retrieve the article.
		`,
	parameters: {
		query: z
			.string()
			.trim()
			.min(1, "query is required and cannot be empty")
			.describe("Non-empty article search term"),
	},
	implementation: async ({ query }) => searchArticles(query),
	});

	const wikiSectionsTool = tool({
		name: "wiki_sections",
		description: text`
		List an article's sections before fetching content.
		Parameters:
		- path (required): exact article path from wiki_search.
		Returns concise section IDs and titles for wiki_fetch.
		`,
		parameters: {
			path: z.string().trim().min(1, "path is required").describe("Exact article path from wiki_search"),
		},
		implementation: async ({ path }) => {
			const sections = await loadArticleSections(path);
			if (!sections) return searchArticles(path.replace(/_/g, " "));
			return {
				sections: sections.map(section => ({
					id: section.id,
					title: section.title,
					level: section.level,
				})),
			};
		},
	});

	const wikiFetchTool = tool({
		name: "wiki_fetch",
		description: text`
		Fetch one intelligently segmented article section, excluding References.
		Parameters:
		- path (required): exact article path from wiki_search.
		- section (required): exact section ID from wiki_sections.
		- segment (optional, defaults to 1): 1-based segment. Segments preserve complete Markdown blocks and table rows.
		`,
	parameters: {
		path: z
			.string()
			.trim()
			.min(1, "path is required; call wiki_search and use its exact path field")
			.describe("Exact article path returned by wiki_search for the same book"),
		section: z.string().trim().min(1, "section is required; call wiki_sections first"),
		segment: z.number().int().min(1).default(1).describe("1-based section segment number"),
	},
	implementation: async ({ path, section, segment }) => {
		const sections = await loadArticleSections(path);
		if (!sections) return searchArticles(path.replace(/_/g, " "));
		const selected = sections.find(candidate => candidate.id === section);
		if (!selected) throw new Error(`Unknown section ID: ${section}`);

		const segments = segmentBlocks(selected.blocks, charLimit);
		if (segment > segments.length) {
			throw new Error(`Segment ${segment} is out of range (total segments: ${segments.length})`);
		}
		return {
			content: segments[segment - 1],
			section: { id: selected.id, title: selected.title },
			pagination: {
				segment,
				totalSegments: segments.length,
				hasPreviousSegment: segment > 1,
				hasNextSegment: segment < segments.length,
			},
		};
	},
	});

	return [wikiSearchTool, wikiSectionsTool, wikiFetchTool];
}