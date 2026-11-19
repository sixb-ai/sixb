# Sandboxes

A sandbox is the environment where an agent reads files and runs commands. Configure one to use
the [built-in agent](../models/overview.md#how-the-agent-works) or an
[AI workflow step](../workflows/overview.md#add-an-ai-task).

## Configure a sandbox

Install a provider and pass its factory as `sandboxes` in your existing project configuration.
For local development:

```bash
bun add @sixb/sandboxes-local
```

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"

export const sixb = createSixb({
  // ...your existing providers and models
  sandboxes: new LocalSandboxFactory(),
})
```

By default, each agent run gets a fresh environment that is removed when the run ends. Opt in to
[conversation continuity](#keep-files-across-conversation-runs) to retain files between runs.
Files returned as agent attachments are saved separately.

Each command the agent runs has 2 minutes, and up to 10 when the agent expects a longer build or
test suite. A command that times out or is stopped ends with everything it started. Background
commands run up to the provider's limit: five hours on Vercel.

On Vercel, a sandbox extends its session while the agent uses it, up to your plan's maximum, so
`sessionTimeoutMs` can stay short. If the session ends anyway, the run stops with "The sandbox
stopped" and keeps its work. A conversation goes on with a new message; one that keeps its files
waits for its owner to [resume or start fresh](#keep-files-across-conversation-runs).

A command the provider refuses to start is a tool error: the agent reads why and goes on.

## Providers

Choose a provider for your environment. Each card opens the package README for installation,
setup, and configuration.

<div data-provider-library="sandboxes"></div>

Filesystem and network isolation depend on the provider. The local provider can run without
isolation when OS sandboxing is unavailable. Check the provider's requirements and isolation
behavior before using it in production.

Every provider here adds the agent's credentials where its commands can't read them: they reach
the Sixb API as the run without ever holding its token. Vercel and the local provider keep the token
outside the sandbox. smolvm, Apple Container, Azure and boxd keep it inside the VM, in a file only
root reads, while the agent's commands run as an unprivileged user. A custom provider must keep it
out of the commands' reach too, by setting `supportsRequestCredentials`; `createSixb` fails at
startup otherwise.

## Configure the environment

Use a persistence-capable provider such as Vercel or boxd for conversations that keep files between
runs.
A static recipe takes `source` and optional `setup`; use `params` and `resolve` for a per-thread recipe:

```ts
import { param } from "@sixb/core"
import { VercelSandboxFactory } from "@sixb/sandboxes-vercel"
import { Client } from "./ontology/client"

// Pass this factory as the sandboxes option to createSixb.
const sandboxes = new VercelSandboxFactory({
  params: { clientId: param("string"), branch: param("string") },
  resolve: async ({ params, sixb }) => {
    const client = await sixb.objects(Client).get(params.clientId)
    const repositoryUrl = client?.properties.repositoryUrl
    if (typeof repositoryUrl !== "string" || !repositoryUrl.trim()) {
      throw new Error("Client repository is unavailable.")
    }
    return {
      source: { type: "git", url: repositoryUrl, revision: params.branch },
    }
  },
})
```

`resolve` runs with current execution permissions on every run, including resume. `source` accepts
credential-free HTTPS Git URLs; omit it for a source-free environment. `setup` commands run only
when creating a fresh sandbox. The repository and initial revision cannot change on resume.

An AI workflow step can apply a static recipe too: pass a factory as its `sandbox` to get a fresh
checkout on every run, destroyed when the run ends. See
[Work in a repository](../workflows/overview.md#work-in-a-repository).

For bound conversations and steps with their own `sandbox`, Sixb always allows what the agent
needs: the Sixb API, the source origin and the origins `auth` issues credentials for. Omitting
`network` allows those and the CDNs an artifact may load its scripts and fonts from
(`cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com`, `fonts.googleapis.com`,
`fonts.gstatic.com`), so the agent checks a deck or a video as the app shows it; a sandbox without
a recipe gets the same. A `restricted` policy lists what the project adds, such as the package
registry `setup` installs from, and leaves the CDNs out unless it lists them; `all` allows
everything. `none` is rejected: the agent
cannot reach the Sixb API. Guest-readable `env` is not a safe place for credentials.

The agent's [`web_fetch`](../models/overview.md#read-web-pages) follows the declared `network`
too: a `restricted` one limits it to the origins it lists. Without `network`, it reads any URL.

For direct factory use, `create()` applies static source/setup. An explicit `environment` replaces
both, including `{}` to skip them. Dynamic recipes require execution-resolved configuration.

## Repository authentication

For private GitHub repositories, authenticate with a GitHub App:

1. Create a GitHub App (Settings → Developer settings → GitHub Apps); it needs no webhook. Grant
   the repository permissions Contents: Read and write, Pull requests: Read and write, and
   Metadata: Read. Read-only access needs only Contents: Read.
2. Install the App on the repository.
3. Note the App ID from the App's settings page.
4. Generate a private key and put its contents in an environment variable. Newlines escaped as
   `\n` are accepted.

Then configure host-side authentication on the Vercel factory:

```ts
import { githubApp } from "@sixb/connector-github/sandbox"
import { VercelSandboxFactory } from "@sixb/sandboxes-vercel"

const factory = new VercelSandboxFactory({
  source: { type: "git", url: "https://github.com/acme/app.git" },
  auth: githubApp({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
  }),
})
```

Access defaults to read; set `source.access: "write"` to also push and use the GitHub API for that
repository, for example to open pull requests. A missing permission fails the run: the cause of
the error reported to [`onError`](../logging/overview.md#report-failures) names the permissions to
grant.

```bash
git push -u origin HEAD && gh pr create --fill
```

In a conversation, the agent commits and pushes when the user asks, or when the project's
[`SIXB.md`](../models/overview.md#give-it-project-instructions) says how changes are published,
such as on a branch with a pull request.

Write access lets the agent push to any branch of the repository and, through the API, merge pull
requests or delete branches. Protect the default branch with branch protection or rulesets, for
example by requiring a reviewed pull request, so that the agent's work reaches it only through
review.

Public repositories can omit `auth`. Managed credentials are not written into guest files: use
`git` and GitHub API clients such as `gh` normally. Commits are attributed to the App's bot
account. `GH_TOKEN` and `GITHUB_TOKEN` in the sandbox hold a placeholder, because these clients
require a token; the real token never enters the sandbox.
Write access needs `auth`. `createSixb` fails at startup when a factory's static `source` asks
for write access without it. A source returned by `resolve` is checked the same way when each run
starts.
Sixb refreshes access for each run and revokes it during normal cleanup. A worker crash cannot
guarantee immediate revocation.

### Commit and push as the connected user

To attribute commits, pushes, and pull requests to the member running the conversation instead of
the App's bot account, register a personal GitHub OAuth connector with your GitHub App's client ID
and secret (see [Let people connect their own accounts](../connectors/authentication.md#let-people-connect-their-own-accounts))
and pass `githubOAuth` as `auth`:

```ts
import { githubApp, githubOAuth } from "@sixb/connector-github/sandbox"
import { VercelSandboxFactory } from "@sixb/sandboxes-vercel"
import { githubConnector } from "./connectors/github"

const factory = new VercelSandboxFactory({
  auth: githubOAuth({
    connector: githubConnector,
    // Optional: used only for automated runs not started by a user
    fallback: githubApp({
      appId: process.env.GITHUB_APP_ID!,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
    }),
  }),
  // ...static source or params + resolve
})
```

Each run narrows the user's OAuth token to that single repository and requested `read` or `write`
permissions, sets their Git author and committer identity, and revokes only the scoped token when
the run ends.

Write access also lets the agent attach files to issues and pull requests: uploads to
`uploads.github.com` carry the same scoped token, so a screenshot taken in the sandbox lands in a
pull request description as the person who asked. GitHub refuses an App installation token on that
endpoint, so attaching files needs the OAuth connection.

## Keep files across conversation runs

Opt in when creating a thread:

```ts
const thread = await sixb.agent.threads.create({
  title: "Improve the client portal",
  sandbox: { clientId: "acme", branch: "feature/portal" },
})
```

Use `sandbox: {}` for a static recipe; omit `sandbox` for a fresh environment per run.
From a chat, pass the params as `newThreadSandbox` to `AgentPanel`; see
[Start a conversation in a sandbox](../models/overview.md#start-a-conversation-in-a-sandbox).
Parameters are immutable, validated against the factory schema, and must not contain secrets.
Thread responses expose them as `sandboxParams`; `sandboxState` describes the current sandbox.
A [continued conversation](../models/overview.md#continue-a-conversation) keeps the parameters
and starts with a fresh sandbox.

The first run prepares the environment; subsequent runs resume files and uncommitted edits.
Sixb saves before finalization. If the provider confirms saved state is lost, Sixb creates a fresh
sandbox, repeats setup and tells the agent its earlier local files were not recovered.
Conversation history and published attachments remain available.

Uncertain state or failed recovery blocks further runs, such as a save that fails because the
provider stopped the VM at the end of its session, or a command whose request got no answer. The
run keeps its answer, with a `workspace_not_saved` diagnostic. The thread's owner chooses how to go
on, from the chat recovery control or the SDK:

| Choice | Call | Files |
|---|---|---|
| Resume the previous sandbox | `sixb.agent.threads.restoreSandbox(thread.id, { expectedSandboxName })` | As the last run left them; its last change may be unfinished |
| Start fresh | `sixb.agent.threads.recreateSandbox(thread.id, { expectedSandboxName })` | A new environment; earlier edits are not copied |

`expectedSandboxName` is `thread.sandboxState.name`. Resuming is offered only for a sandbox its run
finished preparing (`sandboxState.initialized`). The next run resumes it; if the provider no longer
has its files, the run starts fresh and tells the agent. A provider never resumes a VM that still
runs, so a resumed sandbox cannot receive a late operation from the failed run. Neither choice
deletes the previous environment: its files remain subject to provider retention. Workflows remain
ephemeral.

A conversation's [sub-agents](../models/overview.md#it-delegates) work in its sandbox, on the same
files. A sub-agent of a conversation without one gets a blank sandbox of its own: on a provider that
keeps files, such as Vercel, it keeps that sandbox while it pauses, and Sixb deletes it once the
sub-agent ends. The sandbox of a paused sub-agent that never continues is left to provider
retention.
