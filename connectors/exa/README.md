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
import { defineConnector } from "@sixb/core"

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
import { defineAgent } from "@sixb/core"
import { gateway } from "ai"
import { exaConnector } from "../connectors/exa"

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

export default defineAgent("researcher", {
  name: "Researcher",
  model: gateway("openai/gpt-5.5"),
  instructions: "Research questions on the web and cite the sources you use.",
  tools: [webSearch, webFetch],
})
```

The model sees only `{ query: string }` for `web_search` and `{ url: string }` for `web_fetch`.
Credentials, domain policy, timeouts, and output limits stay on the host.

`web_fetch` accepts one HTTP(S) URL, requests one page with `subpages: 0`, and defensively truncates
the returned content. Domain policy is checked against both the requested URL and Exa's returned
canonical URL. Filters support exact domains (`docs.example.com`), wildcard subdomains
(`*.example.com`), and path prefixes (`docs.example.com/guides`). Wildcards do not match the apex
domain, and denied filters take precedence. Per-URL crawl failures reported by Exa are surfaced as
tool errors.
