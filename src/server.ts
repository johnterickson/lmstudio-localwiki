import express, { type Request, type Response } from "express";
import type { FunctionTool, ToolCallContext } from "@lmstudio/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toolsProvider } from "./toolsProvider";

const port = Number(process.env.PORT ?? "8080");
const authToken = process.env.LOCALWIKI_MCP_AUTH_TOKEN ?? "";
const values: Record<string, string | number | boolean> = {
	kiwixBaseUrl: process.env.KIWIX_BASE_URL ?? "http://kiwix:8080",
	searchSummary: process.env.SEARCH_SUMMARY === "true",
	searchLimit: Number(process.env.SEARCH_LIMIT ?? "5"),
	charLimit: Number(process.env.CHAR_LIMIT ?? "4000"),
};

const controller = {
	getPluginConfig: () => ({
		get: (key: string) => values[key],
	}),
} as any;

async function createServer() {
	const server = new McpServer({ name: "localwiki", version: "1.0.0" });
	const registerTool = server.registerTool.bind(server) as (
		name: string,
		config: Record<string, unknown>,
		callback: (arguments_: Record<string, unknown>) => Promise<unknown>
	) => unknown;
	for (const candidate of await toolsProvider(controller)) {
		if (candidate.type !== "function") continue;
		const localTool = candidate as FunctionTool;
		registerTool(
			localTool.name,
			{
				description: localTool.description,
				inputSchema: localTool.parametersSchema,
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
			async (arguments_: Record<string, unknown>) => {
				console.info(
					JSON.stringify({ event: "tool_call", name: localTool.name, arguments: arguments_ })
				);
				localTool.checkParameters(arguments_);
				const context: ToolCallContext = {
					status: () => undefined,
					warn: warning => console.warn(warning),
					signal: new AbortController().signal,
					callId: 0,
				};
				const result = await localTool.implementation(arguments_, context);
				const text = JSON.stringify(result);
				console.info(
					JSON.stringify({ event: "tool_result", name: localTool.name, characters: text.length })
				);
				return { content: [{ type: "text" as const, text }] };
			}
		);
	}
	return server;
}

function authorized(request: Request): boolean {
	if (!authToken) return true;
	return request.headers.authorization === `Bearer ${authToken}`;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_request, response) => response.json({ status: true }));
app.post("/mcp", async (request: Request, response: Response) => {
	if (!authorized(request)) {
		response.status(401).json({ error: "Unauthorized" });
		return;
	}

	const server = await createServer();
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	response.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(request, response, request.body);
});

app.listen(port, "0.0.0.0", () => {
	console.info(`LocalWiki MCP listening on port ${port}`);
});