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
 * The model, with each call it makes reported once as it ends: when it finishes, before its
 * `finish` event reaches the reader, or however it ends instead, cancelled or failed, its usage then
 * unknown. A call is reported by the model that served it, never by whoever reads its stream.
 */
export function reportModelCalls(
  model: LanguageModel,
  onEnd: (event: ModelCallEndEvent) => void | Promise<void>
): LanguageModel {
  const { providerId, modelId, definition, costEstimator, rateCard } = model
  const { defaultReasoning, maxOutputTokens } = model
  const resolve = model.resolve?.bind(model)
  // Read and bound once: a provider's model keeps its state in private fields.
  return {
    providerId,
    modelId,
    definition,
    ...(costEstimator === undefined ? {} : { costEstimator }),
    ...(rateCard === undefined ? {} : { rateCard }),
    ...(defaultReasoning === undefined ? {} : { defaultReasoning }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(resolve === undefined
      ? {}
      : { resolve: async (options) => reportModelCalls(await resolve(options), onEnd) }),
    ...(model.validateResponseFormat === undefined
      ? {}
      : { validateResponseFormat: model.validateResponseFormat.bind(model) }),
    stream: async (request) => {
      const opened = await model.stream(request)
      return { ...opened, events: reported(model, request, opened, onEnd) }
    },
  }
}

async function* reported(
  model: LanguageModel,
  request: LanguageModelRequest,
  stream: LanguageModelStream,
  onEnd: (event: ModelCallEndEvent) => void | Promise<void>
): AsyncGenerator<LanguageModelStreamEvent> {
  const meter = new LanguageModelCallMeter()
  let reported = false
  const report = () => {
    reported = true
    return onEnd(
      meter.end({
        model,
        callId: request.callId,
        ...(request.reasoning === undefined ? {} : { requestedReasoning: request.reasoning }),
      })
    )
  }
  try {
    for await (const event of stream.events) {
      meter.accept(event)
      if (event.type === "finish") await report()
      yield event
    }
  } finally {
    // Once accepted, a call is never erased: cancelled, failed or unfinished, it is reported.
    if (!reported) await report()
  }
}
