# @sixb/connector-fullenrich

Typed [FullEnrich](https://docs.fullenrich.com/api/v2/general/introduction) connector for Sixb:
contact enrichment (emails and phones), reverse email lookup, people and company search and
lookup, credit balance, signed result webhooks, and agent tools for all of them.

## Install

```bash
bun add @sixb/connector-fullenrich
```

## Register

Export the connector from `connectors/` and keep the API key in the host environment:

```ts
// connectors/fullenrich.ts
import { fullenrich } from "@sixb/connector-fullenrich"
import { defineConnector } from "@sixb/core"

export const fullenrichConnector = defineConnector(
  "fullenrich",
  fullenrich({ apiKey: process.env.FULLENRICH_API_KEY! })
)
```

`apiKey` accepts a string or a sync/async resolver, which runs for every request. Optional
`baseUrl`, `timeoutMs` (30 seconds), `minDelayMs` (0), and `maxRetries` (2) tune the transport.

## Client

```ts
const api = await sixb.connector(fullenrichConnector)
```

| Resource | Methods | Endpoint |
| --- | --- | --- |
| `enrichments` | `start(request, { silentFail })`, `get(id, { forceResults })` | `/contact/enrich/bulk` |
| `reverseEmailLookups` | `start(request, { silentFail })`, `get(id)` | `/contact/reverse/email/bulk` |
| `people` | `search`, `searchAll`, `lookup` | `/people/search`, `/people/lookup` |
| `companies` | `search`, `searchAll`, `lookup` | `/company/search`, `/company/lookup` |
| `account` | `credits`, `verifyKey` | `/account/credits`, `/account/keys/verify` |

Requests and results use FullEnrich's field names; "professional network" is LinkedIn. Some
empty lists arrive as `null`. Every method accepts a final `{ signal }`.

### Enrichment and reverse email lookup

Both are asynchronous. `start()` returns an `enrichment_id`; results take 30 to 90 seconds per
contact and arrive on your webhook or through `get()`.

```ts
const { enrichment_id } = await api.enrichments.start({
  name: "Jane Doe",
  webhook_url: "https://<sixb-api-origin>/api/webhooks/fullenrich/enrichments",
  data: [
    {
      first_name: "Jane",
      last_name: "Doe",
      domain: "example.com",
      enrich_fields: ["contact.work_emails", "contact.phones"],
      custom: { crm_contact_id: "c_123" },
    },
  ],
})
```

Each contact needs a `linkedin_url`, or `first_name` and `last_name` with a `domain` or
`company_name`. A batch holds 1 to 100 contacts or emails, and `custom` values must be strings.
With `{ silentFail: true }`, FullEnrich skips invalid entries instead of rejecting the batch.

While a job runs, `get()` reports status `IN_PROGRESS` without `data`, unless `forceResults`
asks for what has been found so far. A job that ran out of credits resolves with status
`CREDITS_INSUFFICIENT` and its partial data. FullEnrich asks
callers not to poll more than once every 5 to 10 minutes; prefer webhooks.

### Search and lookup

Search is synchronous. Values within one filter are ORed and different filters are ANDed;
`exact_match` turns off FullEnrich's tolerance for missing or extra words.

```ts
const { people, metadata } = await api.people.search({
  current_position_titles: [{ value: "Head of Sales" }],
  current_position_seniority_level: [{ value: "VP" }, { value: "Director" }],
  current_company_headcounts: [{ min: 50, max: 500 }],
  person_locations: [{ value: "France" }],
  limit: 25,
})

for await (const company of api.companies.searchAll({ technologies: [{ value: "Notion" }] })) {
  if (done(company)) break
}

const { companies } = await api.companies.lookup({ domain: "example.com" })
```

`limit` is 1 to 100 and `offset` at most 10,000; continue beyond that with
`metadata.search_after`. `searchAll()` follows those cursors, 100 results per page unless
`limit` says otherwise, until the results run out. Each result costs credits, so break when you
have enough. Lookups return at most one match.

## Webhooks

Pass a handler to register a result route:

```ts
fullenrich({
  apiKey: process.env.FULLENRICH_API_KEY!,
  async onEnrichmentResult({ result, sixb }) {
    for (const record of result.data ?? []) {
      // record.custom holds what you sent; record.contact_info what FullEnrich found.
    }
  },
  onReverseEmailLookupResult: ({ result }) => {},
})
```

| Option | Route |
| --- | --- |
| `onEnrichmentResult` | `/api/webhooks/<connector id>/enrichments` |
| `onReverseEmailLookupResult` | `/api/webhooks/<connector id>/reverse-email-lookups` |

Use the route as `webhook_url` for the finished batch or as `webhook_events.contact_finished`
for each contact as it completes; per-contact deliveries have status `IN_PROGRESS` and one
record. FullEnrich signs deliveries with an HMAC of the body keyed by your API key, so every
delivery is verified with the connector's `apiKey`. FullEnrich retries failed deliveries up to
five times; identical redeliveries are deduplicated.

## Agent tools

```ts
// sixb.config.ts
import {
  fullEnrichCreditBalance,
  fullEnrichGetContactEnrichment,
  fullEnrichGetReverseEmailLookup,
  fullEnrichLookupCompany,
  fullEnrichLookupPerson,
  fullEnrichSearchCompanies,
  fullEnrichSearchPeople,
  fullEnrichStartContactEnrichment,
  fullEnrichStartReverseEmailLookup,
} from "@sixb/connector-fullenrich/agent-tools"
import { createSixb } from "@sixb/core"
import { fullenrichConnector } from "./connectors/fullenrich"

export const sixb = createSixb({
  // ...storage, broker, queues, sandboxes, models
  tools: [
    fullEnrichSearchPeople(fullenrichConnector, { maxResults: 25 }),
    fullEnrichSearchCompanies(fullenrichConnector),
    fullEnrichLookupPerson(fullenrichConnector),
    fullEnrichLookupCompany(fullenrichConnector),
    fullEnrichStartContactEnrichment(fullenrichConnector, {
      maxContacts: 10,
      allowedFields: ["contact.work_emails"],
    }),
    fullEnrichGetContactEnrichment(fullenrichConnector),
    fullEnrichStartReverseEmailLookup(fullenrichConnector),
    fullEnrichGetReverseEmailLookup(fullenrichConnector),
    fullEnrichCreditBalance(fullenrichConnector),
  ],
})
```

Register only the tools an agent should have: search, lookup, and enrichment spend credits.

| Tool | Model input | Host options |
| --- | --- | --- |
| `search_people` | `filters` (FullEnrich's people filters), `page: { limit?, cursor? }` | `maxResults` (25, at most 100) |
| `search_companies` | `filters` (FullEnrich's company filters), `page: { limit?, cursor? }` | `maxResults` (25, at most 100) |
| `lookup_person` | `identifiers`: LinkedIn URL or ID, or name with a company identifier | |
| `lookup_company` | `identifiers`: domain, LinkedIn URL, or LinkedIn ID | |
| `start_contact_enrichment` | `contacts`, `enrich_fields` | `maxContacts` (10), `allowedFields`, webhooks, `silentFail` |
| `get_contact_enrichment` | `enrichment_id` | |
| `start_reverse_email_lookup` | `emails` | `maxEmails` (10), webhooks, `silentFail` |
| `get_reverse_email_lookup` | `lookup_id` | |
| `get_enrichment_credits` | none | |

Every tool also takes `timeoutMs` (20 seconds), which bounds connector resolution and the
request. Behavior worth knowing:

- Searches return 10 results unless the model asks for more, up to `maxResults`, as compact
  summaries without emails or phones. `next_cursor` appears only when another page may exist.
- Seniority, job function, and company type filters accept only FullEnrich's documented values.
- Lookups return one full profile (bounded experience, education, skills, and technologies), or
  `null` when nothing matches.
- `allowedFields` is the model's enum for `enrich_fields`; it defaults to work emails, personal
  emails, and phones. Contacts without enough identifiers are rejected before any credit is
  spent unless `silentFail` is set.
- Webhook URLs, job names, and `custom` fields stay on the host. Set `webhookUrl` or
  `contactFinishedWebhookUrl` to this connector's result route to receive results in your app.
- The `get_*` tools answer `ready: false` while a job is running instead of failing.
- Starting a job is never retried; reads retry 429 and 5xx responses. FullEnrich allows 60
  requests per minute per workspace, and a 429 without `Retry-After` waits for the next minute.
- Provider errors reach the model as FullEnrich's code and message; the API key never does.
