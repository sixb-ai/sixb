import type { RestRequestInit } from "@sixb/connector-rest"
import { MicrosoftApiError, MicrosoftAuthError, MicrosoftProtocolError } from "../../errors"
import { checkEmpty, type MicrosoftHttp, readJson } from "../../http"
import { allPages, page } from "../../pagination"
import type { GraphPage, RequestOptions, SelectOptions } from "../../types/common"
import type {
  Subscription,
  SubscriptionCreate,
  SubscriptionCreateOptions,
  SubscriptionUpdate,
} from "../../types/subscriptions"
import { query, resource, segment } from "../../validation"
import { validateCreate, validateUpdate } from "./validation"

export interface SubscriptionsResource {
  create(input: SubscriptionCreate, options?: SubscriptionCreateOptions): Promise<Subscription>
  get(id: string, options?: SelectOptions): Promise<Subscription>
  /** Graph does not support OData query options on this collection. */
  list(options?: RequestOptions): Promise<GraphPage<Subscription>>
  listAll(options?: RequestOptions): AsyncIterable<Subscription>
  update(id: string, input: SubscriptionUpdate, options?: RequestOptions): Promise<Subscription>
  delete(id: string, options?: RequestOptions): Promise<void>
  /** Does not extend expiration. Do not combine with update within ten minutes. */
  reauthorize(id: string, options?: RequestOptions): Promise<void>
}

/** The request may have taken effect. Reconcile before repeating it. */
export class MicrosoftSubscriptionMutationError extends Error {
  readonly outcomeUnknown = true
  constructor(cause: unknown) {
    super(
      "[SixbMicrosoft] Subscription mutation outcome is unknown; reconcile before repeating it.",
      { cause }
    )
    this.name = "MicrosoftSubscriptionMutationError"
  }
}

const path = (id: string) => `subscriptions/${segment(id, "subscriptionId")}`

async function mutate<T>(
  http: MicrosoftHttp,
  url: string,
  init: RestRequestInit,
  status: number,
  parse: (response: Response) => Promise<T>
): Promise<T> {
  // An already-aborted request cannot have reached Graph.
  http.signal.throwIfAborted()
  init.signal?.throwIfAborted()
  try {
    const response = await http.request(url, init)
    if (!response.ok) await checkEmpty(response)
    if (response.status !== status) {
      await response.body?.cancel()
      throw new MicrosoftProtocolError("Unexpected subscription mutation response status.")
    }
    return await parse(response)
  } catch (cause) {
    if (cause instanceof MicrosoftApiError || cause instanceof MicrosoftAuthError) throw cause
    throw new MicrosoftSubscriptionMutationError(cause)
  }
}
const subscription = async (response: Response): Promise<Subscription> =>
  resource(await readJson(response))

export function subscriptionsResource(http: MicrosoftHttp): SubscriptionsResource {
  return {
    create(input, options) {
      validateCreate(input)
      return mutate(
        http,
        "subscriptions",
        {
          method: "POST",
          body: JSON.stringify(input),
          signal: options?.signal,
          headers: {
            "Content-Type": "application/json",
            ...(options?.immutableIds ? { Prefer: 'IdType="ImmutableId"' } : {}),
          },
        },
        201,
        subscription
      )
    },
    async get(id, options) {
      return resource(await http.json(`${path(id)}${query(options)}`, { signal: options?.signal }))
    },
    async list(options) {
      return page(await http.json("subscriptions", { signal: options?.signal }))
    },
    listAll(options) {
      return allPages(http, "subscriptions", options)
    },
    update(id, input, options) {
      const url = path(id)
      validateUpdate(input)
      return mutate(
        http,
        url,
        {
          method: "PATCH",
          body: JSON.stringify(input),
          headers: { "Content-Type": "application/json" },
          signal: options?.signal,
        },
        200,
        subscription
      )
    },
    delete(id, options) {
      return mutate(http, path(id), { method: "DELETE", signal: options?.signal }, 204, checkEmpty)
    },
    reauthorize(id, options) {
      return mutate(
        http,
        `${path(id)}/reauthorize`,
        { method: "POST", signal: options?.signal },
        204,
        checkEmpty
      )
    },
  }
}
