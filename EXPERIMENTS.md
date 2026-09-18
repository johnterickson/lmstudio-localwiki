# LocalWiki LM Studio Model Experiments

This document records the local, tool-constrained model experiments used to find
the smallest model that could reliably answer:

> Which active MLB teams have never been to the World Series?

The target answer was the Seattle Mariners. Models were required to establish
that answer from the local Wikipedia archive through LocalWiki. They were not
allowed to use web search, other tools, or unsupported prior knowledge.

The main conclusion is:

> `granite-4.2-8b` is the smallest currently reliable model under the simplified
> two-tool LocalWiki API. Load it with a 12,288-token context for operational
> headroom. The 8,192-token configuration also passed twice, but finished only
> 69 tokens below its context limit.

## Status and Scope

- Experiment date: 2026-09-17 and the immediately preceding session work.
- Wikipedia archive: `wikipedia_en_all_maxi_2026-02.zim`.
- Inference runtime: LM Studio with `@lmstudio/sdk` 1.4.0.
- LM Studio endpoint: `ws://127.0.0.1:1234`.
- Kiwix endpoint: `http://127.0.0.1:50000`.
- Hardware target: a marketed 8 GB GPU, treated conservatively as about
  7.45 GiB of usable capacity.
- Primary comparison: models estimated to fit that VRAM target.
- Evaluation method: deterministic benchmark plus manual review of tool calls,
  tool arguments, returned evidence, emitted reasoning, and final response.

The wider discovery phase exercised all 20 downloaded models at least once.
The focused 8 GB phase retained nine candidates and generated the trace set
listed later in this document. Some larger-model captures also exist outside
the focused trace directory, including Qwen 3.8 27B, Qwen 3.6 27B, Qwen 3.6
35B A3B, Gemma 4 31B QAT, Muse Glimmer, and Qwen3 Coder Next. Those runs were
not contenders for the final smallest-reliable recommendation.

## Why Manual Review Was Required

The strict benchmark grade was useful as a quick signal, but it was not treated
as the sole authority.

The grader requires all of the following:

1. The answer contains `Seattle Mariners`.
2. The answer contains no other current team name.
3. At least one `wiki_fetch` call occurred.

That deliberately catches answers which confuse "never appeared" with "never
won," but it can also reject a semantically correct answer that names Seattle
as the only nonparticipant and then separately names teams that appeared but
never won. An earlier Bonsai answer had exactly that property. Conversely, a
strict pass still needed inspection to ensure that the evidence and reasoning
actually supported the conclusion.

Manual review therefore checked:

- Whether a model called the provided tools rather than answering from memory.
- Whether calls were valid LM Studio tool calls rather than tool syntax printed
  as ordinary text.
- Whether search terms were concise and likely to work with Kiwix.
- Whether `wiki_fetch` used an exact path returned by `wiki_search`.
- Whether the fetched passage explicitly supported the answer.
- Whether the model distinguished World Series appearances from championships,
  league pennants, playoff appearances, and postseason droughts.
- Whether the final answer survived context and output-token limits.
- Whether a failure was in retrieval, tool protocol, evidence interpretation,
  synthesis, or benchmark infrastructure.

## LocalWiki Tool Contract Used by the Models

The model-facing API was intentionally simplified for a Kiwix server containing
exactly one ZIM file.

### `wiki_search`

```text
wiki_search(query)
```

- `query` is a concise article title or search phrase.
- Results contain article `title` and exact `path` values.
- Exact or prefix title suggestions are merged ahead of full-text matches.
- Duplicate paths are removed.
- The default result limit is five.
- Search summaries are disabled in the benchmark.
- A returned `path`, not the display title, must be passed to `wiki_sections`.

### `wiki_sections`

```text
wiki_sections(path)
```

- Returns non-empty section IDs and titles in article document order.
- Section IDs are passed unchanged to `wiki_fetch`.

### `wiki_fetch`

```text
wiki_fetch(path, section, segment = 1)
```

