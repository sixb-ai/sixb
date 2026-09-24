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

For bound conversations, omitting `network` allows the Sixb API and source origin. Explicit policies
are never widened: also allow package registries if setup needs them. Guest-readable `env` is not
a safe place for credentials.

For direct factory use, `create()` applies static source/setup. An explicit `environment` replaces
both, including `{}` to skip them. Dynamic recipes require execution-resolved configuration.

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
