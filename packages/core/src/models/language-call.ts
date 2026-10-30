import { ModelStreamError } from "./errors"
import type {
  LanguageModelStreamEvent,
  ModelCallEndEvent,
  ModelProviderIds,
  ModelRoute,
  ModelUsage,
} from "./events"
import type {
  LanguageModel,
  LanguageModelRequest,
  LanguageModelStream,
  ModelReasoning,
} from "./language-model"
import {
  estimateModelCall,
  type ModelCallCost,
  type ModelReportedCost,
  rateModelCall,
} from "./pricing"

/**
 * What a language model call's stream says about the call: who served it, what it used and what
 * the provider charged. Only its `finish` event settles the meters, so a call that ends without one
 * is recorded with its usage unknown.
 */
export class LanguageModelCallMeter {
  private usage: ModelUsage = {}
  private responseId: string | undefined
  private providerIds: ModelProviderIds | undefined
  private responseModelId: string | undefined
  private reportedCost: ModelReportedCost | undefined
  private route: ModelRoute | undefined
  private settled = false

  /** Whether the stream finished, so its meters are final. */
  get finished(): boolean {
    return this.settled
  }

  accept(event: LanguageModelStreamEvent): void {
    if (event.type === "response-metadata") {
      this.responseId = event.id ?? this.responseId
      if (event.providerIds) this.providerIds = { ...this.providerIds, ...event.providerIds }
      this.responseModelId = event.modelId ?? this.responseModelId
    } else if (event.type === "finish") {
      this.settled = true
      this.usage = event.usage
      this.reportedCost = event.reportedCost
      this.route = event.route
    }
  }

  /** The meters as the stream reported them. */
  facts() {
    return {
      usage: this.usage,
      ...(this.responseId === undefined ? {} : { responseId: this.responseId }),
      ...(this.providerIds === undefined ? {} : { providerIds: this.providerIds }),
      ...(this.responseModelId === undefined ? {} : { responseModelId: this.responseModelId }),
      ...(this.reportedCost === undefined ? {} : { reportedCost: this.reportedCost }),
      ...(this.route === undefined ? {} : { route: this.route }),
    }
  }

  /**
   * How the call ended, as it is recorded: rated from the provider's charge when it reported one,
   * else estimated from the model's rate card. An unfinished call's usage stays unknown, never free.
   */
  end(call: {
    readonly model: Pick<LanguageModel, "providerId" | "modelId" | "costEstimator">
    readonly callId: string
    readonly requestedReasoning?: ModelReasoning
  }): ModelCallEndEvent {
    const facts = this.facts()
    const estimate: ModelCallCost = this.settled
      ? estimateModelCall(call.model, facts)
      : { status: "unpriceable", reason: "missing-usage" }
    const cost = facts.reportedCost
      ? rateModelCall({ usage: facts.usage, reported: facts.reportedCost })
      : estimate
    return {
      callId: call.callId,
      modelKind: "language",
      providerId: call.model.providerId,
      modelId: call.model.modelId,
      responseId: facts.responseId ?? `${call.callId}:response`,
      providerIds: facts.providerIds,
      responseModelId: facts.responseModelId,
      usage: facts.usage,
      cost,
      ...(facts.reportedCost === undefined ? {} : { estimate }),
      ...(call.requestedReasoning === undefined
        ? {}
        : { requestedReasoning: call.requestedReasoning }),
      ...(facts.route === undefined ? {} : { route: facts.route }),
    }
  }
}

/**
 * A call whose provider sends nothing for this long fails, its usage recorded unknown. A model
 * thinking at length still streams: providers keep a reasoning stream alive with events.
 */
export const MODEL_CALL_IDLE_MS = 10 * 60_000

/**
 * The model, with each call it makes reported once as it ends: when it finishes, before its
 * `finish` event reaches the reader, or however it ends instead, its usage then unknown: failed,
 * silent past {@link MODEL_CALL_IDLE_MS}, or let go by its reader, even before its first event. A
 * call is reported by the model that served it, never by whoever reads its stream.
 */