- `path` should be an exact path returned by `wiki_search`.
- `section` should be an exact ID returned by `wiki_sections`.
- If the path is not found, its underscores are replaced with spaces and matching `wiki_search` results are returned.
- One section is returned with the References section removed.
- `segment` is one-based.
- The default target segment size is 4,000 characters.
- Segments preserve complete Markdown blocks. Large tables split only between rows and repeat their headers.
- Results include segment metadata.

### Deliberately Removed Surface Area

- `wiki_list` was removed.
- Models no longer select or pass a book/ZIM parameter.
- The provider queries `/catalog/v2/entries?count=-1` internally.
- It requires exactly one ZIM and caches the resolved book name promise.

This removed an unnecessary decision from small models and made calls shorter.

### Recoverable Search Errors

Kiwix occasionally returned HTTP 500 for long full-text queries. Originally,
that exception terminated `model.act()`. The search tool now returns a normal
tool result for a failed full-text search:

```json
{
  "results": [],
  "error": "Kiwix search returned HTTP 500 for this query.",
  "hint": "Shorten or rephrase the query, then try wiki_search again."
}
```

Connection failures and malformed suggestion responses remain hard errors.
This distinction lets capable models recover by issuing a shorter query while
still surfacing actual service or protocol faults.

## Default Benchmark Configuration

### Question

```text
Which active MLB teams have never been to the World Series?
```

### Successful System Prompt

```text
Answer using only the provided local Wikipedia tools. Search and fetch article content before answering. Find explicit support rather than inferring from an incomplete list. Do not rely on prior knowledge, other tools, or web search. Be concise.
```

This prompt is intentionally fact-neutral. It does not tell the model which
baseball distinction to make and does not disclose any part of the answer.
More detailed discipline prompts changed Granite's retrieval trajectory and
reduced reliability, so the minimal prompt should remain the default.

### Prediction Settings

| Setting | Value |
| --- | ---: |
| Thinking mode | model default |
| Temperature | 0 |
| Maximum output tokens per prediction | 1,024 |
| Maximum prediction rounds | 24 |
| Context overflow policy | `stopAtLimit` |
| Search summaries | false |
| Search result limit | 5 |
| Fetch page character limit | 4,000 |

No top-k, top-p, min-p, or repeat-penalty override is set by default.

### Configurable Environment Variables

- `BENCH_SYSTEM_PROMPT`
- `BENCH_THINKING`: `default`, `on`, or `off`
- `BENCH_TEMPERATURE`
- `BENCH_MAX_TOKENS`
- `BENCH_MAX_ROUNDS`
- `BENCH_TOP_K`
- `BENCH_TOP_P`
- `BENCH_MIN_P`
- `BENCH_REPEAT_PENALTY`
- `BENCH_SEARCH_LIMIT`
- `BENCH_CHAR_LIMIT`
- `LMS_BASE_URL`
- `KIWIX_BASE_URL`

`BENCH_THINKING=on` appends `/think` to the user question.
`BENCH_THINKING=off` appends `/no_think`. These strings are model-specific
instructions, not a guarantee that a model will honor the requested mode.

## Successful Granite Configuration

### Recommended 12K Deployment

```powershell
Set-Location Q:\src\localwiki
lms unload --all
lms load granite-4.2-8b --context-length 12288 --parallel 1 --gpu max -y
npm run benchmark -- granite-4.2-8b
```

Observed result:

| Metric | Value |
| --- | ---: |
| Estimated GPU memory | 6.37 GiB |
| Loaded context | 12,288 tokens |
| Prediction rounds | 9 |
| Tool calls | 8 |
| Invalid tool requests | 0 |
| Final total token count | 8,123 |
| Execution time | 168.604 seconds |
| Strict grade | pass |

The same final token count at 12K indicates that additional context did not
change the successful behavior. It supplied about 4,165 tokens of context
headroom instead of ending on the edge of the window.

### Minimum Proven 8K Deployment

```powershell
Set-Location Q:\src\localwiki
lms unload --all
lms load granite-4.2-8b --context-length 8192 --parallel 1 --gpu max -y
npm run benchmark -- granite-4.2-8b
```

Observed across two baseline runs:

