import type { JsonObject, ModelCaching, ModelMessage } from "@sixb/core/models"
import { billsPromptCacheWrites } from "@sixb/model-protocols/responses"
import type { AzureAIFoundryDeployment } from "./discovery"

/** The caching settings Sixb sends on Responses and Chat; Azure may refuse any for a deployment. */
const CACHING_FIELDS = ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"]

/**
 * Settings Azure refused, by request scope and field. A caching setting is an optimization: one
 * Azure refuses is dropped from that deployment's later requests instead of failing them.
 */
const refusals = new Set<string>()

/**
 * Responses and Chat cache a prompt of 1,024 tokens or more on their own, so these settings only
 * say what Sixb knows about the request (measured on Azure, November 2026):
 *
 * - `prompt_cache_key`: the intent's key, such as a conversation's, which keeps its requests where
 *   their prefix is cached. Every model tried accepts it; Kimi hit the cache one call sooner.
 * - A one-shot request (no tools and no earlier answer) on a model that bills cache writes
 *   (GPT-5.6 and later) asks for explicit caching with no breakpoints, which writes nothing:
 *   nothing reads its prefix again, and a write costs 1.25 times input. `caching: "off"` too.
 * - A conversation's `"long"` lifetime keeps an earlier OpenAI model's cache for 24 hours instead
 *   of its 5 to 10 idle minutes, at the same price. GPT-5.6 and later keep their 30-minute default:
 *   twelve hours would double the price of every write to cover longer pauses.
 *
 * The binding's own `request` settings win, and so does a refusal.
 */
export function promptCaching(input: {
  readonly caching: ModelCaching | undefined
  readonly messages: readonly ModelMessage[]
  readonly localTools: number
  readonly deployment: AzureAIFoundryDeployment | undefined
  readonly request: JsonObject | undefined
  readonly scope: string
}): JsonObject {
  const { caching, deployment } = input
  const openai = deployment?.modelPublisher.toLowerCase() === "openai"
  const billsWrites = openai && billsPromptCacheWrites(deployment.modelName)
  const reusable =
    caching === "auto" ||
    (caching !== "off" &&
      (input.localTools > 0 || input.messages.some((message) => message.role === "assistant")))
  const intent = typeof caching === "object" ? caching : undefined
  const settings: JsonObject = {
    ...(intent?.key ? { prompt_cache_key: intent.key } : {}),
    ...(!reusable && billsWrites ? { prompt_cache_options: { mode: "explicit" } } : {}),
    ...(reusable && openai && !billsWrites && intent?.lifetime === "long"
      ? { prompt_cache_retention: "24h" }
      : {}),
  }
  return Object.fromEntries(
    Object.entries(settings).filter(
      ([field]) =>
        !Object.hasOwn(input.request ?? {}, field) && !refusals.has(`${input.scope}\0${field}`)
    )
  )
}

/**
 * Remember a caching setting Sixb added to the sent body that Azure refused with a 400 naming it;
 * whether there was one, so the request can go again without it. The binding's own are its call.
 */
export function refusedCaching(
  error: { readonly status?: number; readonly message: string },
  body: JsonObject,
  request: JsonObject | undefined,
  scope: string
): boolean {
  if (error.status !== 400) return false
  const field = CACHING_FIELDS.find(
    (name) =>
      Object.hasOwn(body, name) &&
      !Object.hasOwn(request ?? {}, name) &&
      error.message.includes(name)
  )
  if (!field) return false
  refusals.add(`${scope}\0${field}`)
  return true
}
