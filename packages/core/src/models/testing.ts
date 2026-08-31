import { defineLanguageModel, type LanguageModelDefinition } from "./definitions"
import type { LanguageModelStreamEvent } from "./events"
import type {
  LanguageModel,
  LanguageModelRequest,
  LanguageModelStream,
  ModelCapabilities,
} from "./language-model"

/** Options for a deterministic language model used by provider and runtime tests. */
export interface MockLanguageModelOptions {
  readonly providerId?: string
  readonly modelId?: string
  readonly capabilities?: ModelCapabilities
  readonly definition?: LanguageModelDefinition
  readonly stream?: (request: LanguageModelRequest) => Promise<LanguageModelStream>
}

export class MockLanguageModel implements LanguageModel {
  readonly providerId: string
  readonly modelId: string
  readonly definition: LanguageModelDefinition
  private readonly streamHandler: (request: LanguageModelRequest) => Promise<LanguageModelStream>

  constructor(options: MockLanguageModelOptions = {}) {
    const providerId = options.providerId ?? options.definition?.providerId ?? "mock"
    const modelId = options.modelId ?? options.definition?.modelId ?? "mock-model"
    const capabilities = options.capabilities ??
      options.definition?.capabilities ?? {
        inputMediaTypes: ["image/*"],
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
    this.streamHandler =
      options.stream ??
      (async () => ({
        events: eventsFromArray([
          { type: "stream-start" },
          {
            type: "finish",
            finishReason: "stop",
            usage: {},
          },
        ]),
      }))
  }

  stream(request: LanguageModelRequest): Promise<LanguageModelStream> {
    return this.streamHandler(request)
  }
}

export async function* eventsFromArray(
  events: readonly LanguageModelStreamEvent[]
): AsyncIterable<LanguageModelStreamEvent> {
  yield* events
}

export function streamFromArray(events: readonly LanguageModelStreamEvent[]): LanguageModelStream {
  return { events: eventsFromArray(events) }
}

export function streamFromReadable(
  stream: ReadableStream<LanguageModelStreamEvent>
): LanguageModelStream {
  return { events: readableEvents(stream) }
}

async function* readableEvents(
  stream: ReadableStream<LanguageModelStreamEvent>
): AsyncIterable<LanguageModelStreamEvent> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}
