# Sandboxes

A sandbox is the environment where an agent reads files and runs commands. Configure one to use
the [built-in agent](../models/overview.md#built-in-agent) or an
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

Each agent run gets a fresh environment that is removed when the run ends. Files returned as
agent attachments are saved separately.

## Providers

Choose a provider for your environment. Each card opens the package README for installation,
setup, and configuration.

<div data-provider-library="sandboxes"></div>

Filesystem and network isolation depend on the provider. The local provider can run without
isolation when OS sandboxing is unavailable. Check the provider's requirements and isolation
behavior before using it in production.
