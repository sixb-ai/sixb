# @sixb/connector-ctm

CallTrackingMetrics (CTM) connector for Sixb, built on `@sixb/connector-rest`.

- **Call log** — calls, text messages and form submissions, with transcripts, recordings, sales,
  comments and tags
- **What a call points to** — tracking numbers, sources, receiving numbers, queues, voice menus,
  routers, schedules, users and agents, custom fields, tags
- **Agent analytics and reports** — presence events, utilization, report series, usage logs
- **Webhooks** — receive each activity as CTM delivers it, and manage CTM's webhooks

## Register

Drop this in your project's `connectors/` directory — `createSixb()` auto-discovers it:

```ts
import { defineConnector } from "@sixb/core"
import { ctm } from "@sixb/connector-ctm"

export const ctmConnector = defineConnector(
  "ctm",
  ctm({
    accessKey: process.env.CTM_ACCESS_KEY!,
    secretKey: process.env.CTM_SECRET_KEY!,
    accountId: Number(process.env.CTM_ACCOUNT_ID),
  })
)
```

| Option                   | Description                                                                 |
| ------------------------ | --------------------------------------------------------------------------- |
| `accessKey`, `secretKey` | **Required.** API keys, sent as basic auth. A string or a resolver.         |
| `accountId`              | The account the client's resources address.                                 |
| `baseUrl`                | Defaults to `https://api.calltrackingmetrics.com/api/v1/`.                  |
| `minDelayMs`             | Pacing between requests. Defaults to 100 ms: CTM allows 10 requests a second. |
| `timeoutMs`, `retry`     | Per-request timeout and retry policy.                                       |
| `onEvent`, `webhookAuth` | Receive webhook deliveries. See [Webhooks](#webhooks).                      |

Keys come from **Account Settings** for one account, or **Agency Settings** for every account of
an agency. An agency key reaches the others with `client.account(id)`:

```ts
const ctm = await sixb.connector(ctmConnector)

for await (const account of ctm.accounts.listAll()) {
  const calls = await ctm.account(account.id).calls.list({ timeDuration: "yesterday" })
}
```

## The call log

`calls` holds every activity: `direction` is `inbound`, `outbound`, `msg_inbound`, `msg_outbound`
or `form`. Lists page with an `after` cursor; `listAll` follows it, 100 activities a request unless
`pageSize` says otherwise.

```ts
for await (const call of ctm.calls.listAll({
  startDate: "2026-11-01",
  endDate: "2026-11-12",
  directions: ["inbound", "outbound"],
  pageSize: 100,
})) {
  const detail = await ctm.calls.get(call.id) // adds `caller`, the contact behind the call
  const transcript = await ctm.calls.transcript(call.id)
  const audio = await ctm.calls.recording(call.sid) // a Response: stream `.body` to storage
}
```

| Method                                              | Endpoint                                  |
| --------------------------------------------------- | ----------------------------------------- |
| `calls.list(opts?)`, `calls.listAll(opts?)`         | `GET /calls`                              |
| `calls.search(opts?)`, `calls.searchAll(opts?)`     | `POST /calls/search`, with `query`        |
| `calls.get(id)`                                     | `GET /calls/{id}`                         |
| `calls.transcript(id)`                              | `GET /calls/{id}/transcription.json`      |
| `calls.recording(sid)`                              | `GET /calls/{sid}/recording`              |
| `calls.mapping()`                                   | `GET /calls/mapping`                      |
| `calls.update(id, input)`                           | `POST /calls/{id}/modify`                 |
| `calls.getSale(id)`, `saveSale`, `deleteSale`       | `/calls/{id}/sale`                        |
| `calls.addComment`, `updateComment`, `deleteComment` | `/calls/{id}/{add,update,delete}_comment` |
| `calls.addTag(id, tag)`, `removeTag(id, tag)`       | `PATCH`/`DELETE /calls/{id}/tag`          |
| `calls.markSpam(id)`, `unmarkSpam(id)`              | `POST /calls/{id}/{spam,unspam}`          |

A call keeps changing after it ends: attribution, transcript, score and sale arrive later, and CTM
has no "changed since" filter. Keep a copy current with the `update`, `end_delayed`, `sale` and
`paid` webhooks, and re-read the last few days on a schedule.

## Everything else

Every other list takes `page` and `pageSize`, returns `{ records, page, totalPages, nextPage, … }`,
and has a `listAll` that walks every page, 100 records a request by default.

| Resource                | Methods                                                  | CTM route                  |
| ----------------------- | -------------------------------------------------------- | -------------------------- |
| `sms`, `textOptOuts`    | `list`, `listAll`, `get`                                 | `/sms`, `/opt_out_texts`   |
| `trackingNumbers`       | `list`, `listAll`, `get`, `dialRoutes`                   | `/numbers`                 |
| `receivingNumbers`, `targetNumbers` | `list`, `listAll`, `get`                     | `/receiving_numbers`, `/target_numbers` |
| `doNotCall`, `blockedNumbers` | `list`                                             | `/do_not_calls`, `/calls/blocked_numbers` |
| `sources`               | `list`, `listAll`, `get`                                 | `/sources`                 |
| `queues`                | `list`, `listAll`                                        | `/queues`                  |
| `schedules`, `triggers` | `list`, `listAll`, `get`                                 | `/schedules`, `/triggers`  |
| `voiceMenus`            | `list`, `listAll`, `get`, `listItems`, `listAllItems`, `getItem` | `/voice_menus`     |
| `smartRouters`, `geoRouters` | `list`, `listAll`, `get`                            | `/conditional_routers`, `/geo_routes` |
| `users`                 | `list`, `listAll`, `get`                                 | `/users`                   |
| `userGroups`            | `list`, `listAll`                                        | `/user_groups`             |
| `agents`                | `list`, `phoneStatus`, `byStatus`, `events`, `utilization` | `/agents`                |
| `customFields`          | `list`, `listAll`, `get`, `listPanels`, `getPanel`       | `/custom_fields`           |
| `formReactors`          | `list`, `listAll`, `get`                                 | `/form_reactors`           |
| `contactLists`          | `list`, `listAll`, `get`, `listContacts`, `contains`     | `/lists`                   |
| `lookup`                | `list(type, opts?)`, `listAll` — tags: `lookup.list("tag")` | `/lookup`               |
| `reports`               | `series`, `usageLogs`                                    | `/reports`                 |
| `webhooks`              | `list`, `listAll`, `get`, `create`, `update`, `delete`   | `/webhooks`                |
| `changeNotifications`   | `list`, `listAll`, `create`, `delete`                    | `/change_notifications`    |
| `accounts`, `agency`    | `list`, `listAll`, `get`, `listNames`, `status`; `get`  | `/accounts`, `/agency`     |

Joining records: a call's `tracking_number_id`, `source_id` and `agent_id` point to
`trackingNumbers`, `sources` and `users` (`USR…` IDs), and `call_path[].route_id` to a queue, voice
menu or router. Agent analytics key users by their numeric `uid` instead.

## Webhooks

### Receive activities

```ts
ctm({
  accessKey: process.env.CTM_ACCESS_KEY!,
  secretKey: process.env.CTM_SECRET_KEY!,
  accountId: 12345,
  webhookAuth: {
    username: process.env.CTM_WEBHOOK_USER!,
    password: process.env.CTM_WEBHOOK_PASSWORD!,
  },
  onEvent: async ({ event, sixb }) => {
    // event.activity: the call, text or form; event.trigger: from the URL, see below
  },
})
```

The route is `https://<sixb-host>/api/webhooks/ctm/events`. CTM signs nothing: the route checks the
basic-auth credential set on the webhook in CTM, and refuses to build without `webhookAuth` unless
`webhookAllowUnverified: true`. It answers `200`.

CTM's body is the activity alone and does not say which trigger fired. Register one webhook per
trigger and add `?trigger=<name>` to each URL; it comes back as `event.trigger`. An `update`
webhook resends the same activity at each change, so handlers upsert by `event.activity.id`.

### Register a webhook

```ts
await ctm.webhooks.create({
  weburl: "https://<sixb-host>/api/webhooks/ctm/events?trigger=end_delayed",
  position: "end_delayed",
  hooktype: "call",
  username: process.env.CTM_WEBHOOK_USER!,
  password: process.env.CTM_WEBHOOK_PASSWORD!,
})
```

`hooktype: "call"` sends the whole activity, which the route expects.

## Errors and retries

A non-2xx response throws `CtmApiError` with `status`, `responseBody`, `headers` and
`retryAfterMs`. A misconfiguration, such as an empty key or no account to address, throws
`CtmConfigurationError` before any request. Reads retry network errors, 429 and 5xx twice; writes
retry only a 429, since CTM has no idempotency keys.

## Notes

- CTM publishes no response example for many routes (tracking numbers, sources, agents, custom
  fields, routers, SMS, …). Their records are typed `CtmRecord`: an `id`, a `name`, and the
  rest as CTM returns it. `bun connectors/ctm/tests/ctm.e2e.ts` reads them from a live account.
- List envelopes name the records after the resource, except where CTM does not (the do-not-call
  list answers with `receiving_numbers`); the connector takes the envelope's only array then.
- Not covered: account and billing administration, number purchasing, dialers, the Trust Center,
  live call control (transfers, recording start and stop), redaction, and writes to routing
  configuration.
