# @sixb/connector-unipile

Typed Unipile v1 connector for Sixb, focused on dependable LinkedIn outreach. It covers Hosted Auth,
account health, people search, profiles, invitations, relationships, text conversations, and the
webhooks needed to observe replies and accepted invitations.

The connector is intentionally a transport layer. Campaign state, message generation, approval,
scheduling, opt-outs, and analytics belong in Sixb objects, workflows, rules, and app code.

## Register

Create an access token in the Unipile Dashboard and copy the account-specific DSN, including its
port when present.

```ts
import { unipile } from "@sixb/connector-unipile"
import { defineConnector } from "@sixb/core"

export const unipileConnector = defineConnector(
  "unipile",
  unipile({
    dsn: process.env.UNIPILE_DSN!,
    accessToken: process.env.UNIPILE_ACCESS_TOKEN!,
  })
)
```

`createSixb()` discovers the definition from an app's `connectors/` directory. Resolve its typed
client with:

```ts
const client = await sixb.connector(unipileConnector)
```

The access token may also be an async resolver. It runs for every attempt, which supports token
rotation without rebuilding the connector.

## Options

| Option | Description |
| --- | --- |
| `dsn` | Required Unipile origin, such as `https://api123.unipile.com:13337`. |
| `accessToken` | Required token or async resolver. Sent as `X-API-KEY`. |
| `timeoutMs` | Optional per-attempt timeout. |
| `minDelayMs` | Optional global floor between request starts. This is not a campaign scheduler. |
| `retry` | Retry policy for synchronized reads only. Defaults to two transient retries. |
| `webhookSecret` | Shared secret expected in `X-Sixb-Unipile-Secret`. |
| `webhookAllowUnverified` | Explicit local-development opt-in to an unverified inbound route. |
| `onEvent` | Handler for messages, account statuses, and new relationships. |

The connector appends `/api/v1/` to `dsn`; pass an origin, not an API path.

## Account connection

Phase 1 uses Unipile's Hosted Auth flow instead of collecting LinkedIn credentials. Create links on
the server so the Unipile access token never reaches the browser.

```ts
const link = await client.hostedAuth.createLink({
  type: "create",
  providers: ["LINKEDIN"],
  expiresOn: new Date(Date.now() + 15 * 60_000).toISOString(),
  success_redirect_url: "https://app.example/settings/integrations",
  failure_redirect_url: "https://app.example/settings/integrations?failed=true",
})

// Redirect the browser to link.url.
```

`api_url` defaults to the connector DSN. Reconnect an account with:

```ts
await client.hostedAuth.createLink({
  type: "reconnect",
  reconnect_account: accountId,
  expiresOn: new Date(Date.now() + 15 * 60_000).toISOString(),
})
```

After the redirect, refresh `client.accounts.list()` and wait for the account's source status to be
`OK` before starting work. A status other than `OK` means reads may be stale and message webhooks
may stop.

| Client method | Unipile endpoint |
| --- | --- |
| `client.accounts.list(options?)` | `GET /accounts` |
| `client.accounts.listAll(options?)` | Cursor iterator over `GET /accounts` |
| `client.accounts.get(accountId)` | `GET /accounts/{id}` |
| `client.hostedAuth.createLink(input)` | `POST /hosted/accounts/link` |

## Find and inspect people

The first search surface accepts a LinkedIn people-search URL copied from Classic, Sales Navigator,
or Recruiter. It returns one explicit page; there is deliberately no `searchAll` helper.

```ts
const page = await client.linkedin.searchPeople({
  account_id: accountId,
  url: "https://www.linkedin.com/search/results/people/?keywords=operations%20leader",
  limit: 25,
})

for (const person of page.items) {
  console.log(person.id, person.name, person.headline)
}
```

LinkedIn Classic searches should stay at or below 50 results per page. Sales Navigator and
Recruiter accept up to 100 through Unipile.

Resolve a public profile slug or provider ID before inviting:

```ts
const profile = await client.users.getProfile("ada-lovelace", {
  account_id: accountId,
  linkedin_sections: ["*_preview", "experience"],
  notify: false,
})
```

