# @sixb/connector-exa

Typed Exa search and content retrieval, and a web search engine for the Sixb agent.

## Install

```bash
bun add @sixb/connector-exa
```

## Register

Export the connector from `connectors/` and keep its key in the host environment:

```ts
// connectors/exa.ts
import { exa } from "@sixb/connector-exa"
import { defineConnector } from "@sixb/core"

export const exaConnector = defineConnector(
  "exa",
  exa({ apiKey: process.env.EXA_API_KEY! })
)
```

`apiKey` accepts a string or a sync/async resolver; `baseUrl` is optional. The connected client
exposes `search()` and `getContents()`, accepts caller cancellation, and makes single-attempt
requests.

## Agent web search

The agent searches the web through Gateway when its language models come from Gateway. To make
Exa its search engine, or to give one to a project without Gateway:

```ts
// sixb.config.ts
import { exaSearch } from "@sixb/connector-exa"
import { createSixb } from "@sixb/core"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const sixb = createSixb({
  // ...storage, broker, queues, sandboxes
  models: {
    language: [vercelGateway("openai/gpt-5.5")],
    webSearch: [exaSearch({ apiKey: process.env.EXA_API_KEY! })],
  },
})
```

| Option | Default | |
| --- | --- | --- |
| `type` | `"auto"` | `"fast"` trades some quality for latency |
| `maxResults` | `8` | 1–10 results per search |

- A search is one Exa `/search` request; each hit's snippet is the passages that best match the
  query.
- Its cost is the one Exa reports (~$0.007 measured). A cost limit reserves $0.01 per search.
- The agent's allowed domains are sent to Exa, or its blocked domains when none are allowed.
