import type { MetaGraphError, MetaHeader, MetaUsage } from "./common"

declare const metaBatchBody: unique symbol

/** A read-only Graph API sub-request prepared for batch execution. */
export interface MetaBatchGetRequest<TBody = unknown> {
  readonly relativeUrl: string
  readonly accessToken?: string
  readonly [metaBatchBody]?: TBody
}

export interface MetaBatchSuccess<TBody> {
  readonly ok: true
  readonly status: number
  readonly body: TBody
  readonly rawBody: string
  readonly headers: readonly MetaHeader[]
  readonly usage: MetaUsage
}

export interface MetaBatchFailure {
  readonly ok: false
  readonly status: number
  readonly body: unknown
  readonly rawBody: string
  readonly headers: readonly MetaHeader[]
  readonly usage: MetaUsage
  readonly error?: MetaGraphError
}

export type MetaBatchResult<TBody = unknown> = MetaBatchSuccess<TBody> | MetaBatchFailure

export type MetaBatchResults<TRequests extends readonly MetaBatchGetRequest[]> = {
  readonly [Index in keyof TRequests]: TRequests[Index] extends MetaBatchGetRequest<infer TBody>
    ? MetaBatchResult<TBody>
    : never
}

export interface MetaBatchApi {
  /** Prepare a `GET` sub-request. Absolute URLs are rejected during execution. */
  get<TBody = unknown>(
    relativeUrl: string,
    options?: { readonly accessToken?: string }
  ): MetaBatchGetRequest<TBody>

  /** Execute between 1 and 50 independent Graph reads and preserve their input order. */
  execute<const TRequests extends readonly MetaBatchGetRequest[]>(
    requests: TRequests
  ): Promise<MetaBatchResults<TRequests>>
}
