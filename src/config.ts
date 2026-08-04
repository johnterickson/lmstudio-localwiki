import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "kiwixBaseUrl",
    "string",
    {
      displayName: "Kiwix Endpoint",
      subtitle: "URL of your Kiwix endpoint.",
    },
    "http://127.0.0.1:8080"
  )
  .field(
    "searchSummary",
    "boolean",
    {
      displayName: "Enable Summary Section in Search",
      subtitle: "Enable this for more precise searching, at the cost of search speeds.",
    },
    false
  )
  .field(
    "searchLimit",
    "numeric",
    {
      displayName: "Search Result Limit",
      subtitle: "Limits the number of search results to shorten prompt processing times, useful when summary is enabled.",
      min: 1,
      max: 25,
      int: true,
      slider: {
        step: 1,
        min: 1,
        max: 25,
      },
    },
    25
  )
  .field(
    "charLimit",
    "numeric",
    {
      displayName: "Characters Per Page",
      subtitle: "Limits the number of characters (NOT tokens) returned on each wiki_fetch page (-1 = no pagination).",
      min: -1,
      max: Number.MAX_SAFE_INTEGER,
      int: true,
    },
    -1
  )
  .build();
