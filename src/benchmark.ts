import {
  LMStudioClient,
  type LLMActionOpts,
  type ToolsProviderController,
} from "@lmstudio/sdk";
import { toolsProvider } from "./toolsProvider";

const modelKey = process.argv[2] ?? "qwen/qwen3-1.7b";
const lmsBaseUrl = process.env.LMS_BASE_URL ?? "ws://127.0.0.1:1234";
const kiwixBaseUrl = process.env.KIWIX_BASE_URL ?? "http://127.0.0.1:50000";
const question = "Which active MLB teams have never been to the World Series?";
const systemPrompt =
  process.env.BENCH_SYSTEM_PROMPT ??
  "Answer using only the provided local Wikipedia tools. Search and fetch article content before answering. Find explicit support rather than inferring from an incomplete list. Do not rely on prior knowledge, other tools, or web search. Be concise.";

function numberFromEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number, received: ${raw}`);
  }
  return value;
}

function optionalNumberFromEnv(name: string) {
  return process.env[name] === undefined ? undefined : numberFromEnv(name, 0);
}

const thinkingMode = process.env.BENCH_THINKING ?? "default";
if (!["default", "on", "off"].includes(thinkingMode)) {
  throw new Error("BENCH_THINKING must be default, on, or off");
}

const userPrompt =
  thinkingMode === "on"
    ? `${question}\n/think`
    : thinkingMode === "off"
      ? `${question}\n/no_think`
      : question;

const predictionConfig: LLMActionOpts = {
  temperature: numberFromEnv("BENCH_TEMPERATURE", 0),
  maxTokens: numberFromEnv("BENCH_MAX_TOKENS", 1024),
  maxPredictionRounds: numberFromEnv("BENCH_MAX_ROUNDS", 24),
  contextOverflowPolicy: "stopAtLimit",
};

const providerConfig = {
  searchSummary: false,
  searchLimit: numberFromEnv("BENCH_SEARCH_LIMIT", 5),
  charLimit: numberFromEnv("BENCH_CHAR_LIMIT", 4_000),
};

const topKSampling = optionalNumberFromEnv("BENCH_TOP_K");
const topPSampling = optionalNumberFromEnv("BENCH_TOP_P");
const minPSampling = optionalNumberFromEnv("BENCH_MIN_P");
const repeatPenalty = optionalNumberFromEnv("BENCH_REPEAT_PENALTY");
if (topKSampling !== undefined) predictionConfig.topKSampling = topKSampling;
if (topPSampling !== undefined) predictionConfig.topPSampling = topPSampling;
if (minPSampling !== undefined) predictionConfig.minPSampling = minPSampling;
if (repeatPenalty !== undefined) predictionConfig.repeatPenalty = repeatPenalty;

const activeTeams = [
  "Arizona Diamondbacks",
  "Athletics",
  "Atlanta Braves",
  "Baltimore Orioles",
  "Boston Red Sox",
  "Chicago Cubs",
  "Chicago White Sox",
  "Cincinnati Reds",
  "Cleveland Guardians",
  "Colorado Rockies",
  "Detroit Tigers",
  "Houston Astros",
  "Kansas City Royals",
  "Los Angeles Angels",
  "Los Angeles Dodgers",
  "Miami Marlins",
  "Milwaukee Brewers",
  "Minnesota Twins",
  "New York Mets",
  "New York Yankees",
  "Philadelphia Phillies",
  "Pittsburgh Pirates",
  "San Diego Padres",
  "San Francisco Giants",
  "Seattle Mariners",
  "St. Louis Cardinals",
  "Tampa Bay Rays",
  "Texas Rangers",
  "Toronto Blue Jays",
  "Washington Nationals",
];

function createProviderController(): ToolsProviderController {
  const values: Record<string, string | number | boolean> = {
    kiwixBaseUrl,
    ...providerConfig,
  };

  return {
    getPluginConfig: () => ({
      get: (key: string) => values[key],
    }),
  } as unknown as ToolsProviderController;
}

function grade(answer: string, toolCalls: string[]) {
  const otherTeams = activeTeams.filter(
    team => team !== "Seattle Mariners" && answer.toLowerCase().includes(team.toLowerCase())
  );
  const usedWiki = toolCalls.includes("wiki_fetch");
  const correct =
    answer.toLowerCase().includes("seattle mariners") &&
    otherTeams.length === 0 &&
    usedWiki;

  return { correct, usedWiki, otherTeams };
}

function visibleAnswer(response: string) {
  const reasoningSeparator = /__LM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_[^_]+__/;
  const sections = response.split(reasoningSeparator);
  return sections.at(-1)?.trim() ?? "";
}

async function main() {
  const client = new LMStudioClient({ baseUrl: lmsBaseUrl });
  const tools = await toolsProvider(createProviderController());
  const model = await client.llm.model(modelKey);
  const modelInfo = await model.getModelInfo();
  const toolCalls: Array<{
    roundIndex: number;
    callId: number;
    name: string;
    arguments: Record<string, unknown> | undefined;
    rawRequest: string | undefined;
    result?: string;
  }> = [];
  const invalidToolRequests: Array<{
    message: string;
    rawContent: string | undefined;
    request: unknown;
  }> = [];
  const roundTraces: Array<{
    raw: string;
    reasoning: string;
    response: string;
    stats?: unknown;
  }> = [];
  const toolCallByModelId = new Map<string, (typeof toolCalls)[number]>();

  const getRoundTrace = (roundIndex: number) => {
    roundTraces[roundIndex] ??= { raw: "", reasoning: "", response: "" };
    return roundTraces[roundIndex];
  };

  let result: Awaited<ReturnType<typeof model.act>> | undefined;
  let failure: string | undefined;
  try {
    result = await model.act(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools,
      {
      ...predictionConfig,
      onPredictionFragment: fragment => {
        const trace = getRoundTrace(fragment.roundIndex);
        trace.raw += fragment.content;
        if (fragment.reasoningType === "reasoning") {
          trace.reasoning += fragment.content;
        } else if (fragment.reasoningType === "none") {
          trace.response += fragment.content;
        }
      },
      onPredictionCompleted: predictionResult => {
        getRoundTrace(predictionResult.roundIndex).stats = predictionResult.stats;
      },
      onToolCallRequestFinalized: (roundIndex, callId, { toolCallRequest, rawContent }) => {
        const trace = {
          roundIndex,
          callId,
          name: toolCallRequest.name,
          arguments: toolCallRequest.arguments,
          rawRequest: rawContent,
        };
        toolCalls.push(trace);
        if (toolCallRequest.id) toolCallByModelId.set(toolCallRequest.id, trace);
      },
      onMessage: message => {
        for (const toolResult of message.getToolCallResults()) {
          const trace = toolResult.toolCallId
            ? toolCallByModelId.get(toolResult.toolCallId)
            : toolCalls.find(call => call.result === undefined);
          if (trace) trace.result = toolResult.content;
        }
      },
      handleInvalidToolRequest: (error, request) => {
        invalidToolRequests.push({
          message: error.message,
          rawContent: error.rawContent,
          request,
        });
        if (request) return error.message;
        throw error;
      },
      }
    );
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
  }

  const answer = visibleAnswer(roundTraces.at(-1)?.response ?? roundTraces.at(-1)?.raw ?? "");
  const toolNames = toolCalls.map(call => call.name);
  const output = {
    model: modelKey,
    question,
    systemPrompt,
    userPrompt,
    thinkingMode,
    loadedContextLength: modelInfo.contextLength,
    predictionConfig,
    providerConfig,
    answer,
    toolCalls,
    invalidToolRequests,
    roundTraces,
    rounds: result?.rounds ?? roundTraces.length,
    seconds: result?.totalExecutionTimeSeconds ?? null,
    failure,
    grade: grade(answer, toolNames),
  };

  console.log(JSON.stringify(output, null, 2));
  process.exitCode = failure ? 1 : output.grade.correct ? 0 : 2;
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});