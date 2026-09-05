# Configure the Agent

Sixb provides one conversational Agent. Configure its capabilities on the project, not a separate
agent definition.

## The project model catalog

```ts
import { createSixb } from "@sixb/core"
import { gateway } from "ai"
import { searchKnowledge } from "./ai/tools"

export const sixb = createSixb({
  // ...storage, broker, queues, sandboxes
  models: {
    language: [gateway("openai/gpt-5.5"), gateway("anthropic/claude-sonnet-4.6")],
  },
  tools: [searchKnowledge],
})
```

| Configuration | Behavior |
| --- | --- |
| `models.language` | AI SDK model instances the Agent and its children may use. The first is the default. |
| `tools` | Reusable `defineAgentTool` definitions available to the Agent and its children. |
| `sandboxes` | Sandbox factory used for isolated file and CLI access on each run. |
| `skills/` | Project instructions, procedures, and references loaded when relevant. |

The model's `{ provider, modelId }` pair identifies its binding; no additional id is needed. Two
bindings for the same vendor model may coexist (for example Gateway and a direct provider), but
duplicate pairs are rejected.

The composer lets users choose the model and reasoning for each turn. Without a selection, Sixb
uses the first language model and the provider's default reasoning. It does not automatically route
simple messages to a smaller model.

## Instructions and tools

Sixb owns the conversational baseline prompt and sandbox guidance. Put domain-specific procedures
in Agent Skills, for example `skills/invoice-review/SKILL.md`. Only skill names and descriptions are
advertised up front; the Agent reads the full instructions when needed.

Omitting `tools` removes project-defined tools, not the framework's sandbox tools or authorized Sixb
CLI. Permissions still control access to project data. See [Tools and gateway](./tools-and-gateway.md)
and [Authorization](./authorization.md).

Workflow tasks use `defineAgentStep` with their own prompt, optional model, selected tools, and
execution groups. They are not additional chat agents. See [Agent steps](../workflows/overview.md).

## Conversation limits

The worker defaults to 25 model steps per turn and a 10-minute timeout. At the step limit, it asks
for a final answer without further tools; a later user message starts a new turn. Gateway prompt
caching is enabled automatically.

Long conversations are compacted using the selected model's limits from the worker's embedded
Models.dev snapshot. Unknown models use a 128,000-token fallback with a warning. The full transcript
is preserved; only model input becomes a summary plus recent turns.

## Upgrading from defined agents

- Replace `defineAgent` and `createSixb({ agents })` with project `models` and `tools`.
- Move reusable instructions into `skills/`; `agents/` is no longer discovered.
- Use `sixb.agent` and `GET /api/agent`.
- Existing conversation history is preserved without its former Agent identity.

## Related

- [Running and streaming](./running-and-streaming.md)
- [Tools and gateway](./tools-and-gateway.md)
- [Authorization](./authorization.md)