- Estimated GPU memory: 5.96 GiB.
- Both runs passed.
- Both followed the same eight-call path.
- Both returned the same direct quotation and conclusion.
- Runtime was approximately 215 to 219 seconds.
- The successful conversation reached 8,123 of 8,192 tokens.
- Remaining context headroom was only 69 tokens.

The 8K setup is the lower-VRAM proven option. The 12K setup is recommended
because the extra 0.41 GiB remains below the 8 GB target and materially reduces
the risk of a small prompt, tokenizer, or tool-result change causing overflow.

### Other Granite Memory Estimates

| Context | Estimated GPU memory | Result |
| ---: | ---: | --- |
| 4,096 | 5.55 GiB | No reliable passing configuration found |
| 8,192 | 5.96 GiB | Passed twice, only 69 tokens spare |
| 12,288 | 6.37 GiB | Passed, recommended |

## Complete Successful Tool Path

The 12K run used the following eight calls. The two successful 8K baseline runs
followed the same path.

### 1. Establish MLB Scope

```json
{"query":"Major League Baseball"}
```

Tool: `wiki_search`

Relevant result:

```json
{"title":"Major League Baseball","path":"Major_League_Baseball"}
```

The model began with a broad entity search instead of embedding the whole
question in a brittle full-text query.

### 2. Fetch the MLB Introduction

```json
{"path":"Major_League_Baseball","content":"intro"}
```

Tool: `wiki_fetch`

Relevant evidence:

- MLB is composed of 30 teams.
- The postseason culminates in the World Series.

This established the league and event relationship but did not answer which
franchise had never appeared.

### 3. Find the World Series Article

```json
{"query":"World Series"}
```

Tool: `wiki_search`

Relevant result:

```json
{"title":"World Series","path":"World_Series"}
```

### 4. Fetch the World Series Introduction

```json
{"path":"World_Series","content":"intro"}
```

Tool: `wiki_fetch`

The introduction defined the World Series as MLB's championship series between
the American League and National League champions. It did not provide the
required franchise-level statement.

### 5. Fetch the Full World Series Article

```json
{"path":"World_Series","content":"full"}
```

Tool: `wiki_fetch`

The first page exposed navigation text pointing to `List of World Series
champions`. The model recognized that the current article did not yet provide
explicit support and moved to the linked list topic.

### 6. Find the Champions List

```json
{"query":"List of World Series champions"}
```

Tool: `wiki_search`

Relevant result:

```json
{"title":"List of World Series champions","path":"List_of_World_Series_champions"}
```

### 7. Fetch the Champions List Introduction

```json
{"path":"List_of_World_Series_champions","content":"intro"}
```

Tool: `wiki_fetch`

This returned the decisive explicit sentence:

> The Seattle Mariners are the only MLB franchise that has never appeared in a World Series.

The surrounding paragraph also distinguished Seattle from Milwaukee, San
Diego, Tampa Bay, and Colorado, which had appeared but had not won. That
distinction was important because several smaller models confused appearances
with championships.

### 8. Fetch the Full Champions List

```json
{"path":"List_of_World_Series_champions","content":"full"}
```

Tool: `wiki_fetch`

This was redundant for the final answer because the introduction was already
decisive. It nevertheless confirmed the article context before synthesis.

### Final Response

Normalized from the trace's console-encoding artifacts:

> The Seattle Mariners are the only active MLB team that has never appeared in a World Series (the List of World Series champions article states: "The Seattle Mariners are the only MLB franchise that has never appeared in a World Series").

The raw JSON log displayed punctuation and narrow spaces as mojibake byte
sequences in some viewers. That was an output encoding issue, not a semantic
model error. The normalized response above preserves the actual text content
using ASCII punctuation.

## Manual Review of Granite Reasoning

The successful behavior had several strengths:

- It obeyed the local-tool requirement.
- It used valid, concise search calls.
- It fetched before answering.
- It noticed when broad articles lacked sufficient evidence.
- It followed an article relationship to a more decisive source.
- It explicitly recognized the difference between appearing and winning.
- It anchored the final answer in a direct statement rather than reconstructing
  an answer from a possibly incomplete table.
