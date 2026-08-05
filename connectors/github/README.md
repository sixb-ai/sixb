# @sixb/connector-github

A small GitHub connector for Sixb, built on `@sixb/connector-rest`.

- **Repositories** — list authenticated-user/org repositories, get a repository
- **Issues** — list authenticated-user/org/repository issues, get/create/update repository issues
- **People** — query users, organization members, memberships, outside collaborators, and invitations
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
  })
)
```

| Option          | Description                                                              |
| --------------- | ------------------------------------------------------------------------ |
| `token`         | **Required.** GitHub token — a fine-grained PAT is recommended.          |
| `baseUrl`       | API base URL — override for GitHub Enterprise Server.                    |
| `webhookSecret` | Secret used to verify inbound webhooks. See [Webhooks](#webhooks).       |
| `onEvent`       | Handler for inbound webhook events. See [Webhooks](#webhooks).           |

**Token permissions** (fine-grained PAT): `Metadata: read` and `Issues: read & write` for
repository and issue APIs. Organization people APIs require `Members: read`. Public user profiles
and public organization membership can be queried without that organization permission, but private
membership visibility depends on the authenticated user's organization access.

## Client API

```ts
const gh = await sixb.connector(githubConnector)
```

The client is scoped by GitHub resource:

| API                                      | GitHub endpoint                               |
| ---------------------------------------- | --------------------------------------------- |
| `gh.repos.listForAuthenticatedUser()`    | `GET /user/repos`                             |
| `gh.issues.listForAuthenticatedUser()`   | `GET /issues`                                 |
| `gh.repo({ owner, repo }).get()`         | `GET /repos/{owner}/{repo}`                   |
| `gh.repo({ owner, repo }).issues.list()` | `GET /repos/{owner}/{repo}/issues`            |
| `gh.repo({ owner, repo }).issues.get()`  | `GET /repos/{owner}/{repo}/issues/{number}`   |
| `gh.repo({ owner, repo }).issues.create()` | `POST /repos/{owner}/{repo}/issues`         |
| `gh.repo({ owner, repo }).issues.update()` | `PATCH /repos/{owner}/{repo}/issues/{number}` |
| `gh.repo({ owner, repo }).issues.comments.list()` | `GET /repos/{owner}/{repo}/issues/{number}/comments` |
| `gh.repo({ owner, repo }).issues.comments.create()` | `POST /repos/{owner}/{repo}/issues/{number}/comments` |
| `gh.repo({ owner, repo }).issues.comments.get()` | `GET /repos/{owner}/{repo}/issues/comments/{id}` |
| `gh.repo({ owner, repo }).issues.comments.update()` | `PATCH /repos/{owner}/{repo}/issues/comments/{id}` |
| `gh.repo({ owner, repo }).issues.comments.delete()` | `DELETE /repos/{owner}/{repo}/issues/comments/{id}` |
| `gh.org(org).repos.list()`               | `GET /orgs/{org}/repos`                       |
| `gh.org(org).issues.listForAuthenticatedUser()` | `GET /orgs/{org}/issues`              |
| `gh.users.getAuthenticated()`             | `GET /user`                                      |
| `gh.users.get(username)`                  | `GET /users/{username}`                          |
| `gh.users.getById(accountId)`             | `GET /user/{account_id}`                         |
| `gh.users.list()`                         | `GET /users`                                     |
| `gh.memberships.list()`                   | `GET /user/memberships/orgs`                     |
| `gh.memberships.get(org)`                 | `GET /user/memberships/orgs/{org}`               |
| `gh.org(org).members.list()`              | `GET /orgs/{org}/members`                        |
| `gh.org(org).members.listPublic()`        | `GET /orgs/{org}/public_members`                 |
| `gh.org(org).members.check(username)`     | `GET /orgs/{org}/members/{username}`             |
| `gh.org(org).members.checkPublic(username)` | `GET /orgs/{org}/public_members/{username}`    |
| `gh.org(org).members.getMembership(username)` | `GET /orgs/{org}/memberships/{username}`     |
| `gh.org(org).outsideCollaborators.list()` | `GET /orgs/{org}/outside_collaborators`          |
| `gh.org(org).invitations.list()`          | `GET /orgs/{org}/invitations`                    |

```ts
const userRepos = await gh.repos.listForAuthenticatedUser({
  visibility: "private",
  affiliation: ["owner", "collaborator"],
  sort: "updated",
  direction: "desc",
})

const orgRepos = await gh.org("acme").repos.list({
  type: "sources",
  pageSize: 100,
})

const members = await gh.org("acme").members.list({ role: "member", pageSize: 100 })
const profile = await gh.users.get(members.items[0]!.login)
const membership = await gh.org("acme").members.getMembership(profile.login)

const repo = gh.repo({ owner: "acme", repo: "web" })
const issue = await repo.issues.create({ title: "Bug", labels: ["triage"] })
const comment = await repo.issues.comments.create(issue.number, { body: "Investigating." })
await repo.issues.comments.update(comment.id, { body: "Fixed." })
await repo.issues.comments.delete(comment.id)
await repo.issues.update(issue.number, { body: "Updated", state: "closed" })
```

Repository list options follow GitHub's two endpoint shapes. Authenticated-user
repository calls support `visibility`, `affiliation`, `type`, `sort`,
`direction`, `since`, and `before`; `type` cannot be combined with `visibility`
or `affiliation`. Organization repository calls are scoped with `gh.org(org)`
and support `type`, `sort`, and `direction`.

The list methods return a **single page** envelope. Pass `pageSize`, then pass
`nextPageToken` back to fetch the next page:

```ts
let pageToken: string | undefined
const repo = gh.repo({ owner: "acme", repo: "web" })

do {
  const page = await repo.issues.list({
    state: "all",
    pageSize: 100,
    pageToken,
  })
  // handle page.items
  pageToken = page.nextPageToken
} while (pageToken)
```

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
  // …token, webhookSecret…
  onEvent: async ({ event, sixb, client }) => {
    if (event.name !== "issues") return // "issues" | "push" | "ping" | …
    const { issue, repository } = event.payload

    // `sixb` — the live runtime; write the event into your ontology
    await sixb.upsertObject(Issue.id, { id: String(issue.number), title: issue.title })

    // `client()` — lazily resolves the GitHub client to call back
    if (event.action === "opened") {
      const gh = await client()
      await gh
        .repo({ owner: repository.owner.login, repo: repository.name })
        .issues.update(issue.number, { labels: ["triage"] })
    }
  },
})
```

`event.name` is GitHub's webhook event-name union, and narrowing on it narrows
`event.payload` to the matching GitHub payload type. GitHub's first `ping`
arrives as `event.name === "ping"`.

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

- **Closing issues.** Use `repo.issues.update(number, { state: "closed" })`,
  matching GitHub's Update an issue REST endpoint.
- **Pull requests.** GitHub's repository issues endpoint can return pull
  requests with a `pull_request` field; this connector returns them unchanged.
