import { defineLanguageModel, type LanguageModelDefinition } from "../../src/models/definitions"
import type { LanguageModelStreamEvent } from "../../src/models/events"
import type {
  LanguageModel,
  LanguageModelRequest,
  LanguageModelStream,
  ModelCapabilities,
} from "../../src/models/language-model"

interface MockLanguageModelOptions {
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

async function* eventsFromArray(
  events: readonly LanguageModelStreamEvent[]
): AsyncIterable<LanguageModelStreamEvent> {
  yield* events
}

export function streamFromArray(events: readonly LanguageModelStreamEvent[]): LanguageModelStream {
  return { events: eventsFromArray(events) }
}
