import { LMStudioClient, type ToolsProviderController } from "@lmstudio/sdk";
import { toolsProvider } from "./toolsProvider";

const modelKey = process.argv[2] ?? "qwen/qwen3-1.7b";
const lmsBaseUrl = process.env.LMS_BASE_URL ?? "ws://192.168.1.99:1234";
const kiwixBaseUrl = process.env.KIWIX_BASE_URL ?? "http://127.0.0.1:50000";
const question = "Which active MLB teams have never been to the World Series?";

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
    searchSummary: false,
    searchLimit: 5,
    charLimit: 4_000,
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
  const toolCalls: string[] = [];
  const responseByRound: string[] = [];

  const result = await (await client.llm.model(modelKey)).act(
    [
      {
        role: "system",
        content:
          "Answer using the provided local Wikipedia tools. Call wiki_list first, then search and fetch an article before answering. Find explicit support rather than inferring from an incomplete list. Do not rely on other tools or web search. Be concise.",
      },
      { role: "user", content: question },
    ],
    tools,
    {
      temperature: 0,
      maxTokens: 1024,
      maxPredictionRounds: 24,
      onPredictionFragment: fragment => {
        responseByRound[fragment.roundIndex] =
          (responseByRound[fragment.roundIndex] ?? "") + fragment.content;
      },
      onToolCallRequestFinalized: (_roundIndex, _callId, { toolCallRequest }) => {
        toolCalls.push(toolCallRequest.name);
      },
    }
  );

  const answer = visibleAnswer(responseByRound.at(-1) ?? "");
  const output = {
    model: modelKey,
    question,
    answer,
    toolCalls,
    rounds: result.rounds,
    seconds: result.totalExecutionTimeSeconds,
    grade: grade(answer, toolCalls),
  };

  console.log(JSON.stringify(output, null, 2));
  process.exitCode = output.grade.correct ? 0 : 2;
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});