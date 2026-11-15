# @sixb/connector-github

A small GitHub connector for Sixb, built on `@sixb/connector-rest`.

- **Repositories** — list authenticated-user/org repositories, get a repository
- **Branches** — list a repository's branches, optionally only protected or unprotected ones, get one by name, create one from a branch, tag or commit, delete one
- **Issues** — list authenticated-user/org/repository issues, get/create/update repository issues, read an issue's timeline, sub-issues, parent and dependencies, list every comment in a repository
- **Labels, assignees and milestones** — manage a repository's labels, list who can be assigned, list and get milestones
- **Pull requests** — list a repository's pull requests, get one with its merge state and size, read the files it changes with their patches and the commits on its branch, merge one, review it, and read or write the inline comments on its diff
- **Checks** — read a commit's, branch's or tag's check runs and the combined commit status GitHub rolls them up into
- **Stacks** — see where a pull request sits in a stack of dependent pull requests, list a repository's stacks, get one with its pull requests in order
- **Commits** — list a repository's commits by branch, path, author or date, get one with its changed files
- **Attachments** — find the images, videos and files in an issue or comment body and download them
- **Releases** — list/get/create/update/delete releases, generate release notes, manage and download assets, react
- **Actions** — read workflows, runs, their jobs, logs and artifacts, re-run or cancel a run, and start one by hand
- **People** — query users, organization members, memberships, outside collaborators, and invitations
- **Webhooks** — receive GitHub events through one inbound route

## Register

Drop one of these in your project's `connectors/` directory so `createSixb()` auto-discovers it.

### Static token or GitHub App installation

```ts
import { defineConnector } from "@sixb/core"
import { github } from "@sixb/connector-github"

// Fine-grained PAT:
export const githubConnector = defineConnector(
  "github",
  github({
    token: process.env.GITHUB_TOKEN!,
  })
)

// Or a GitHub App installation:
export const githubAppConnector = defineConnector(
  "github-app",
  github({
    auth: {
      app: {
        appId: process.env.GITHUB_APP_ID!,
        privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
        installationId: process.env.GITHUB_INSTALLATION_ID!,
      },
    },
  })
)
```

### Managed OAuth connections

Register `https://<sixb-api-origin>/auth/connectors/callback` as a Callback URL on your GitHub App
and enable expiring user authorization tokens:

```ts
import { defineConnector } from "@sixb/core"
import { github } from "@sixb/connector-github"

export const githubConnector = defineConnector(
  "github",
  github({
    auth: {
      oauth: {
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
    },
  }),
  { owners: ["user"] } // or ["project", "user"]
)
```

