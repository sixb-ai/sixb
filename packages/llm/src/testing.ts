import type { LanguageModelStreamEvent } from "./events"
import type {
  LanguageModel,
  LanguageModelRequest,
  LanguageModelStream,
  ModelCapabilities,
} from "./model"

export interface MockLanguageModelOptions {
  readonly providerId?: string
  readonly modelId?: string
  readonly capabilities?: ModelCapabilities
  readonly stream?: (request: LanguageModelRequest) => Promise<LanguageModelStream>
}

export class MockLanguageModel implements LanguageModel {
  readonly providerId: string
  readonly modelId: string
  readonly capabilities: ModelCapabilities
  private readonly streamHandler: (request: LanguageModelRequest) => Promise<LanguageModelStream>

  constructor(options: MockLanguageModelOptions = {}) {
    this.providerId = options.providerId ?? "mock"
    this.modelId = options.modelId ?? "mock-model"
    this.capabilities = options.capabilities ?? {
      inputMediaTypes: ["image/*"],
      reasoning: true,
      localTools: true,
      parallelToolCalls: true,
      nativeStructuredOutput: true,
    }
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