export function reportModelCalls(
  model: LanguageModel,
  onEnd: (event: ModelCallEndEvent) => void | Promise<void>
): LanguageModel {
  const { providerId, modelId, definition, costEstimator, rateCard } = model
  const { defaultReasoning, maxOutputTokens } = model
  // Read and bound once: a provider's model keeps its state in private fields.
  return {
    providerId,
    modelId,
    definition,
    ...(costEstimator === undefined ? {} : { costEstimator }),
    ...(rateCard === undefined ? {} : { rateCard }),
    ...(defaultReasoning === undefined ? {} : { defaultReasoning }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(model.validateResponseFormat === undefined
      ? {}
      : { validateResponseFormat: model.validateResponseFormat.bind(model) }),
    stream: async (request) => {
      // Aborted once the provider goes silent, or the reader lets the call go.
      const stop = new AbortController()
      const opening = model.stream({
        ...request,
        signal: AbortSignal.any([request.signal, stop.signal]),
      })
      // A response that never comes is not a call: nothing was accepted, so nothing is reported.
      const opened = await withinIdle(opening, stop, (late) => closeEvents(late.events))
      return { ...opened, events: reportedEvents(model, request, opened, stop, onEnd) }
    },
  }
}

function reportedEvents(
  model: LanguageModel,
  request: LanguageModelRequest,
  stream: LanguageModelStream,
  stop: AbortController,
  onEnd: (event: ModelCallEndEvent) => void | Promise<void>
): AsyncIterable<LanguageModelStreamEvent> {
  const meter = new LanguageModelCallMeter()
  let reported: Promise<void> | undefined
  // Once accepted, a call is reported exactly once, however it ends.
  const report = () => {
    reported ??= (async () =>
      onEnd(
        meter.end({
          model,
          callId: request.callId,
          ...(request.reasoning === undefined ? {} : { requestedReasoning: request.reasoning }),
        })
      ))()
    return reported
  }
  let source: AsyncIterator<LanguageModelStreamEvent> | undefined
  let done = false

  // An iterator of its own, not a generator: a generator's `finally` never runs for a reader that
  // lets go before its first `next()`, so that call would go unreported.
  const events: AsyncIterator<LanguageModelStreamEvent> = {
    async next() {
      if (done) return { done: true, value: undefined }
      source ??= stream.events[Symbol.asyncIterator]()
      let result: IteratorResult<LanguageModelStreamEvent>
      try {
        result = await withinIdle(source.next(), stop)
      } catch (error) {
        done = true
        if (stop.signal.aborted) closeEvents(source)
        await report()
        throw error
      }
      if (result.done) {
        done = true
        await report()
        return result
      }
      meter.accept(result.value)
      if (result.value.type === "finish") await report()
      return result
    },
    async return(value) {
      done = true
      if (!reported) stop.abort(new DOMException("The reader let the model call go.", "AbortError"))
      if (source) closeEvents(source)
      else closeEvents(stream.events)
      try {
        await report()
      } catch (error) {
        // Thrown to a reader that broke off, but lost on one that threw: say it here too.
        console.error(
          `[SixbModels] Model call '${request.callId}' ended early, and recording it failed.`,
          error
        )
        throw error
      }
      return { done: true, value }
    },
  }
  return { [Symbol.asyncIterator]: () => events }
}

/** Settle with `pending`, or fail once the provider has been silent for {@link MODEL_CALL_IDLE_MS}. */
async function withinIdle<T>(
  pending: Promise<T>,
  stop: AbortController,
  onLate?: (value: T) => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const silence = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new ModelStreamError(
        `[SixbModels] The model sent nothing for ${MODEL_CALL_IDLE_MS / 60_000} minutes.`
      )
      // A provider that honors its signal stops; one that does not is left behind.
      stop.abort(error)
      reject(error)
    }, MODEL_CALL_IDLE_MS)
  })
  try {
    return await Promise.race([pending, silence])
  } finally {
    clearTimeout(timer)
    if (stop.signal.aborted) pending.then(onLate, () => {})
  }
}

/** Close a provider's stream without waiting on it: one that ignores its signal may never settle. */
function closeEvents(
  events: AsyncIterable<LanguageModelStreamEvent> | AsyncIterator<LanguageModelStreamEvent>
): void {
  const iterator = Symbol.asyncIterator in events ? events[Symbol.asyncIterator]() : events
  void Promise.resolve()
    .then(() => iterator.return?.())
    .catch(() => {})
}