| Option          | Description                                                              |
| --------------- | ------------------------------------------------------------------------ |
| `token`         | Static GitHub token (or pass `auth: { token }`).                         |
| `auth.app`      | GitHub App installation credentials (`appId`, `privateKey`, `installationId`). |
| `auth.oauth`    | OAuth client credentials (`clientId`, `clientSecret`, optional `webBaseUrl`, `scopes`, `pkce`). |
| `baseUrl`       | API base URL for GitHub Enterprise Cloud or Server.                      |
| `webhookSecret` | Secret used to verify inbound webhooks. See [Webhooks](#webhooks).       |
| `onEvent`       | Handler for inbound webhook events. See [Webhooks](#webhooks).           |

**Token permissions** (fine-grained PAT): `Metadata: read` and `Issues: read & write` for
repository and issue APIs. Labels, assignees, milestones, timelines, sub-issues and dependencies
need `Issues: read`; creating, updating or deleting labels needs `Issues: write`. Pull requests
need `Pull requests: read`, or `Pull requests: read & write` to merge, review or comment on one. Branches and commits
need `Contents: read`, or `Contents: read & write` to create or delete a branch. Check runs and
commit statuses need `Checks: read`. Releases need `Contents: read`, or `Contents: read & write`
to create, update or delete them and their assets. GitHub Actions need `Actions: read`, or
`Actions: read & write` to re-run or cancel runs. Organization people APIs require
`Members: read`. Public user profiles and public organization membership can be queried without
that organization permission, but private membership visibility depends on the authenticated
user's organization access.

## Sandbox access

`@sixb/connector-github/sandbox` provides two `auth` helpers for sandbox factories (see [repository authentication](../../docs/sandboxes/overview.md#repository-authentication)):

- `githubApp({ appId, privateKey })`: mints repository-scoped App installation tokens and attributes commits to the App's bot account.
- `githubOAuth({ connector, slot?, owner?, fallback? })`: mints repository-scoped user tokens from the requester's GitHub App OAuth connection, with the connector's own client ID and secret, and attributes commits and pull requests to that user. With write access it can also attach files to issues and pull requests, which GitHub refuses an App installation token for.

```ts
import { githubApp, githubOAuth } from "@sixb/connector-github/sandbox"
import { githubConnector } from "./connectors/github"

const auth = githubOAuth({
  connector: githubConnector,
  // Optional: used only when no user requested the run (such as a scheduled workflow step)
  fallback: githubApp({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
  }),
})
```

Set up the GitHub App once:

1. Create a GitHub App (Settings → Developer settings → GitHub Apps). It needs no webhook. Grant
   the repository permissions Contents: Read and write, Pull requests: Read and write, and
   Metadata: Read. Read-only access (the default `source.access`) needs only Contents: Read.
2. Install the App on the repository the sandbox clones.
3. Note the App ID shown on the App's settings page.
4. Generate a private key and put the PEM file's contents in an environment variable, such as
   `GITHUB_APP_PRIVATE_KEY`. Newlines escaped as `\n` are accepted.

With `source.access: "write"`, the agent can use `git` and GitHub API clients such as `gh` for
that repository, for example to push and open pull requests. Each run receives a repository-scoped installation token,
injected outside the VM only into Git fetch/push requests and, with write access, GitHub API
requests and attachment uploads. The sandbox gets a placeholder in `GH_TOKEN` and `GITHUB_TOKEN`
and the Git identity of the App's bot, so commits are attributed to it. SSH, Git LFS and
cross-repository submodule credentials are not provided. Private keys remain host-side; the App
does not replace your application's access checks.

If the installation lacks a permission the workspace needs, the run fails: the cause of the error
reported to `onError` names the permissions to grant.

Write access lets the agent push to any branch of that repository and, through the API, merge pull
requests or delete branches. Protect the default branch with branch protection or rulesets, for
example by requiring a reviewed pull request, so that the agent's work reaches it only through
review.

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
| `gh.repo({ owner, repo }).branches.list()` | `GET /repos/{owner}/{repo}/branches`        |
| `gh.repo({ owner, repo }).branches.get(branch)` | `GET /repos/{owner}/{repo}/branches/{branch}` |
| `gh.repo({ owner, repo }).branches.create({ name, from })` | `POST /repos/{owner}/{repo}/git/refs` |
| `gh.repo({ owner, repo }).branches.delete(branch)` | `DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}` |
| `gh.repo({ owner, repo }).pulls.list()` | `GET /repos/{owner}/{repo}/pulls`             |
| `gh.repo({ owner, repo }).pulls.create()` | `POST /repos/{owner}/{repo}/pulls`         |
| `gh.repo({ owner, repo }).pulls.requestReviewers(number)` | `POST /repos/{owner}/{repo}/pulls/{number}/requested_reviewers` |
| `gh.repo({ owner, repo }).pulls.get(number)` | `GET /repos/{owner}/{repo}/pulls/{number}` |
| `gh.repo({ owner, repo }).pulls.files(number)` | `GET /repos/{owner}/{repo}/pulls/{number}/files` |
| `gh.repo({ owner, repo }).pulls.commits(number)` | `GET /repos/{owner}/{repo}/pulls/{number}/commits` |
| `gh.repo({ owner, repo }).pulls.merge(number)` | `PUT /repos/{owner}/{repo}/pulls/{number}/merge` |
| `gh.repo({ owner, repo }).pulls.reviews.list(number)` | `GET /repos/{owner}/{repo}/pulls/{number}/reviews` |
| `gh.repo({ owner, repo }).pulls.reviews.create(number)` | `POST /repos/{owner}/{repo}/pulls/{number}/reviews` |
| `gh.repo({ owner, repo }).pulls.comments.list(number)` | `GET /repos/{owner}/{repo}/pulls/{number}/comments` |
| `gh.repo({ owner, repo }).pulls.comments.create(number)` | `POST /repos/{owner}/{repo}/pulls/{number}/comments` |
| `gh.repo({ owner, repo }).pulls.comments.reply(commentId)` | `POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/replies` |
| `gh.repo({ owner, repo }).checks.list(ref)` | `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` |
| `gh.repo({ owner, repo }).checks.status(ref)` | `GET /repos/{owner}/{repo}/commits/{ref}/status` |
| `gh.repo({ owner, repo }).stacks.list()` | `GET /repos/{owner}/{repo}/stacks`            |
| `gh.repo({ owner, repo }).stacks.get(number)` | `GET /repos/{owner}/{repo}/stacks/{number}` |
| `gh.repo({ owner, repo }).commits.list()` | `GET /repos/{owner}/{repo}/commits`         |
| `gh.repo({ owner, repo }).commits.get(ref)` | `GET /repos/{owner}/{repo}/commits/{ref}` |
| `gh.repo({ owner, repo }).issues.list()` | `GET /repos/{owner}/{repo}/issues`            |
| `gh.repo({ owner, repo }).issues.get()`  | `GET /repos/{owner}/{repo}/issues/{number}`   |
| `gh.repo({ owner, repo }).issues.create()` | `POST /repos/{owner}/{repo}/issues`         |
| `gh.repo({ owner, repo }).issues.update()` | `PATCH /repos/{owner}/{repo}/issues/{number}` |
| `gh.repo({ owner, repo }).issues.comments.list()` | `GET /repos/{owner}/{repo}/issues/{number}/comments` |
| `gh.repo({ owner, repo }).issues.comments.create()` | `POST /repos/{owner}/{repo}/issues/{number}/comments` |
| `gh.repo({ owner, repo }).issues.comments.get()` | `GET /repos/{owner}/{repo}/issues/comments/{id}` |
| `gh.repo({ owner, repo }).issues.comments.update()` | `PATCH /repos/{owner}/{repo}/issues/comments/{id}` |
| `gh.repo({ owner, repo }).issues.comments.delete()` | `DELETE /repos/{owner}/{repo}/issues/comments/{id}` |
| `gh.repo({ owner, repo }).issues.comments.listForRepository()` | `GET /repos/{owner}/{repo}/issues/comments` |
| `gh.repo({ owner, repo }).issues.timeline(number)` | `GET /repos/{owner}/{repo}/issues/{number}/timeline` |
| `gh.repo({ owner, repo }).issues.parent(number)` | `GET /repos/{owner}/{repo}/issues/{number}/parent` |
| `gh.repo({ owner, repo }).issues.subIssues.list(number)` | `GET /repos/{owner}/{repo}/issues/{number}/sub_issues` |
| `gh.repo({ owner, repo }).issues.dependencies.blockedBy(number)` | `GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by` |
| `gh.repo({ owner, repo }).issues.dependencies.blocking(number)` | `GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocking` |
| `gh.repo({ owner, repo }).labels.list()` | `GET /repos/{owner}/{repo}/labels` |
| `gh.repo({ owner, repo }).labels.get(name)` | `GET /repos/{owner}/{repo}/labels/{name}` |
| `gh.repo({ owner, repo }).labels.create()` | `POST /repos/{owner}/{repo}/labels` |
| `gh.repo({ owner, repo }).labels.update(name)` | `PATCH /repos/{owner}/{repo}/labels/{name}` |
| `gh.repo({ owner, repo }).labels.delete(name)` | `DELETE /repos/{owner}/{repo}/labels/{name}` |
| `gh.repo({ owner, repo }).assignees.list()` | `GET /repos/{owner}/{repo}/assignees` |
| `gh.repo({ owner, repo }).assignees.check(username)` | `GET /repos/{owner}/{repo}/assignees/{username}` |
| `gh.repo({ owner, repo }).milestones.list()` | `GET /repos/{owner}/{repo}/milestones` |
| `gh.repo({ owner, repo }).milestones.get(number)` | `GET /repos/{owner}/{repo}/milestones/{number}` |
| `gh.attachments.find({ body, body_html })` | No request: reads the links in a body      |
| `gh.attachments.download(attachment)`    | `GET` the attachment's link, without the token |
| `gh.repo({ owner, repo }).releases.list()` | `GET /repos/{owner}/{repo}/releases`        |
| `gh.repo({ owner, repo }).releases.get(id)` | `GET /repos/{owner}/{repo}/releases/{id}`  |
| `gh.repo({ owner, repo }).releases.getLatest()` | `GET /repos/{owner}/{repo}/releases/latest` |
| `gh.repo({ owner, repo }).releases.getByTag(tag)` | `GET /repos/{owner}/{repo}/releases/tags/{tag}` |
| `gh.repo({ owner, repo }).releases.create()` | `POST /repos/{owner}/{repo}/releases`    |
| `gh.repo({ owner, repo }).releases.update(id)` | `PATCH /repos/{owner}/{repo}/releases/{id}` |
| `gh.repo({ owner, repo }).releases.delete(id)` | `DELETE /repos/{owner}/{repo}/releases/{id}` |
| `gh.repo({ owner, repo }).releases.generateNotes()` | `POST /repos/{owner}/{repo}/releases/generate-notes` |
| `gh.repo({ owner, repo }).releases.assets.list(releaseId)` | `GET /repos/{owner}/{repo}/releases/{id}/assets` |
| `gh.repo({ owner, repo }).releases.assets.get(id)` | `GET /repos/{owner}/{repo}/releases/assets/{id}` |
| `gh.repo({ owner, repo }).releases.assets.upload(release)` | `POST {release.upload_url}` |
| `gh.repo({ owner, repo }).releases.assets.update(id)` | `PATCH /repos/{owner}/{repo}/releases/assets/{id}` |
| `gh.repo({ owner, repo }).releases.assets.delete(id)` | `DELETE /repos/{owner}/{repo}/releases/assets/{id}` |
| `gh.repo({ owner, repo }).releases.assets.download(id)` | `GET /repos/{owner}/{repo}/releases/assets/{id}` (`application/octet-stream`) |
| `gh.repo({ owner, repo }).releases.reactions.list(releaseId)` | `GET /repos/{owner}/{repo}/releases/{id}/reactions` |
| `gh.repo({ owner, repo }).releases.reactions.create(releaseId)` | `POST /repos/{owner}/{repo}/releases/{id}/reactions` |
| `gh.repo({ owner, repo }).releases.reactions.delete(releaseId, id)` | `DELETE /repos/{owner}/{repo}/releases/{id}/reactions/{reaction_id}` |
| `gh.repo({ owner, repo }).actions.workflows.list()` | `GET /repos/{owner}/{repo}/actions/workflows` |
| `gh.repo({ owner, repo }).actions.workflows.get(idOrFile)` | `GET /repos/{owner}/{repo}/actions/workflows/{id}` |
| `gh.repo({ owner, repo }).actions.workflows.dispatch(idOrFile)` | `POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches` |
| `gh.repo({ owner, repo }).actions.runs.list()` | `GET /repos/{owner}/{repo}/actions/runs`, or `…/workflows/{id}/runs` with `workflow` |
| `gh.repo({ owner, repo }).actions.runs.get(runId)` | `GET /repos/{owner}/{repo}/actions/runs/{id}`, or `…/attempts/{n}` |
| `gh.repo({ owner, repo }).actions.runs.jobs(runId)` | `GET /repos/{owner}/{repo}/actions/runs/{id}/jobs` |
| `gh.repo({ owner, repo }).actions.runs.artifacts(runId)` | `GET /repos/{owner}/{repo}/actions/runs/{id}/artifacts` |
| `gh.repo({ owner, repo }).actions.runs.logs(runId)` | `GET /repos/{owner}/{repo}/actions/runs/{id}/logs` |
| `gh.repo({ owner, repo }).actions.runs.rerun(runId)` | `POST /repos/{owner}/{repo}/actions/runs/{id}/rerun`, or `…/rerun-failed-jobs` |
| `gh.repo({ owner, repo }).actions.runs.cancel(runId)` | `POST /repos/{owner}/{repo}/actions/runs/{id}/cancel` |
| `gh.repo({ owner, repo }).actions.jobs.get(jobId)` | `GET /repos/{owner}/{repo}/actions/jobs/{id}` |
| `gh.repo({ owner, repo }).actions.jobs.logs(jobId)` | `GET /repos/{owner}/{repo}/actions/jobs/{id}/logs` |
| `gh.repo({ owner, repo }).actions.artifacts.download(id)` | `GET /repos/{owner}/{repo}/actions/artifacts/{id}/zip` |
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
const protectedBranches = await repo.branches.list({ protected: true, pageSize: 100, signal })
const branch = await repo.branches.get("feature/login")

const issue = await repo.issues.create({ title: "Bug", labels: ["triage"] })
const comment = await repo.issues.comments.create(issue.number, { body: "Investigating." })
await repo.issues.comments.update(comment.id, { body: "Fixed." })
await repo.issues.comments.delete(comment.id)
await repo.issues.update(issue.number, { body: "Updated", state: "closed" })

const releases = await repo.releases.list({ pageSize: 50, signal })
const release = await repo.releases.create({
  tagName: "v1.2.0",
  draft: true,
  generateReleaseNotes: true,
})
await repo.releases.assets.upload(release, { name: "app.zip", data: await Bun.file("app.zip").bytes() })
await repo.releases.update(release.id, { draft: false })
await repo.releases.reactions.create(release.id, { content: "rocket" })

const file = await repo.releases.assets.download(release.assets[0]!.id)
await Bun.write("app.zip", file)
```

### Attachments

GitHub has no API for the images, videos and files attached to issues, pull requests and comments:
they are links in the Markdown body. `gh.attachments.find()` reads them from a body and returns each
once, in order, with its `id` (the asset's UUID, or the file's id), its `kind` (`media` for images
and videos, `file` for other files) and, for files, its `name`. `download()` returns a streaming
`Response`; the response's `content-type` tells an image from a video.

In a private repository the Markdown's links only open in a signed-in browser. Request the body with
`bodyFormat: "full"` and pass `body_html` too: GitHub renders images and videos there as links
signed for a few minutes, which `download()` uses. Download them right after reading the body.
Files other than images and videos have no signed link, so they download only from public
repositories.

```ts
const issue = await repo.issues.get(42, { bodyFormat: "full" })

for (const attachment of gh.attachments.find(issue)) {
  const response = await gh.attachments.download(attachment, { signal })
  await Bun.write(`attachments/${attachment.name ?? attachment.id}`, response)
}
```

`bodyFormat` is accepted by `issues.get()`, every issue list, `issues.comments.get()` and
`issues.comments.list()`: `raw` (the default) returns the Markdown in `body`, `text` returns only
`body_text`, `html` returns only `body_html`, and `full` returns all three. Only `raw` and `full`
include `body`, so code that reads `body` should ask for one of them. These calls also accept a
`signal`.

`download()` refuses links outside GitHub's attachment hosts, never sends the token, and throws when
GitHub answers with a web page instead of the file, as a private repository's plain link does.
With a GitHub Enterprise Cloud base URL (`api.<name>.ghe.com`) attachments are found on
`<name>.ghe.com`; with an Enterprise Server base URL, only on that server's host and port.

Branch calls accept a `signal` to abort the request. `branches.list()` returns every
branch unless `protected` is set: `true` keeps only branches protected by branch protection
or rulesets, `false` only the others. Each item carries the branch `name`, the tip
`commit.sha` and `protected`. `branches.get()` accepts names containing `/` and adds
`_links.html`, the branch's web page.

`branches.create({ name, from })` creates a branch at the commit `from` names, which may be a
branch, a tag or a SHA. GitHub creates a ref from a commit SHA, so the client resolves `from` to
one first and the call costs two requests. `branches.delete(name)` removes a branch; GitHub
refuses the default branch. A name containing `/` is sent as its own path segments, so the slash
stays a slash. Both refuse a name Git would before requesting it: a full ref, whitespace, `..`,
`@{`, a leading `/` or `-`, a trailing `/` or `.lock`, or any of `~ ^ : ? * [ \ |`.

Pull request calls accept a `signal` to abort the request. `pulls.list()` returns open pull
requests unless `state` is `closed` or `all`; filter by `head` (`owner:branch`) or `base`, and
sort by `created`, `updated`, `popularity` or `long-running`. A merged pull request is `closed`
with `merged_at` set. `pulls.get()` adds `merged`, `mergeable` (`null` while GitHub computes it),
`merged_by`, comment and commit counts, and line and file counts. `mergeable_state` is GitHub's own
verdict: `clean`, `dirty` for a conflict, `blocked` by a rule, `behind` its base, `unstable` with a
failing check, `draft`, or `unknown` while it computes. `requested_reviewers` names the people asked
to review and `requested_teams` the teams. `pulls.reviews.list()` returns
each review with its `state`: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or
`PENDING`. `pulls.list()` and `pulls.get()` accept `bodyFormat`, so `attachments.find()` reads
pull request bodies too.

**Reviewing.** `pulls.reviews.create(number, { event })` submits a review: `APPROVE`,
`REQUEST_CHANGES` or `COMMENT`. GitHub requires a summary for the last two, and refuses an `event`
it does not know, so the client refuses both before requesting. `commitId` reviews one commit, and
`comments` posts inline comments as part of the same review, which is how a reviewer leaves several
line comments with one verdict. `DISMISSED` and `PENDING` are states GitHub reports, not events it
accepts.

```ts
await repo.pulls.reviews.create(1086, {
  event: "REQUEST_CHANGES",
  body: "One fix before this goes in.",
  comments: [{ path: "src/login.ts", line: 42, side: "RIGHT", body: "This drops the error." }],
})
```

**Inline comments.** `pulls.comments.list(number)` returns the comments on the diff, with the
`path` and `line` each is on and the `side` that line counts on (`RIGHT` for the file as changed,
`LEFT` for it as it was), `start_line` when it spans a range, the `diff_hunk` it quotes, the
`commit_id` it was left on, `in_reply_to_id` for a thread's answers and `pull_request_review_id` for
the review it was posted with. `position` and `original_position` count the line in the diff as it
was left, which is how an outdated comment keeps its place after a push. `since` narrows the list to
what changed, `sort` and `direction` order it, and `bodyFormat` asks for the body as GitHub rendered
it. `pulls.comments.create(number, { path, body })` comments on a line outside a review, and
needs `line` with an optional `side` (`RIGHT`, the file as changed, by default) or `position`, a
line counted in the diff. `pulls.comments.reply(commentId, { body })` answers a comment in its
thread.

**Reading the diff.** `pulls.files(number)` returns the files the pull request changes, each with
its `status` (`added`, `removed`, `modified`, `renamed`, `copied`, `changed` or `unchanged`), its
`additions`, `deletions` and `changes`, the `previous_filename` of a rename, and `patch`: the
unified diff with its hunk headers, which is what a review reads. GitHub leaves `patch` out when it
will not render one, as it does for a binary file, so read the file itself then. One response holds
3000 files at most, 30 a page unless `pageSize` says otherwise. `pulls.commits(number)` lists the
commits on its branch, oldest first.

```ts
const files = await repo.pulls.files(1086, { pageSize: 100 })
const changed = files.items.filter((file) => file.status !== "unchanged")
```

**Opening one.** `pulls.create({ title, head, base })` opens a pull request from `head` into
`base`, with `body`, `draft`, `maintainerCanModify` and `issue` to turn an issue into one.
`requestReviewers(number, { reviewers })` asks users to review, and `teamReviewers` asks teams by
slug; GitHub answers with the pull request.

**Merging.** `pulls.merge(number, { method })` merges with `merge` (the default), `squash` or
`rebase`, and takes `commitTitle`, `commitMessage` and `sha`, the last of which merges only while
the head branch is still at that commit. GitHub's refusals are answers rather than failures, so
they come back as a result and only a status GitHub does not document for a merge throws:

| Status | `reason`         | Means                                                              |
| ------ | ---------------- | ------------------------------------------------------------------ |
| 405    | `not_mergeable`  | a required review or check is missing, or the branches conflict     |
| 409    | `head_changed`   | the head branch moved since it was read                             |
| 403    | `forbidden`      | a branch protection rule or ruleset, or a token without write access |
| 404    | `not_found`      | no such pull request, or the token cannot see it                    |
| 422    | `invalid`        | GitHub refused the input, such as a merge method the repository forbids |

```ts
const merge = await repo.pulls.merge(1086, { method: "squash" })
if (merge.merged) console.log("merged as", merge.sha)
else if (merge.reason === "not_mergeable") console.log("waiting:", merge.message)
```

**Checks.** `checks.list(ref)` returns a commit's check runs, which is where a workflow's jobs
appear, with `checkName`, `status` (`queued`, `in_progress`, `completed`) and `filter` (`latest`
for the newest run of each name, `all` for every attempt) narrowing them. Each run names its
`status`, its `conclusion` once complete, its `output`, the `app` that ran it and the pull requests
it belongs to. `checks.status(ref)` returns the older Commit Status API's rollup: its `state` is
`failure` when any context reports an error or a failure, `pending` when one is pending or none was
ever posted, and `success` when all are. `ref` is a commit SHA, a branch or a tag, and names
containing `/` work.

```ts
const { items: runs } = await repo.checks.list("feature/login")
const failing = runs.filter((run) => run.conclusion === "failure").map((run) => run.name)
const status = await repo.checks.status("feature/login")
```

### Actions

Workflow runs, their jobs and steps, logs and artifacts. Each run names the branch and commit it ran
on, and the pull requests GitHub matched it to: link it to your own objects from those.

```ts
const actions = gh.repo({ owner: "acme", repo: "web" }).actions

// Backfill a week of CI runs, page by page.
let pageToken: string | undefined
do {
  const page = await actions.runs.list({ workflow: "ci.yml", created: ">=2026-11-08", pageToken })
  for (const run of page.items) {
    // `pull_requests` is empty for a run from a fork: match it by head_branch or head_sha.
    console.log(run.id, run.status, run.conclusion, run.head_branch, run.head_sha, run.pull_requests)
  }
  pageToken = page.nextPageToken
} while (pageToken)

const { items: jobs } = await actions.runs.jobs(runId, { filter: "latest" })
const log = await (await actions.jobs.logs(jobs[0].id)).text()
await actions.runs.rerun(runId, { failedOnly: true })
```

Lists come back as pages like every other list, though GitHub wraps Actions lists in an object.
`workflows.dispatch(workflow, { ref })` starts a manual run on `ref`, a branch or tag, with the
`inputs` the workflow declares. GitHub takes every input value as a string, so the client refuses
anything else before requesting. GitHub answers with nothing, so read the run back from
`runs.list({ branch: ref, event: "workflow_dispatch" })`.

```ts
await actions.workflows.dispatch("deploy.yml", {
  ref: "main",
  inputs: { environment: "production" },
})
```

Logs and artifacts are downloads (`Response`): GitHub redirects them to storage signed for that one
download, which is fetched without the token. `runs.logs` is a zip of every job's log; `jobs.logs` is
one job's, as text. To follow runs as they happen, handle the `workflow_run` and `workflow_job`
webhook events (see [Webhooks](#webhooks)).

### Stacks

GitHub can group dependent pull requests into a stack: each targets the branch of the one below
it, and the bottom one targets the stack's base, such as `main`. A pull request in a stack carries
`stack` in `pulls.list()` and `pulls.get()`: the stack's `number` and `size`, the pull request's
`position` from 1 at the bottom to `size` at the top, and the stack's `base` branch. GitHub leaves
`stack` out for a pull request outside any stack.

```ts
const pull = await repo.pulls.get(1086)
if (pull.stack) {
  const { number, position, size, base } = pull.stack // e.g. 5 of 5 in stack 1085, into main
  const stack = await repo.stacks.get(number)
  const below = stack.pull_requests[position - 2] // undefined at the bottom
}
```

`stacks.list()` returns a repository's stacks, or with `pullRequest` the one holding that pull
request; each lists its pull requests from the bottom up with their `state`, `draft`, `merged_at`
and `head` branch. `stacks.get()` adds each pull request's `title`, `user`, `base` and links. A
stack's `number` comes from the same sequence as the repository's issues and pull requests, and
`open` turns `false` once none of its pull requests is open. Stack calls accept a `signal`.

Creating, extending and merging stacks are not covered yet: GitHub merges a stack only through its
asynchronous merge endpoint.

### Issue tracking

The calls below accept a `signal` to abort the request.

**Labels.** `labels.list()` returns a repository's labels with their `color` (six hex digits
without `#`) and `description`. `create()`, `update()` and `delete()` manage them; a color may be
given with or without a leading `#`, and anything else is refused before the request. `update()`
renames a label with `newName`, and issues keep it under the new name. Label names may contain
spaces and `/`.

**Assignees.** `assignees.list()` returns the users who can be assigned to the repository's issues
and pull requests, for an assignee picker; `assignees.check(username)` answers whether one can.
Assign with `issues.update(number, { assignees })`.

**Milestones.** `milestones.list()` returns open milestones by due date unless `state`, `sort`
(`due_on` or `completeness`) or `direction` say otherwise; each carries its open and closed issue
counts and `due_on`. `milestones.get(number)` returns one.

**Timeline.** `issues.timeline(number)` returns an issue's or pull request's history, oldest
first, as entries discriminated by `event`: comments, labels, assignees, milestones, renames,
closing and reopening, locks, review requests, sub-issues added or removed, commits and reviews on
a pull request, and `cross-referenced`, where `source.issue` is the issue or pull request (it
carries `pull_request`) that mentioned this one. Most entries name who did it in `actor` and when
in `created_at`; a commit's time is `author.date` and a review's is `submitted_at`, with its
`state` in lowercase. GitHub adds events over time, so treat an `event` you don't handle as
unknown. With `bodyFormat`, comment and review entries carry `body_html` and `body_text` too.

```ts
for (const entry of (await repo.issues.timeline(42, { pageSize: 100 })).items) {
  if (entry.event === "labeled") console.log(entry.actor?.login, "added", entry.label.name)
  if (entry.event === "cross-referenced") console.log("mentioned in", entry.source.issue.html_url)
}
```

**Sub-issues and dependencies.** An issue carries `sub_issues_summary` (`total`, `completed`,
`percent_completed`), `issue_dependencies_summary` (`blocked_by` and `blocking`, counting open
issues, with `total_blocked_by` and `total_blocking`) and, for a sub-issue, `parent_issue_url`.
`issues.subIssues.list(number)` returns its sub-issues, `issues.parent(number)` its parent or
`null`, and `issues.dependencies.blockedBy(number)` and `.blocking(number)` the issues on either
side. GitHub answers a missing issue the same way as an issue without a parent, so on that answer
`parent()` checks the issue itself: `null` when it exists, `GitHubApiError` (404) when it doesn't
or the token can't see it.

**Comments across a repository.** `issues.comments.listForRepository()` returns the comments on
every issue and pull request in a repository, oldest first unless `sort` (`created` or `updated`)
and `direction` say otherwise. With `since`, only comments updated after that time, so a sync can
read just what changed. Each comment names its issue in `issue_url`, whose last path segment is the
issue number.

Commit calls accept a `signal` to abort the request. `commits.list()` returns newest first from
the default branch, or from `sha` (a branch or commit), and filters by `path`, `author`,
`committer`, `since` and `until`. Each item carries the Git `commit` (message, author and
committer as Git recorded them) and the matching GitHub accounts in `author` and `committer`,
which are `null` when no account has that email. `commits.get()` accepts a SHA, branch or tag,
names containing `/` included, and adds `stats` and the changed `files` with their patches.

Release calls accept a `signal` to abort the request. `releases.list()` returns
newest first and includes drafts only when the token can push to the repository;
`getByTag()` and `getLatest()` never return a draft (GitHub answers 404, thrown as
`GitHubApiError`), and `getLatest()` skips prereleases. `assets.upload()` posts to the
release's `upload_url` and refuses one outside the configured GitHub host, since the
token goes with it. `assets.download()` returns a streaming `Response`; when GitHub redirects
to its file storage, the redirect is followed without the token. Releases accept the
reactions `+1`, `laugh`, `heart`, `hooray`, `rocket` and `eyes`.

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

GitHub sends `pull_request` with the action `stacked` when a pull request is added to a stack,
with the stack in the payload. That action and the `stack` field are newer than the payload types
this package uses, so read them from the payload without relying on their types, or fetch the
pull request with `pulls.get()`.

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
- **Pull requests in issue lists.** GitHub's repository issues endpoint can return pull
  requests with a `pull_request` field; this connector returns them unchanged. Use
  `repo.pulls` for their branches, merge state and reviews.