- It emitted no invalid tool calls.

The reasoning was not uniformly clean. After obtaining the decisive statement,
Granite continued thinking for hundreds of tokens and included uncertain or
incorrect prior-knowledge asides about other teams and years. Those asides did
not leak into the final answer, which remained grounded in the fetched text.
This is another reason not to equate a passing final string with flawless
reasoning, and a reason to keep the instruction against relying on prior
knowledge.

The extra eighth call and post-evidence deliberation also show an optimization
opportunity. A future agent controller could stop once a fetched passage gives
an explicit, singular answer, but that behavior should be implemented without
adding a material baseball fact hint to the prompt.

## Focused 8 GB Candidate Results

### Granite 4.2 8B

Result: reliable winner.

- Original prompt, 8K context, 4,000-character pages: passed twice.
- Original prompt, 12K context, 4,000-character pages: passed.
- Identical successful eight-call path across those runs.
- Direct evidence and concise correct final answer.
- No invalid tool requests on the successful path.

Failed Granite variations:

- 4K context with 1,500-character pages exceeded the context window at about
  4,168 total tokens before completing.
- 4K with 1,000-character pages completed but failed to reach or use the
  decisive passage.
- 8K with a 3,500-character page limit changed the initial retrieval path and
  failed.
- 8K with a more detailed discipline prompt and 3,000-character pages failed.
- 4K with the discipline prompt and 1,000-character pages failed.

Conclusion: payload size and prompt wording affect model behavior, not just
token consumption. Reducing a page from 4,000 to 3,500 characters was not a
neutral optimization.

### Prism ML Bonsai 27B

Result: smaller VRAM estimate than Granite, but not reliable under the current
two-tool API.

Memory estimates:

| Context | Estimated GPU memory |
| ---: | ---: |
| 8,192 | 5.27 GiB |
| 16,384 | 5.66 GiB |

Observed behavior:

- An earlier run against the old tool API produced a manually acceptable
  answer: it identified Seattle as the only team never to appear and separately
  discussed teams that appeared but never won. The strict grader rejected it
  because those other current team names appeared in the response.
- Under the simplified API at 8K, Bonsai reached correct evidence but exhausted
  context before producing an answer.
- A stopping-rule prompt did not establish reliable completion.
- After search errors became recoverable, the recoverable stopping-rule run
  looped through all 24 rounds and failed.
- At 16K it had ample context and fetched useful pennant evidence, but confused
  categories, consumed the 1,024-token prediction budget, and emitted no final
  answer.

Conclusion: its memory estimate is attractive, but current behavior is not
operationally reliable. The final failure was not merely a grader artifact.

### Qwen3 1.7B

Result: failed.

- With default thinking, it consumed the 1,024-token output budget in reasoning
  before making any tool call.
- `/no_think` enabled tool calls, but it repeated ineffective searches and did
  not progress to useful article fetches.
- A more disciplined no-think prompt still failed and hallucinated numerous
  historical champions.

Failure class: agent control, retrieval progression, and unsupported synthesis.

### Qwen3 4B Thinking 2507

Result: failed.

- Default 1,024-token run spent the full prediction budget reasoning without a
  tool call.
- `/no_think` did not produce a reliable successful flow.
- Raising the prediction budget to 2,048 tokens only produced more reasoning;
  it still made no tool call.

Failure class: no-tool reasoning loop. More output budget did not help.

### DeepSeek R1 0528 Qwen3 8B

Result: failed.

- At both 1,024 and 2,048 output tokens, it reasoned from prior knowledge rather
  than using LocalWiki.
- It made no useful tool call before exhausting the budget.

Failure class: instruction/tool-use noncompliance and reasoning-budget capture.

### Qwen3.5 2B

Result: failed despite adequate retrieval.

- It retrieved evidence relevant to the question.
- It repeatedly misread postseason tables or treated different categories as
  equivalent.
- Default thinking, the evidence-focused prompt, and `/no_think` all failed.

Failure class: evidence interpretation. Retrieval alone was not the bottleneck.

### NVIDIA Nemotron 3 Nano 4B

