# Configuration

Add language-model bindings to `models.language` in your project configuration.

## Providers

```bash
bun add @sixb/vercel-ai-gateway
# or
bun add @sixb/anthropic
```

| Provider | Import | Default credential |
| --- | --- | --- |
| Vercel AI Gateway | `vercelGateway` from `@sixb/vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |
| Anthropic | `anthropic` from `@sixb/anthropic` | `ANTHROPIC_API_KEY` |

File: `lib/models.ts`

```ts
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const primaryModel = vercelGateway("openai/gpt-5.5")
export const alternateModel = vercelGateway("anthropic/claude-sonnet-4.6")
```

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { primaryModel, alternateModel } from "./lib/models"

export const sixb = createSixb({
  // ...your existing providers
  models: {
    language: [primaryModel, alternateModel],
  },
})
```

## Model selection

```ts
import { alternateModel } from "../lib/models"

// Uses the first configured model.
await sixb.models.language.generate({ prompt: "Summarize: ..." })

// Uses another configured binding.
await sixb.models.language.generate({
  model: alternateModel,
  prompt: "Summarize: ...",
})
```

| Configuration | Behavior |
| --- | --- |
| No override | Uses the first `models.language` binding |
| Override with a catalog | Resolves the configured provider/model identity; unknown pairs reject |
| Explicit model without a catalog | Accepted by direct generation |
| No catalog and no explicit model | Rejects before inference |
| Duplicate provider/model pair | Rejected during configuration |

Different providers can bind the same vendor model. Sixb does not automatically route calls between models.

## Custom credentials

Share a provider instance when models use the same credentials and transport settings.

File: `lib/models.ts`

```ts
import { createAnthropic } from "@sixb/anthropic"

const anthropic = createAnthropic({
  apiKey: () => process.env.SUPPORT_ANTHROPIC_KEY,
})

export const supportModel = anthropic("claude-sonnet-4-5", {
  maxOutputTokens: 8_192,
})
```

## Capabilities and output limits

| Setting | Behavior |
| --- | --- |
| Provider metadata | Supplies context limits, supported reasoning, and structured-output capabilities |
| Model `maxOutputTokens` | Caps output across calls using that binding |
| Call `maxOutputTokens` | Can lower the resolved model ceiling |
| Direct call with no known output limit | Uses 4,096 tokens |
| `reasoning` | Accepts a supported named level or `{ budgetTokens }` |

An output ceiling is a maximum, not a target response length. Unknown capabilities are checked by the provider.

See [Generation](./generation.md) for per-call controls and [Built-in Agent](./built-in-agent.md) for conversation limits.
