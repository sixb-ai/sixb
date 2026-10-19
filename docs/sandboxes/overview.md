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

## Providers

Choose a provider for your environment. Each card opens the package README for installation,
setup, and configuration.

<div data-provider-library="sandboxes"></div>

Filesystem and network isolation depend on the provider. The local provider can run without
isolation when OS sandboxing is unavailable. Check the provider's requirements and isolation
behavior before using it in production.

## Configure the environment

Use a persistence-capable provider such as Vercel for conversations that keep files between runs.
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

For bound conversations, Sixb always allows what the agent needs: the Sixb API, the source origin
and the origins `auth` issues credentials for. Omitting `network` allows only those. A
`restricted` policy lists what the project adds, such as the package registry `setup` installs
from; `all` allows everything. `none` is rejected: the agent cannot reach the Sixb API.
Guest-readable `env` is not a safe place for credentials.

For direct factory use, `create()` applies static source/setup. An explicit `environment` replaces
both, including `{}` to skip them. Dynamic recipes require execution-resolved configuration.

## Repository authentication

For private GitHub repositories, authenticate with a GitHub App:

1. Create a GitHub App (Settings → Developer settings → GitHub Apps); it needs no webhook. Grant
   the repository permissions Contents: Read and write, Pull requests: Read and write, and
   Metadata: Read. Read-only access needs only Contents: Read.
2. Install the App on the repository.
3. Note the App ID from the App's settings page.
4. Generate a private key and put its contents in an environment variable.

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

Write access lets the agent push to any branch of the repository and, through the API, merge pull
requests or delete branches. Protect the default branch with branch protection or rulesets, for
example by requiring a reviewed pull request, so that the agent's work reaches it only through
review.

Public repositories can omit `auth`. Managed credentials are not written into guest files: use
`git` and GitHub API clients such as `gh` normally. Commits are attributed to the App's bot
account. `GH_TOKEN` and `GITHUB_TOKEN` in the sandbox hold a placeholder, because these clients
require a token; the real token never enters the sandbox.
Sixb refreshes access for each run and revokes it during normal cleanup. A worker crash cannot
guarantee immediate revocation.

## Keep files across conversation runs

Opt in when creating a thread:

```ts
const thread = await sixb.agent.threads.create({
  title: "Improve the client portal",
  sandbox: { clientId: "acme", branch: "feature/portal" },
})
```

Use `sandbox: {}` for a static recipe; omit `sandbox` for a fresh environment per run.
Parameters are immutable, validated against the factory schema, and must not contain secrets.
Thread responses expose them as `sandboxParams`; `sandboxState` describes the current sandbox.

The first run prepares the environment; subsequent runs resume files and uncommitted edits.
Sixb saves before finalization. If the provider confirms saved state is lost, Sixb creates a fresh
sandbox, repeats setup and tells the agent its earlier local files were not recovered.
Conversation history and published attachments remain available.

Uncertain state or failed recovery blocks further runs. Use the chat recovery control or
`sixb.agent.threads.recreateSandbox(thread.id, { expectedSandboxName: thread.sandboxState.name })`.
Recreation does not recover edits or delete the previous environment.
Files remain subject to provider retention; workflows and subagents remain ephemeral.