Result: failed.

- It made one valid search call.
- It then printed a second model-specific tool request as ordinary response text
  instead of issuing a parsed tool call.
- The action loop stopped without a supported answer.

Failure class: tool protocol compatibility.

### LFM2.5 8B A1B

Result: failed.

- It emitted a model-specific tool token format that LM Studio's action parser
  did not recognize as a tool call.

Failure class: tool protocol compatibility.

### Qwen3.5 9B

Result: failed and marginal for the hardware target.

- Estimated memory at 8K: 7.16 GiB.
- The baseline encountered context/runtime failure and did not produce a
  reliable answer.
- It was not tuned further because it had little 8 GB headroom and smaller
  candidates had already revealed the important behavior classes.

Failure class: runtime/context reliability with marginal VRAM capacity.

## Experiment Matrix Summary

| Model | Focused configurations | Best observed outcome | Primary failure mode |
| --- | --- | --- | --- |
| Granite 4.2 8B | 4K, 8K, 12K; page and prompt variants | Pass at default 8K and 12K | Tight context below 12K |
| Bonsai 27B | 8K, 16K; stopping variants | Reached evidence, no reliable final | Context, looping, category confusion |
| Qwen3 1.7B | Default and no-think variants | Calls under no-think only | Search loops and hallucination |
| Qwen3 4B Thinking | 1K/2K output, no-think | No useful calls | Reasoning consumes output budget |
| DeepSeek R1 Qwen3 8B | 1K/2K output | No useful calls | Prior-knowledge reasoning |
| Qwen3.5 2B | Default/evidence/no-think | Retrieved useful evidence | Misinterpreted evidence categories |
| Nemotron 3 Nano 4B | 8K baseline | One valid search | Unparsed subsequent tool syntax |
| LFM2.5 8B A1B | 8K baseline | None | Unparsed tool token format |
| Qwen3.5 9B | 8K baseline | None | Context/runtime failure; marginal VRAM |

## Key Experimental Findings

### 1. Retrieval Was Often Not the Main Constraint

Several models found useful or decisive evidence and still failed. The harder
steps were:

- deciding when evidence was complete;
- interpreting appearances versus wins or other postseason categories;
- preserving the conclusion through a long reasoning phase; and
- emitting a final response before context or output limits were exhausted.

### 2. More Reasoning Tokens Did Not Guarantee Better Tool Use

Qwen3 4B Thinking and DeepSeek R1 Qwen3 8B consumed both 1,024-token and
2,048-token prediction budgets without progressing to tools. Increasing output
budget amplified the failure mode instead of fixing it.

### 3. `/no_think` Is Not a Portable Control

Some Qwen-family runs changed behavior after `/no_think`, but the instruction
was inconsistently honored and did not produce a successful answer. It should
not be treated as a runtime-level thinking switch across model families.

### 4. Smaller Tool Payloads Can Change Decisions

Reducing `BENCH_CHAR_LIMIT` was intended to save context. Granite's search path
changed at 3,500 characters and the run failed, even though its 4,000-character
baseline passed. Tool payload changes can alter visible cues and subsequent
model actions, so they must be behaviorally revalidated.

### 5. A More Detailed Prompt Can Regress a Capable Model

The fact-neutral discipline prompt was meant to improve stopping and evidence
handling. Instead, Granite took a different route and failed. The original
minimal prompt gave the best repeatability and should be preserved.

### 6. Direct Statements Beat Reconstructed Lists

The decisive source explicitly said Seattle was the only franchise never to
appear. This was safer than subtracting an appearance table from a separately
constructed list of current teams. The prompt's instruction to find explicit
support rather than infer from an incomplete list was valuable without leaking
the answer.

### 7. Context Headroom Matters Even When VRAM Fits

Granite's successful 8K run used 8,123 tokens. A tiny change in prompt text,
tool descriptions, tokenization, or article content could exceed 8,192. The
12K load costs an estimated additional 0.41 GiB and is the better operational
setting on an 8 GB card.

## Reproduction Procedure

### 1. Start Kiwix with One ZIM

The experiment used:

