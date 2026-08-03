# @sixb/connector-exa

Exa web search for Sixb, with a typed connector client and a bounded `web_search` agent tool.

## Install

```bash
bun add @sixb/connector-exa
```

## Register the connector

```ts
import { exa } from "@sixb/connector-exa"
import { defineConnector } from "@sixb/core"

export const exaConnector = defineConnector(
  "exa",
  exa({ apiKey: process.env.EXA_API_KEY! })
)
```

Pass a sync or async resolver instead when credentials rotate; resolvers run before every request.
Search calls are single-attempt and accept a caller `AbortSignal`.

## Grant web search to an agent

```ts
import { exaWebSearch } from "@sixb/connector-exa/agent-tools"

const webSearch = exaWebSearch(exaConnector, {
  maxResults: 8,
  maxCharactersPerResult: 2_000,
  maxTotalCharacters: 12_000,
  timeoutMs: 20_000,
  allowedDomains: ["docs.example.com"],
})
```

Attach `webSearch` to an agent's `tools` array to grant that agent the capability. The model sees
only `{ query: string }`; credentials, domain policy, timeouts, and output limits stay on the host.
