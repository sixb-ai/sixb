# @sixb/connector-github

A small GitHub connector for Sixb, built on `@sixb/connector-rest`.

- **Repositories** — list or iterate, for a user or an org
- **Issues** — list, create, update, close
- **Webhooks** — receive GitHub events through one inbound route

## Register

Drop this in your project's `connectors/` directory — `createSixb()` auto-discovers it:

```ts
import { defineConnector } from "@sixb/core"
import { github } from "@sixb/connector-github"

export const githubConnector = defineConnector(
  "github",
  github({
    token: process.env.GITHUB_TOKEN!,
    owner: "acme", // default owner for issue calls
    repo: "web", // default repo
  })
)
```

| Option          | Description                                                              |
| --------------- | ------------------------------------------------------------------------ |
| `token`         | **Required.** GitHub token — a fine-grained PAT is recommended.          |
| `owner`         | Default repo owner (user or org) for issue calls.                        |
| `repo`          | Default repo for issue calls.                                            |
| `baseUrl`       | API base URL — override for GitHub Enterprise Server.                    |
| `webhookSecret` | Secret used to verify inbound webhooks. See [Webhooks](#webhooks).       |
| `onEvent`       | Handler for inbound webhook events. See [Webhooks](#webhooks).           |

**Token permissions** (fine-grained PAT): `Metadata: read` and `Issues: read & write`.

## Client API

```ts
const gh = await sixb.connector(githubConnector)
```

| Method                          | Description                                                  |
| ------------------------------- | ------------------------------------------------------------ |
| `listRepositories(opts?)`       | One page of the auth user's repos, or an org's via `{ org }`. |
| `iterRepositories(opts?)`       | Async iterator over repositories, following pagination.       |
| `listIssues(opts?)`             | One page of a repo's issues; pull requests filtered out.     |
| `iterIssues(opts?)`             | Async iterator over issues, following pagination.             |
| `createIssue(input)`            | Create an issue (`title` required).                          |
| `updateIssue(number, patch)`    | Update title, body, state, labels, or assignees.             |
| `deleteIssue(number, target?)`  | Closes the issue — see [Notes](#notes).                      |

```ts
const page = await gh.listRepositories({ org: "acme", pageSize: 100 })
const issue = await gh.createIssue({ title: "Bug", labels: ["triage"] })
await gh.updateIssue(issue.number, { body: "Updated", state: "closed" })
```

The list methods return a **single page** envelope. Pass `pageSize`, then pass
`nextPageToken` back to fetch the next page:

```ts
let pageToken: string | undefined
do {
  const page = await gh.listIssues({ repo: "web", state: "all", pageSize: 100, pageToken })
  // handle page.items
  pageToken = page.nextPageToken
} while (pageToken)
```

Use the iterator helpers when you want all items without managing page tokens:

```ts
for await (const issue of gh.iterIssues({ repo: "web", state: "all", pageSize: 100 })) {
  // handle issue
}
```

Every issue method takes an optional `owner` / `repo` to override the connector
defaults per call — so one connector can work across many repos.

## Webhooks

A webhook has two halves:

| Half                                   | Who owns it                          |
| -------------------------------------- | ------------------------------------ |
| **Receiving** events at an inbound route | this connector — set `onEvent`     |
| **Registering** the webhook on GitHub  | you — in GitHub's UI / CLI / API     |

### 1. Handle events

Set `onEvent`. GitHub sends every subscribed event to one route
(`/api/webhooks/<connector-id>/events`), so switch on `event.name`:

```ts
github({
  // …token, owner, repo, webhookSecret…
  onEvent: async ({ event, sixb, client }) => {
    if (event.name !== "issues") return // "issues" | "push" | "ping" | …
    const { action, issue } = event.payload as unknown as GitHubIssueEvent

    // `sixb` — the live runtime; write the event into your ontology
    await sixb.upsertObject(Issue.id, { id: String(issue.number), title: issue.title })

    // `client()` — lazily resolves the GitHub client to call back
    if (action === "opened") {
      await (await client()).updateIssue(issue.number, { labels: ["triage"] })
    }
  },
})
```

`event` is `{ name, action?, deliveryId, payload }`. GitHub's first `ping` arrives
as `event.name === "ping"`.

### 2. Register it on GitHub

This connector **does not register webhooks** — you create and manage them in
GitHub (**Settings → Webhooks → Add webhook**, or CLI / API / Terraform):

| Field            | Value                                              |
| ---------------- | -------------------------------------------------- |
| **Payload URL**  | `https://<your-host>/api/webhooks/github/events`   |
| **Content type** | `application/json`                                 |
| **Secret**       | your `webhookSecret` (see below)                   |
| **Events**       | "Let me select individual events" → **Issues**     |

> Your server must be publicly reachable. In development, tunnel it
> (e.g. `ngrok http <port>`) and use the tunnel URL.

### The webhook secret

`webhookSecret` is a key **you generate** — GitHub doesn't issue it. It's how the
connector proves a delivery genuinely came from GitHub, since the route is public.

- **Generate one:** `openssl rand -hex 32`
- **Use the same value** in GitHub and in `webhookSecret` — a mismatch fails every delivery.
- **Not the same as `token`:** `token` signs *your* calls **to** GitHub; `webhookSecret` verifies *GitHub's* calls **to** you.
- **Unset = no verification** (any request is accepted) — always set it in production.

Under the hood: GitHub signs each payload and sends `X-Hub-Signature-256`; the
connector recomputes the HMAC over the raw body and rejects mismatches before
`onEvent` runs.

## Notes

- **Delete = close.** GitHub's REST API can't delete issues, so `deleteIssue`
  closes it (`state: "closed"`, `state_reason: "not_planned"`). True deletion
  needs the GraphQL `deleteIssue` mutation and repo-admin rights.
- **Pull requests.** `listIssues` drops entries GitHub returns with a
  `pull_request` field, so you only get real issues.