```powershell
Set-Location Q:\wikipedia
.\kiwix-serve.exe -i 127.0.0.1 -p 50000 -v .\wikipedia_en_all_maxi_2026-02.zim
```

The provider will reject a catalog containing zero or multiple ZIM entries.

### 2. Start LM Studio's Local Server

Ensure LM Studio is serving its SDK endpoint at:

```text
ws://127.0.0.1:1234
```

The previously used remote endpoint `ws://192.168.1.99:1234` was unreachable
during the focused experiments and is not the benchmark default.

### 3. Clear Experimental Overrides

For a true baseline in PowerShell:

```powershell
Remove-Item `
  Env:BENCH_SYSTEM_PROMPT, `
  Env:BENCH_THINKING, `
  Env:BENCH_TEMPERATURE, `
  Env:BENCH_MAX_TOKENS, `
  Env:BENCH_MAX_ROUNDS, `
  Env:BENCH_TOP_K, `
  Env:BENCH_TOP_P, `
  Env:BENCH_MIN_P, `
  Env:BENCH_REPEAT_PENALTY, `
  Env:BENCH_SEARCH_LIMIT, `
  Env:BENCH_CHAR_LIMIT `
  -ErrorAction SilentlyContinue
```

Also clear `LMS_BASE_URL` and `KIWIX_BASE_URL` if they were set to non-default
hosts.

### 4. Estimate Before Loading

```powershell
lms load granite-4.2-8b `
  --context-length 12288 `
  --parallel 1 `
  --gpu max `
  --estimate-only `
  -y
