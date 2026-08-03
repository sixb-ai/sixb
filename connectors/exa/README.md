# @sixb/connector-exa

Exa web search and content retrieval for Sixb, with a typed connector client and bounded
`web_search` and `web_fetch` agent tools.

## Install

```bash
bun add @sixb/connector-exa
```

## Register the connector

```ts
import { exa } from "@sixb/connector-exa"
import { defineAgent, defineConnector } from "@sixb/core"

export const exaConnector = defineConnector(
  "exa",
  exa({ apiKey: process.env.EXA_API_KEY! })
)
```

Pass a sync or async resolver instead when credentials rotate; resolvers run before every request.
The typed client provides `search()` and `getContents()`. Calls are single-attempt and accept a
caller `AbortSignal`.

## Grant web access to an agent

```ts
import { exaWebFetch, exaWebSearch } from "@sixb/connector-exa/agent-tools"

const webSearch = exaWebSearch(exaConnector, {
  maxResults: 8,
  maxCharactersPerResult: 2_000,
  maxTotalCharacters: 12_000,
  timeoutMs: 20_000,
  allowedDomains: ["docs.example.com"],
})

const webFetch = exaWebFetch(exaConnector, {
  maxCharacters: 12_000,
  timeoutMs: 20_000,
  allowedDomains: ["docs.example.com"],
  deniedDomains: ["private.docs.example.com"],
})
```

Attach either definition to an agent's `tools` array to grant that capability explicitly:

```ts
export default defineAgent("researcher", {
  model,
  tools: [webSearch, webFetch],
})
```

The model sees only `{ query: string }` for `web_search` and `{ url: string }` for `web_fetch`.
Credentials, domain policy, timeouts, and output limits stay on the host.

`web_fetch` accepts one HTTP(S) URL, requests one page with `subpages: 0`, and defensively truncates
the returned content. Domain policy is checked against both the requested URL and Exa's returned
canonical URL; denied domains take precedence and configured domains include their subdomains.
Per-URL crawl failures reported by Exa are surfaced as tool errors.
