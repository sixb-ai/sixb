import { isContentBlockList, resolveContentBlocks } from "../content"
import type { PlaudHttp } from "../http"
import type {
  PlaudClient,
  PlaudRecording,
  PlaudRecordingDetails,
  PlaudRecordingPage,
  PlaudRequestOptions,
} from "../types"
import { integer, isRecord, nonEmpty } from "../validation"

export function createRecordingsResource(http: PlaudHttp): PlaudClient["recordings"] {
  const resource: PlaudClient["recordings"] = {
    get(id, options) {
      return getRecording(http, id, options)
    },
    async list(options = {}) {
      const page = integer(options.page ?? 1, 1, "page")
      const pageSize = integer(options.pageSize ?? 100, 10, "pageSize")
      const data = await http.get(
        `open/third-party/files/?page=${page}&page_size=${pageSize}`,
        options.signal
      )
      if (
        !isRecord(data) ||
        !Array.isArray(data.data) ||
        !data.data.every(isRecording) ||
        data.page !== page ||
        typeof data.page_size !== "number" ||
        !Number.isSafeInteger(data.page_size) ||
        data.page_size < 1 ||
        data.data.length > data.page_size
      )
        throw new Error("[SixbPlaud] Invalid recordings page response.")
      return data as unknown as PlaudRecordingPage
    },
    async *iterate(options = {}) {
      const from = dateBoundary(options.dateFrom, false)
      const to = dateBoundary(options.dateTo, true)
      if (from !== undefined && to !== undefined && from > to)
        throw new Error("[SixbPlaud] dateFrom must not be after dateTo.")
      const query = options.query?.toLowerCase()
      const seen = new Set<string>()
      let page = options.page ?? 1
      for (;;) {
        options.signal?.throwIfAborted()
        const result = await resource.list({ ...options, page })
        let added = 0
        for (const file of result.data) {
          if (seen.has(file.id)) continue
          seen.add(file.id)
          added++
          if (query && !file.name.toLowerCase().includes(query)) continue
          if (from !== undefined || to !== undefined) {
            const created = timestamp(file.created_at)
            if (!Number.isFinite(created))
              throw new Error(
                "[SixbPlaud] Recording has an invalid created_at timestamp; cannot filter it safely."
              )
            if (from !== undefined && created < from) continue
            if (to !== undefined && created > to) continue
          }
          yield file
        }
        if (result.data.length && !added)
          throw new Error(
            "[SixbPlaud] Pagination repeated a page. Results are incomplete; retry when the library is stable."
          )
        if (result.data.length < result.page_size) return
        page++
      }
    },
    async export(id, options) {
      const file = await getRecording(http, id, options)
      return {
        ...file,
        source_list: await resolveContentBlocks(http, file.source_list, options?.signal),
        note_list: await resolveContentBlocks(http, file.note_list, options?.signal),
      }
    },
    async downloadAudio(id, options) {
      const file = await getRecording(http, id, options)
      if (!file.presigned_url)
        throw new Error("[SixbPlaud] Audio is not available for this recording yet.")
      return http.download(file.presigned_url, options?.signal)
    },
  }
  return resource
}

/** Plaud serves transcript and note metadata through the recording details endpoint. */
export async function getRecording(
  http: PlaudHttp,
  id: string,
  options?: PlaudRequestOptions
): Promise<PlaudRecordingDetails> {
  nonEmpty(id, "recording id")
  if (id === "." || id === "..") throw new Error("[SixbPlaud] Invalid recording id.")
  const data = await http.get(`open/third-party/files/${encodeURIComponent(id)}`, options?.signal)
  if (
    !isRecording(data) ||
    !isRecord(data) ||
    (data.presigned_url !== null && typeof data.presigned_url !== "string") ||
    !isContentBlockList(data.source_list) ||
    !isContentBlockList(data.note_list)
  )
    throw new Error("[SixbPlaud] Invalid recording details response.")
  return data as unknown as PlaudRecordingDetails
}

function isRecording(value: unknown): value is PlaudRecording {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    !!value.id &&
    typeof value.name === "string" &&
    typeof value.created_at === "string" &&
    typeof value.start_at === "string" &&
    typeof value.duration === "number" &&
    Number.isFinite(value.duration) &&
    (value.serial_number === null || typeof value.serial_number === "string")
  )
}

function timestamp(value: string): number {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
  return Date.parse(hasZone || !value.includes(":") ? value : `${value}Z`)
}

function dateBoundary(value: string | undefined, end: boolean): number | undefined {
  if (value === undefined) return undefined
  const date = Date.parse(`${value}T00:00:00Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(date) ||
    new Date(date).toISOString().slice(0, 10) !== value
  )
    throw new Error("[SixbPlaud] Date filters must be valid YYYY-MM-DD dates.")
  return date + (end ? 86_400_000 - 1 : 0)
}
