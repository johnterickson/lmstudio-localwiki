import { text, tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import * as cheerio from "cheerio";
import fetch from "node-fetch";
import { configSchematics } from "./config";

const normalizeWhitespace = (s: string) => s.replace(/\s+/g, " ").trim();

function extractText(
	$el: cheerio.Cheerio,
	$: cheerio.CheerioAPI,
	options: { removeSup?: boolean; externalLinksAsUrl?: boolean } = {}
): string {
	let result = "";
	$el.contents().each((_, node) => {
		if (node.type === "text") {
			result += $(node).text();
		} else if (node.type === "tag") {
			const tag = (node as cheerio.TagElement).tagName?.toLowerCase();
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
): { $section: cheerio.Cheerio; siblings: cheerio.Cheerio[] } | null {
	const $heading = $("h1, h2, h3, h4, h5, h6")
	.filter((_, el) => $(el).text().trim().toLowerCase() === headingText)
	.first();
	if (!$heading.length) return null;

	let $section = $heading;
	if ($heading.parent().hasClass("mw-heading")) {
		$section = $heading.parent();
	}

	const level = parseInt($heading.prop("tagName").substring(1));
	const siblings: cheerio.Cheerio[] = [];
	let $next = $section.next();

	while ($next.length) {
		const tagName = $next.prop("tagName")?.toLowerCase();
		if (tagName && /^h[1-6]$/.test(tagName)) {
			const nextLevel = parseInt(tagName.substring(1));
			if (nextLevel <= level) break;
		} else if ($next.is("div.mw-heading")) {
			const innerH = $next.find("h1, h2, h3, h4, h5, h6").first();
			if (innerH.length) {
				const nextLevel = parseInt(innerH.prop("tagName").substring(1));
				if (nextLevel <= level) break;
			}
		}
		siblings.push($next);
		$next = $next.next();
	}

	return { $section, siblings };
}

function extractReferencesArray($: cheerio.CheerioAPI): string[] {
	const section = findSection($, "references");
	if (!section) return [];

	const sectionHtml = section.siblings.map(el => $.html(el)).join("");
	if (!sectionHtml) return [];

	const $sec = cheerio.load(`<div>${sectionHtml}</div>`);
	const $lists = $sec("ol.references").length
	? $sec("ol.references")
	: $sec("ol");
	if (!$lists.length) return [];

	const lines: string[] = [];
	$lists.find("li").each((_, li) => {
		const $li = $sec(li).clone();
		$li.find(".mw-cite-backlink").remove();
		const line = extractText($li, $sec, {
			removeSup: false,
			externalLinksAsUrl: true,
		});
		lines.push(normalizeWhitespace(line));
	});
	return lines;
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

function extractSubsectionByFragment(
	$: cheerio.CheerioAPI,
	container: cheerio.Cheerio,
	fragment: string
): string | null {
	const headingText = decodeURIComponent(fragment.replace(/_/g, " ")).trim();
	const $heading = container
	.find("h1, h2, h3, h4, h5, h6")
	.filter((_, el) => $(el).text().trim().toLowerCase() === headingText.toLowerCase())
	.first();
	if (!$heading.length) return null;

	let $section = $heading;
	if ($heading.parent().hasClass("mw-heading")) {
		$section = $heading.parent();
	}

	const level = parseInt($heading.prop("tagName").substring(1));
	const output: string[] = [];

	output.push($heading.text().trim());

	let $next = $section.next();
	while ($next.length) {
		const tagName = $next.prop("tagName")?.toLowerCase();
		if (tagName && /^h[1-6]$/.test(tagName)) {
			const nextLevel = parseInt(tagName.substring(1));
			if (nextLevel <= level) break;
		} else if ($next.is("div.mw-heading")) {
			const innerH = $next.find("h1, h2, h3, h4, h5, h6").first();
			if (innerH.length) {
				const nextLevel = parseInt(innerH.prop("tagName").substring(1));
				if (nextLevel <= level) break;
			}
		}

		const tag = tagName;
		if (!tag) {
			$next = $next.next();
			continue;
		}
		if (["table", "figure", "style", "script"].includes(tag)) {
			$next = $next.next();
			continue;
		}

		if (tag === "p") {
			const text = normalizeWhitespace(
				extractText($next, $, { removeSup: true, externalLinksAsUrl: true })
			);
			if (text) output.push(text);
		} else if (tag === "ul" || tag === "ol") {
			const isOrdered = tag === "ol";
			$next.children("li").each((_, li) => {
				const liText = normalizeWhitespace(
					extractText($(li), $, { removeSup: true, externalLinksAsUrl: true })
				);
				output.push(`${isOrdered ? "1." : "-"} ${liText}`);
			});
		} else {
			const text = normalizeWhitespace(
				extractText($next, $, { removeSup: true, externalLinksAsUrl: true })
			);
			if (text) output.push(text);
		}
		$next = $next.next();
	}

	return output.join("\n\n");
}

function tableToMarkdown($table: cheerio.Cheerio, $: cheerio.CheerioAPI): string {
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

export async function toolsProvider(ctl: ToolsProviderController) {
	const config = ctl.getPluginConfig(configSchematics);
	const baseUrl = config.get("kiwixBaseUrl");
	const searchLimit = config.get("searchLimit");
	const searchSummaryEnabled = config.get("searchSummary");
	const charLimit = config.get("charLimit");

	const paginate = (content: string, page: number) => {
		if (charLimit === 0 || charLimit < -1) {
			throw new Error("Character limit must be -1 or a positive integer");
		}

		const pageSize = charLimit === -1 ? Math.max(content.length, 1) : charLimit;
		const totalPages = Math.max(1, Math.ceil(content.length / pageSize));
		if (page > totalPages) {
			throw new Error(`Page ${page} is out of range (total pages: ${totalPages})`);
		}

		const start = (page - 1) * pageSize;
		return {
			content: content.slice(start, start + pageSize),
			pagination: {
				page,
				pageSize: charLimit === -1 ? null : pageSize,
				totalPages,
				totalCharacters: content.length,
				hasPreviousPage: page > 1,
				hasNextPage: page < totalPages,
			},
		};
	};

	const wikiListTool = tool({
		name: "wiki_list",
		description: text`
		Lists all available books.
		You MUST invoke this tool first to get the book names for your other tool calls.
		Use the the 'name' field (NOT 'title') for other tools.
		If you can't find relevant results in one book, try another.
		`,
		parameters: {},
		implementation: async () => {
			const url = new URL("/catalog/v2/entries?count=-1", baseUrl).toString();
			const resp = await fetch(url);
			if (!resp.ok) {
				const body = await resp.text().catch(() => "");
				throw new Error(`Failed to fetch ${url} (${resp.status}): ${body.slice(0, 200)}`);
			}
			const xmlText = await resp.text();
			const $ = cheerio.load(xmlText, { xmlMode: true });

			const entries: Array<{ title: string; summary: string; name: string }> = [];
			$("entry").each((_, entry) => {
				const title = $(entry).find("title").text().trim();
				const summary = $(entry).find("summary").text().trim();
				const linkHref = $(entry)
				.find('link[type="text/html"]')
				.attr("href")
				?.trim();
				const name = linkHref ? linkHref.replace(/^\/content\//, "") : "";
				if (title && name) {
					entries.push({ title, summary, name });
				}
			});
			return entries;
		},
	});

	const wikiSearchTool = tool({
		name: "wiki_search",
		description: text`
		Search within a specific book for articles. Returns the first exact or prefix title match first,
		followed by full-text matches, with duplicate paths removed.
		Parameters:
		- name (required): exact machine-readable 'name' from your 'wiki_list' tool call, NOT its display 'title'.
		- query (required): search term.
		Returns relevant articles with 'title' and 'path'.
		There could be an extra 'summary' section if the user enables it.
		Use the 'path' field (NOT 'title') in 'wiki_fetch' tool to retrieve the article.
		`,
	parameters: {
		name: z
			.string()
			.trim()
			.min(1, "name is required; call wiki_list and use its exact name field, not title")
			.describe("Exact machine-readable book name returned by wiki_list, not its title"),
		query: z
			.string()
			.trim()
			.min(1, "query is required and cannot be empty")
			.describe("Non-empty article search term"),
	},
	implementation: async ({ name, query }) => {
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
			if (resp.status === 400) {
				throw new Error(
					`Kiwix rejected the search (HTTP 400) for name="${name}" and query="${query}". ` +
					`The name must be the exact machine-readable name from wiki_list, not a display title such as "Baseball". ` +
					`Call wiki_list again and copy its name field into wiki_search.`
				);
			}

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
	},
	});

	const wikiFetchTool = tool({
		name: "wiki_fetch",
		description: text`
		Fetch and return parts of an article.
		Parameters:
		- name (required): exact book name from your 'wiki_list' tool call.
		- path (required): exact article path from your 'wiki_search' tool call for the same book.
		- content (optional, defaults to 'intro'): which part of the article to fetch:
			'intro': Returns only the introduction section. Use this as DEFAULT for casual inquiries.
			'full': Returns the complete article, but excluding the 'References' section.
				Citation marks are in square brackets, such as [1].
				If you need links to those citations, use 'refs' mode to fetch them.
				External links are shown as '<URL>'.
				Use this if the user wants detailed information or want to dive deep into a topic.
			'refs': Returns only the 'References' section as a numbered list.
				External links are shown as '<URL>'.
				Use this only when you need external links, or the user asks for references/sources.
		- page (optional, defaults to 1): 1-based page number. Use pagination.hasNextPage to determine whether to fetch another page.
		`,
	parameters: {
		name: z
			.string()
			.trim()
			.min(1, "name is required; call wiki_list and use its exact name field")
			.describe("Exact book name returned by wiki_list"),
		path: z
			.string()
			.trim()
			.min(1, "path is required; call wiki_search and use its exact path field")
			.describe("Exact article path returned by wiki_search for the same book"),
		content: z
		.enum(["intro", "full", "refs"])
		.default("intro")
		.describe("Article content to fetch"),
		page: z.number().int().min(1).default(1).describe("1-based page number"),
	},
	implementation: async ({ name, path, content, page }) => {
		const articlePath = path.split("#")[0];
		const initialUrl = new URL(`/content/${name}/${articlePath}`, baseUrl).toString();
		const initialFragment = path.includes("#") ? path.split("#")[1] : null;

		let fetchResult: Awaited<ReturnType<typeof fetchWithRedirects>>;
		try {
			fetchResult = await fetchWithRedirects(initialUrl);
		} catch (error) {
			if (error instanceof HttpError) {
				if (error.status === 404) {
					throw new Error(
						`Article not found (HTTP 404) for name="${name}" and path="${articlePath}". ` +
						`No required argument is missing; page is optional and defaults to 1. ` +
						`Call wiki_list to verify the name, then call wiki_search with that same name and copy its exact path into wiki_fetch.`
					);
				}

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

		const { html, finalUrl, fragment: redirectFragment } = fetchResult;
		const $ = cheerio.load(html);
		const container = $(".mw-parser-output");
		if (!container.length) {
			throw new Error(`Article content not found after following redirects (final URL: ${finalUrl})`);
		}

		const effectiveFragment = initialFragment ?? redirectFragment;

		if (content === "intro") {
			if (effectiveFragment) {
				const subsectionContent = extractSubsectionByFragment($, container, effectiveFragment);
				if (subsectionContent) {
					return paginate(subsectionContent, page);
				}
			}

			const firstHeading = container.find("h1, h2, h3, h4, h5, h6").first();
			const paragraphs: string[] = [];

			if (firstHeading.length) {
				let headingBlock = firstHeading;
				if (firstHeading.parent().hasClass("mw-heading")) {
					headingBlock = firstHeading.parent();
				}
				headingBlock.prevAll("p").each((_, p) => {
					paragraphs.push(
						normalizeWhitespace(
							extractText($(p), $, { removeSup: true, externalLinksAsUrl: true })
						)
					);
				});
				paragraphs.reverse();
			} else {
				container.find("p").each((_, p) => {
					paragraphs.push(
						normalizeWhitespace(
							extractText($(p), $, { removeSup: true, externalLinksAsUrl: true })
						)
					);
				});
			}

			const result = paragraphs.filter(Boolean).join("\n\n");
			return paginate(result, page);
		}

		if (content === "refs") {
			const refLines = extractReferencesArray($);
			if (refLines.length === 0) {
				return paginate("No references section found.", page);
			}
			const numbered = refLines.map((line, idx) => `${idx + 1}. ${line}`);
			const result = numbered.join("\n\n");
			return paginate(result, page);
		}

		const containerHtml = container.clone().html() ?? "";
		const $clone = cheerio.load(`<div>${containerHtml}</div>`);
		const cloneContainer = $clone("div").first();
		if (!cloneContainer.length) throw new Error("Article content not found");
		removeReferencesSection($clone);

		const output: string[] = [];
		cloneContainer.children().each((_, el) => {
			const $el = $clone(el);
			const tag = (el as cheerio.TagElement).tagName?.toLowerCase();
			if (!tag) return;
			if (["figure", "style", "script"].includes(tag)) return;

			if (/^h[1-6]$/.test(tag)) {
				output.push($el.text().trim());
			} else if (tag === "p") {
				const text = normalizeWhitespace(
					extractText($el, $clone, { removeSup: false, externalLinksAsUrl: true })
				);
				if (text) output.push(text);
			} else if (tag === "ul" || tag === "ol") {
				const isOrdered = tag === "ol";
				$el.children("li").each((_, li) => {
					const liText = normalizeWhitespace(
						extractText($clone(li), $clone, {
							removeSup: false,
							externalLinksAsUrl: true,
						})
					);
					output.push(`${isOrdered ? "1." : "-"} ${liText}`);
				});
			} else if (tag === "table") {
				const tableMarkdown = tableToMarkdown($el, $clone);
				if (tableMarkdown) output.push(tableMarkdown);
			} else {
				const t = normalizeWhitespace(
					extractText($el, $clone, { removeSup: false, externalLinksAsUrl: true })
				);
				if (t) output.push(t);
			}
		});

		const fullResult = output.join("\n\n").trim();
		return paginate(fullResult, page);
	},
	});

	return [wikiListTool, wikiSearchTool, wikiFetchTool];
}