```

### 5. Load and Run

```powershell
lms unload --all
lms load granite-4.2-8b --context-length 12288 --parallel 1 --gpu max -y
Set-Location Q:\src\localwiki
npx tsx src/benchmark.ts granite-4.2-8b
```

### 6. Interpret Exit Codes

| Exit code | Meaning |
| ---: | --- |
| 0 | Completed and passed the strict grade |
| 1 | Runtime or inference failure |
| 2 | Completed but failed the strict grade |

Treat the JSON trace as authoritative. Some PowerShell wrappers in the broader
session reported their own final command's exit code instead of the embedded
benchmark process code.

## Trace Format

The benchmark emits one JSON object containing:

- model key;
- question, system prompt, and effective user prompt;
- requested thinking mode;
- loaded model context length;
- prediction and provider settings;
- normalized visible answer;
- every valid tool call with round, call ID, parsed arguments, raw request, and
  returned result;
- invalid tool requests and parser errors;
- raw, reasoning, visible response, and generation statistics for every round;
- total rounds and execution time;
- captured exception details when a run fails; and
- strict grade details.

Partial traces are retained when `model.act()` throws, which is important for
distinguishing a model failure after useful retrieval from a failure before any
tool interaction.

## Focused Trace Inventory

The focused traces were saved under:

```text
%TEMP%\localwiki-8gb-experiments
```

Files:

```text
deepseek-r1-0528-qwen3-8b-baseline-8k-2048tokens.jsonlog
deepseek_deepseek-r1-0528-qwen3-8b-baseline-8k.jsonlog
granite-4.2-8b-baseline-12k.jsonlog
granite-4.2-8b-baseline-4k-1500.jsonlog
granite-4.2-8b-baseline-8k-3500.jsonlog
granite-4.2-8b-baseline-8k-rep2.jsonlog
granite-4.2-8b-baseline-8k.jsonlog
granite-4.2-8b-disciplined-4k-1000.jsonlog
granite-4.2-8b-disciplined-8k-3000.jsonlog
lfm2.5-8b-a1b-baseline-8k.jsonlog
nvidia_nemotron-3-nano-4b-baseline-8k.jsonlog
prism-ml_bonsai-27b-baseline-16k.jsonlog
prism-ml_bonsai-27b-baseline-8k.jsonlog
prism-ml_bonsai-27b-stop-rule-8k.jsonlog
prism-ml_bonsai-27b-stop-rule-recoverable-8k.jsonlog
qwen3-1.7b-disciplined-no-think-8k.jsonlog
qwen3-1.7b-no-think-8k.jsonlog
qwen3-4b-thinking-2507-baseline-8k-2048tokens.jsonlog
qwen3-4b-thinking-2507-no-think-8k.jsonlog
qwen3.5-2b-baseline-8k.jsonlog
qwen3.5-2b-evidence-default-8k.jsonlog
qwen3.5-2b-evidence-off-8k.jsonlog
qwen_qwen3-1.7b-baseline-8k.jsonlog
qwen_qwen3-4b-thinking-2507-baseline-8k.jsonlog
qwen_qwen3.5-9b-baseline-8k.jsonlog
```

The successful 12K reference trace is:

```text
%TEMP%\localwiki-8gb-experiments\granite-4.2-8b-baseline-12k.jsonlog
```

The successful repeated 8K traces are:

```text
%TEMP%\localwiki-8gb-experiments\granite-4.2-8b-baseline-8k.jsonlog
%TEMP%\localwiki-8gb-experiments\granite-4.2-8b-baseline-8k-rep2.jsonlog
```

These files are currently in the operating-system temporary directory. Preserve
or relocate them if long-term raw trace retention is required; this Markdown
file records the durable conclusions but is not a substitute for raw logs.

## Source Changes Made During the Experiments

### `src/toolsProvider.ts`

- Removed `wiki_list`.
- Removed the model-visible book parameter from search and fetch.
- Added internal single-ZIM discovery and caching.
- Updated tool descriptions for exact paths, concise searches, and pagination.
- Made Kiwix full-text search HTTP errors recoverable tool results.
- Retained hard failures for connectivity and malformed protocol responses.

### `src/benchmark.ts`

- Defaulted LM Studio to localhost.
- Added deterministic prediction defaults.
- Added environment overrides for prompt, thinking, sampling, rounds, search
  count, and fetch page size.
- Recorded provider configuration in every trace.
- Captured valid calls, raw arguments, returned results, invalid requests,
  reasoning, visible responses, round statistics, timing, and failures.
- Preserved partial traces after exceptions.
- Added explicit exit codes for pass, grade failure, and runtime failure.

## Validation State

- Direct provider smoke test confirmed the model-facing signatures:
  `wiki_search(query)` and `wiki_fetch(path, page)`.
- Local search and fetch for the Seattle Mariners succeeded.
- VS Code diagnostics reported no errors in the modified source files.
- An earlier `esbuild` bundle check passed.
- A direct TypeScript check still encounters eight pre-existing Cheerio typing
  errors in `src/toolsProvider.ts`; those were not introduced by this work.
- The repository already had a deleted `LICENSE` in the working tree. It was
  intentionally not restored or otherwise changed during these experiments.

## Operational Recommendation

For this hardware, tool API, archive, and question style:

1. Use `granite-4.2-8b`.
2. Load a 12,288-token context when the estimated 6.37 GiB allocation fits.
3. Use the original minimal system prompt exactly as recorded above.
4. Keep temperature 0, default thinking, 1,024 maximum prediction tokens, and
   24 maximum rounds.
5. Keep five search results and 4,000-character fetch pages.
6. Do not add a material baseball hint to improve this benchmark.
7. Continue inspecting raw calls and reasoning for new models; do not rely only
   on the strict string grader.

The 8K Granite configuration remains useful when minimizing allocation is more
important than context safety, but its 69-token margin is too narrow to be the
default recommendation.

## Suggested Follow-up Work

- Repeat the 12K Granite baseline enough times to estimate pass rate rather than
  relying on one 12K run plus two 8K runs.
- Add a small multi-question suite that tests the same behaviors without sharing
  this question's answer or wording.
- Grade semantic category handling separately from answer-string purity.
- Record model file quantization and exact LM Studio runtime version in future
  traces.
- Copy raw traces out of `%TEMP%` when they are intended as durable artifacts.
- Explore controller-level stopping after explicit singular evidence, while
  keeping prompts fact-neutral.
- Retest promising models after LM Studio tool-parser updates, especially
  Nemotron and LFM, whose failures were protocol-shaped rather than purely
  factual.