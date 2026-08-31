# @sixb/llm

Sixb's provider-neutral language model contract and owned inference loop.

The package normalizes model streams, executes local tools, emits live events, preserves provider
replay state, validates structured output, and reports every completed model call through an
awaited lifecycle hook. Provider transports live in separate packages.

## Design boundary

- `LanguageModel` is the only provider contract. A model receives canonical messages, tool JSON
  schemas, reasoning intent, an optional structured-output schema, and an abort signal.
- `runModelLoop` owns step limits, stream assembly, tool execution, replay, cancellation, and final
  output validation.
- Provider-specific configuration belongs to the model instance, not the agent definition.
- `provider-state` parts preserve ordered, JSON-safe replay data that cannot be represented honestly
  as portable text, files, or tool calls.
- `onModelCallEnd` is awaited before another step. Accounting and tracing can therefore apply
  backpressure or fail closed without a provider library swallowing the error.

## Running a loop

```ts
import { runModelLoop, type ModelTool } from "@sixb/llm"

const tools: ModelTool[] = [search]
const result = await runModelLoop({
  model,
  messages: [{ role: "user", content: [{ type: "text", text: "Find the invoice" }] }],
  tools,
  reasoning: "medium",
  maxSteps: 12,
  signal,
  onEvent: publishLiveChunk,
  onModelCallEnd: recordUsage,
})
```

Provider authors can import the narrower contract surface from `@sixb/llm/provider`. Deterministic
model and stream helpers are available from `@sixb/llm/testing`.