Request only the sections the app uses. Full `"*"` profile retrieval is expensive and may return
`throttled_sections` when LinkedIn limits it.

| Client method | Unipile endpoint |
| --- | --- |
| `client.linkedin.searchPeople(input)` | `POST /linkedin/search` |
| `client.users.getProfile(identifier, options)` | `GET /users/{identifier}` |
| `client.users.listRelations(options)` | `GET /users/relations` |

## Invite a person

The provider ID returned by search or profile retrieval is required.

```ts
const invitation = await client.users.sendInvitation({
  account_id: accountId,
  provider_id: profile.provider_id,
  message: "I enjoyed your work on operations systems and would like to connect.",
})
```

The connector enforces Unipile's 300-character API ceiling. LinkedIn may apply a lower limit based
on the account and invitation type, and reports those failures through the API.

`client.users.listRelations({ account_id })` is page-only. Use it for initial synchronization or
infrequent recovery, not fixed-interval polling; the `new_relation` webhook is the normal path.

## Conversations

Phase 1 supports text-only conversations with existing relations.

```ts
const started = await client.chats.start({
  account_id: accountId,
  attendees_ids: [profile.provider_id],
  text: "Thanks for connecting—would it be useful to compare notes on your current workflow?",
})

if (started.chat_id) {
  await client.messages.send(started.chat_id, {
    account_id: accountId,
    text: "Here is the approved follow-up.",
  })
}
```

The `account_id` on `messages.send` is optional upstream but recommended: Unipile uses it to prevent
sending through a chat that belongs to another account.

| Client method | Unipile endpoint |
| --- | --- |
| `client.chats.list(options?)` | `GET /chats` |
| `client.chats.listAll(options?)` | Cursor iterator over `GET /chats` |
| `client.chats.get(chatId)` | `GET /chats/{chat_id}` |
| `client.chats.start(input)` | `POST /chats` |
| `client.messages.listForChat(chatId, options?)` | `GET /chats/{chat_id}/messages` |
| `client.messages.listAllForChat(chatId, options?)` | Cursor iterator over chat messages |
| `client.messages.send(chatId, input)` | `POST /chats/{chat_id}/messages` |

The connector builds `FormData` for text writes and lets the runtime set the multipart boundary.

## Webhooks

Unipile v1 allows a custom header on each registration but does not document a built-in signature
for these events. Generate a shared secret and configure it on the connector:

```ts
export const unipileConnector = defineConnector(
  "unipile",
  unipile({
    dsn: process.env.UNIPILE_DSN!,
    accessToken: process.env.UNIPILE_ACCESS_TOKEN!,
    webhookSecret: process.env.UNIPILE_WEBHOOK_SECRET!,
    onEvent: async ({ event, logger }) => {
      switch (event.kind) {
        case "message": {
          const sentByAccount =
            event.account_info?.user_id === event.sender.attendee_provider_id
          logger.info(
            sentByAccount ? "[Unipile] Message sent" : "[Unipile] Prospect replied",
            { messageId: event.message_id }
          )
          break
        }
        case "new_relation":
          logger.info("[Unipile] Invitation accepted", {
            providerId: event.user_provider_id,
          })
          break
        case "account_status":
          logger.info("[Unipile] Account status", {
            status: event.AccountStatus.message,
          })
          break
      }
    },
  })
)
```

The inbound endpoint is:

```text
https://<sixb-host>/api/webhooks/<connector-id>/events
```

Register three remote webhooks against that same URL:

```ts
const request_url = "https://app.example/api/webhooks/unipile/events"

await client.webhooks.create({
  source: "messaging",
  request_url,
  events: ["message_received"],
  name: "Sixb messages",
})

await client.webhooks.create({
  source: "users",
  request_url,
  name: "Sixb relationships",
})

await client.webhooks.create({
  source: "account_status",
  request_url,
  events: [
    "CONNECTING",
    "OK",
    "STOPPED",
    "ERROR",
    "CREDENTIALS",
    "DELETED",
    "CREATION_SUCCESS",
    "RECONNECTED",
    "SYNC_SUCCESS",
  ],
  name: "Sixb account status",
})
```

