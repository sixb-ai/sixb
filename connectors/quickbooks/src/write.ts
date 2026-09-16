import { QuickBooksWriteError } from "./errors"
import type { QuickBooksReadHttp } from "./query"
import type { QuickBooksRevision, QuickBooksWriteOptions } from "./types/writes"
import { isRecord, nonEmpty } from "./validation"

export interface QuickBooksWriteHttp extends QuickBooksReadHttp {
  post(path: string, body: unknown, requestId: string, send?: boolean): Promise<unknown>
}

export function revision(input: QuickBooksRevision): QuickBooksRevision {
  nonEmpty(input.Id, "Id")
  nonEmpty(input.SyncToken, "SyncToken")
  return { Id: input.Id, SyncToken: input.SyncToken }
}

export function createInput(input: object) {
  if ("Id" in input || "SyncToken" in input || "sparse" in input)
    throw new Error("[SixbQuickBooks] Create input must not contain Id, SyncToken, or sparse.")
}

export async function writeEntity<T>(
  http: QuickBooksWriteHttp,
  entity: string,
  path: string,
  input: unknown,
  options: QuickBooksWriteOptions = {},
  expected?: { id: string; deleted?: boolean },
  send = false
): Promise<T> {
  const requestId = options.requestId ?? crypto.randomUUID()
  nonEmpty(requestId, "requestId")
  if (requestId.length > 50) throw new Error("[SixbQuickBooks] requestId exceeds 50 characters.")
  const body = await http.post(path, input, requestId, send)
  const value = isRecord(body) ? body[entity] : undefined
  if (
    !isRecord(value) ||
    typeof value.Id !== "string" ||
    !value.Id.trim() ||
    (expected && value.Id !== expected.id) ||
    (expected?.deleted
      ? value.status !== "Deleted"
      : typeof value.SyncToken !== "string" || !value.SyncToken.trim())
  ) {
    throw new QuickBooksWriteError(requestId, new Error(`Invalid ${entity} write response.`))
  }
  return value as T
}
