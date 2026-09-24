import type { RestClient } from "@sixb/connector-rest"
import { readResponseBody } from "@sixb/connector-rest"
import { MondayApiError } from "./errors"
import type { MondayRequestOptions, MondayWriteOptions } from "./types"
import { record } from "./validation"

export interface MondayHttp {
  read(
    query: string,
    variables: Record<string, unknown>,
    options?: MondayRequestOptions
  ): Promise<Record<string, unknown>>
  write(
    query: string,
    variables: Record<string, unknown>,
    options?: MondayWriteOptions
  ): Promise<Record<string, unknown>>
}
export function createMondayHttp(http: RestClient): MondayHttp {
  async function request(
    query: string,
    variables: Record<string, unknown>,
    read: boolean,
    options?: MondayWriteOptions
  ) {
    const key = read ? undefined : options?.idempotencyKey
    if (key !== undefined && (!key.trim() || /[\r\n]/.test(key)))
      throw new Error("[SixbMonday] idempotencyKey must be a non-empty single-line string.")
    const response = await http.request(
      "",
      {
        method: "POST",
        body: { query, variables },
        signal: options?.signal,
        redirect: "error",
        headers: key === undefined ? undefined : { "Idempotency-Key": key },
      },
      { idempotent: read, retryable: read }
    )
    const body = await readResponseBody(response)
    if (!response.ok || (record(body) && Array.isArray(body.errors) && body.errors.length > 0)) {
      throw new MondayApiError(response.status, body, response.headers)
    }
    if (!record(body) || ("errors" in body && !Array.isArray(body.errors)) || !record(body.data))
      throw new Error("[SixbMonday] Invalid GraphQL response envelope.")
    return body.data
  }
  return {
    read: (query, variables, options) => request(query, variables, true, options),
    write: (query, variables, options) => request(query, variables, false, options),
  }
}