For JSON registrations, `client.webhooks.create` adds `Content-Type: application/json`; Unipile
does not add it to API-created webhooks by default. When `webhookSecret` is configured, the method
also injects `X-Sixb-Unipile-Secret` and replaces any caller-supplied value for that header. The
inbound route verifies it before dispatch.

Unipile expects `200` within 30 seconds and retries failed deliveries five times. `onEvent` should
persist or emit work and return; do not wait for an agent to draft a reply.

Important event behavior:

- `message_received` includes messages sent by the connected account. Compare the account and sender
  provider IDs before classifying a reply.
- `new_relation` can arrive up to roughly eight hours after acceptance because Unipile polls
  LinkedIn at provider-safe intervals.
- pass account-status `events` explicitly. Unipile's defaults omit `CONNECTING`, `OK`, and
  `STOPPED`, which would hide some failures and the recovery to `OK`;
- when account status is not `OK`, pause campaign work and offer Hosted Auth reconnection for
  `CREDENTIALS`.

| Client method | Unipile endpoint |
| --- | --- |
| `client.webhooks.list(options?)` | `GET /webhooks` |
| `client.webhooks.listAll(options?)` | Cursor iterator over `GET /webhooks` |
| `client.webhooks.create(input)` | `POST /webhooks` |
| `client.webhooks.delete(webhookId)` | `DELETE /webhooks/{id}` |

## Pagination and retries

Unipile collections return an opaque `cursor`. `listAll` helpers preserve filters, stop on `null`,
and fail on a repeated cursor instead of looping forever.

Only synchronized Unipile reads—accounts, chats, messages, and webhook registrations—retry
transient network failures, `429`, and `5xx` by default. Retries honor `Retry-After`.

The connector never automatically retries:

- LinkedIn search;
- profile retrieval or relationship listing;
- invitations;
- Hosted Auth creation;
- chat creation or message sends;
- webhook creation or deletion.

These operations either mutate state or consume provider activity. Callers must inspect the failure
before deciding whether another attempt is safe.

## Errors

Non-success responses throw `UnipileApiError` with the status, parsed response body, response
headers, request ID when present, and `retryAfterMs`.

```ts
import { UnipileApiError } from "@sixb/connector-unipile"

try {
  await client.users.sendInvitation(input)
} catch (error) {
  if (error instanceof UnipileApiError) {
    console.error(error.status, error.responseBody, error.retryAfterMs)
  }
}
```

Upstream details such as `cannot_resend_yet` remain available in `responseBody`.

## Provider responsibility

Unipile does not enforce LinkedIn's activity limits. The application must enforce its own
per-account budgets, scheduling, warm-up rules, approvals, consent and opt-out policy, and immediate
pause behavior for account errors. A connector delay does not make bulk outreach safe or compliant.

## Not covered yet

Native credential/cookie authentication, Hosted Auth notify callbacks, structured LinkedIn search
filters, pending invitation management, InMail, attachments, voice/video, message quoting,
reactions, posts/comments, company pages, jobs, and non-LinkedIn provider-specific features are
intentionally deferred.

## Official documentation

- [Getting started](https://developer.unipile.com/docs/getting-started)
- [API usage](https://developer.unipile.com/docs/api-usage)
- [Hosted Auth](https://developer.unipile.com/docs/hosted-auth)
- [Account lifecycle](https://developer.unipile.com/docs/account-lifecycle)
- [LinkedIn search](https://developer.unipile.com/docs/linkedin-search)
- [Retrieving users](https://developer.unipile.com/docs/retrieving-users)
- [Inviting users](https://developer.unipile.com/docs/invite-users)
- [Sending messages](https://developer.unipile.com/docs/send-messages)
- [New-message webhooks](https://developer.unipile.com/docs/new-messages-webhook)
- [Detecting accepted invitations](https://developer.unipile.com/docs/detecting-accepted-invitations)
- [Provider limits and restrictions](https://developer.unipile.com/docs/provider-limits-and-restrictions)
