import type {
  LanguageModel,
  LanguageModelRequest,
  LanguageModelStream,
  LanguageModelStreamEvent,
  ModelAssistantPart,
  ModelCapabilities,
  ModelFinishReason,
  ModelUsage,
} from "@sixb/core/models"
import { defineLanguageModel, type LanguageModelDefinition } from "@sixb/core/models"

export type WorkerTestStreamEvent =
  | LanguageModelStreamEvent
  | { readonly type: "stream-start"; readonly warnings: readonly unknown[] }

type WorkerTestStream =
  | LanguageModelStream
  | { readonly stream: ReadableStream<WorkerTestStreamEvent> }

interface WorkerTestGeneration {
  readonly content: readonly Extract<ModelAssistantPart, { type: "text" | "tool-call" }>[]
  readonly finishReason:
    | ModelFinishReason
    | { readonly unified: ModelFinishReason; readonly raw?: string }
  readonly usage: ModelUsage
  readonly warnings?: readonly unknown[]
}

export interface WorkerTestModelOptions {
  readonly providerId?: string
  readonly modelId?: string
  readonly capabilities?: ModelCapabilities
  readonly definition?: LanguageModelDefinition
  readonly stream?: (request: LanguageModelRequest) => Promise<WorkerTestStream>
  readonly generate?: (request: LanguageModelRequest) => Promise<WorkerTestGeneration>
}

/** Concise model fixture for the worker's integration tests. */
export class WorkerTestModel implements LanguageModel {
  readonly providerId: string
  readonly modelId: string
  readonly definition: LanguageModelDefinition
  private readonly handler: (request: LanguageModelRequest) => Promise<WorkerTestStream>

  constructor(options: WorkerTestModelOptions = {}) {
    const providerId = options.providerId ?? options.definition?.providerId ?? "mock"
    const modelId = options.modelId ?? options.definition?.modelId ?? "mock-model"
    const capabilities = options.capabilities ??
      options.definition?.capabilities ?? {
        inputMediaTypes: [],
        reasoning: {
          canDisable: true,
          efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
          budgetTokens: {},
        },
        localTools: true,
        parallelToolCalls: true,
        nativeStructuredOutput: true,
      }
    this.definition = defineLanguageModel(
      options.definition ?? { kind: "language", providerId, modelId, capabilities }
    )
    this.providerId = this.definition.providerId
    this.modelId = this.definition.modelId
    this.handler =
      options.stream ??
      (options.generate
        ? async (request) => generationStream(await options.generate?.(request))
        : async () => testStream([{ type: "stream-start" }, finishEvent("stop", {})]))
  }

  async stream(request: LanguageModelRequest): Promise<LanguageModelStream> {
    const result = await this.handler(request)
    if ("events" in result) return result
    return { events: readableEvents(result.stream) }
  }
}

export function testStream(events: readonly WorkerTestStreamEvent[]): LanguageModelStream {
  return { events: arrayEvents(events) }
}

async function* arrayEvents(
  events: readonly WorkerTestStreamEvent[]
): AsyncIterable<LanguageModelStreamEvent> {
  for (const event of events) yield normalizeEvent(event)
}

async function* readableEvents(
  stream: ReadableStream<WorkerTestStreamEvent>
): AsyncIterable<LanguageModelStreamEvent> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield normalizeEvent(value)
    }
  } finally {
    reader.releaseLock()
  }
}

function normalizeEvent(event: WorkerTestStreamEvent): LanguageModelStreamEvent {
  return event.type === "stream-start" ? { type: "stream-start" } : event
}

function generationStream(generation: WorkerTestGeneration | undefined): LanguageModelStream {
  if (!generation) throw new Error("Worker test generation did not return a result.")
  const events: LanguageModelStreamEvent[] = [{ type: "stream-start" }]
  generation.content.forEach((part, index) => {
    if (part.type === "text") {
      const id = `generated-text-${index}`
      events.push(
        { type: "text-start", id },
        { type: "text-delta", id, delta: part.text },
        { type: "text-end", id }
      )
    } else {
      events.push({
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
      })
    }
  })
  const reason =
    typeof generation.finishReason === "string"
      ? generation.finishReason
      : generation.finishReason.unified
  events.push(finishEvent(reason, generation.usage))
  return testStream(events)
}

function finishEvent(finishReason: ModelFinishReason, usage: ModelUsage): LanguageModelStreamEvent {
  return { type: "finish", finishReason, rawFinishReason: finishReason, usage }
}
