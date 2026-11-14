import type { RestQueryParams } from "@sixb/connector-rest"
import type { CtmHttp } from "../http"
import { toCallPage, WALK_PAGE_SIZE, walkCalls } from "../pagination"
import type {
  CtmCall,
  CtmCallListOptions,
  CtmCallPage,
  CtmCallSearchOptions,
  CtmCallUpdateInput,
  CtmComment,
  CtmCommentInput,
  CtmId,
  CtmObject,
  CtmSale,
  CtmSaleInput,
  CtmTranscript,
} from "../types"
import { assertNonEmpty, assertPositiveInteger, isRecord, pathId } from "../validation"
import type { CtmAccountPath } from "./shared"

/**
 * The call log: calls, text messages and form submissions, with what CTM attaches to each.
 *
 * Every method takes the activity's numeric `id`, except `recording`, which takes its `sid`.
 */
export interface CallsResource {
  /** `GET /calls` — one page, newest first unless `order` says otherwise. */
  list(options?: CtmCallListOptions): Promise<CtmCallPage>
  /** Every activity, following `after` from page to page, 100 a page unless `pageSize` says. */
  listAll(options?: CtmCallListOptions): AsyncIterable<CtmCall>
  /** `POST /calls/search` — the list with CTM's query object for field-level conditions. */
  search(options?: CtmCallSearchOptions): Promise<CtmCallPage>
  searchAll(options?: CtmCallSearchOptions): AsyncIterable<CtmCall>
  /** `GET /calls/{id}` — the full activity, with `caller`. */
  get(callId: CtmId): Promise<CtmCall>
  /**
   * `GET /calls/{id}/transcription` — the transcript of the call's recording, or `null` when the
   * call has none yet: CTM then answers with a status instead of a transcript.
   */
  transcript(callId: CtmId): Promise<CtmTranscript | null>
  /**
   * `GET /calls/{sid}/recording` — the recording, as the response that carries it. Read it with
   * `.arrayBuffer()` or stream `.body` to storage; `content-type` names the audio format.
   *
   * Takes the call's `sid` (`CA…`), as its `audio` URL does.
   */
  recording(callSid: string): Promise<Response>

  /** `POST /calls/{id}/modify` — change the caller's details or the call's custom fields. */
  update(callId: CtmId, input: CtmCallUpdateInput): Promise<CtmCall>
  /** `GET /calls/{id}/sale` */
  getSale(callId: CtmId): Promise<CtmSale>
  /** `POST /calls/{id}/sale` — create or replace the call's sale record. */
  saveSale(callId: CtmId, input: CtmSaleInput): Promise<CtmObject>
  /** `DELETE /calls/{id}/sale` */
  deleteSale(callId: CtmId): Promise<CtmObject>
  /** `POST /calls/{id}/add_comment` */
  addComment(callId: CtmId, input: CtmCommentInput): Promise<CtmComment>
  /** `POST /calls/{id}/update_comment` */
  updateComment(callId: CtmId, noteId: number, input: CtmCommentInput): Promise<CtmComment>
  /** `DELETE /calls/{id}/delete_comment` */
  deleteComment(callId: CtmId, noteId: number): Promise<CtmObject>
  /** `PATCH /calls/{id}/tag` */
  addTag(callId: CtmId, tag: string): Promise<CtmObject>
  /** `DELETE /calls/{id}/tag` */
  removeTag(callId: CtmId, tag: string): Promise<CtmObject>
  /** `POST /calls/{id}/spam` */
  markSpam(callId: CtmId): Promise<CtmObject>
  /** `POST /calls/{id}/unspam` */
  unmarkSpam(callId: CtmId): Promise<CtmObject>
}

export function callsResource(http: CtmHttp, at: CtmAccountPath): CallsResource {
  const call = (callId: CtmId, suffix = "") => at(`calls/${pathId(callId, "callId")}${suffix}`)

  const resource: CallsResource = {
    async list(options) {
      assertPositiveInteger(options?.pageSize, "pageSize")

      return toCallPage(await http.get(at("calls"), listQuery(options)))
    },

    listAll(options) {
      const pageSize = options?.pageSize ?? WALK_PAGE_SIZE

      return walkCalls((after) => resource.list({ ...options, pageSize, after }), options?.after)
    },

    async search(options) {
      assertPositiveInteger(options?.page, "page")
      assertPositiveInteger(options?.pageSize, "pageSize")

      const body = await http.post(at("calls/search.json"), searchBody(options), {
        idempotent: true,
      })

      return toCallPage(body)
    },

    searchAll(options) {
      const pageSize = options?.pageSize ?? WALK_PAGE_SIZE
      let page = options?.page ?? 1

      // CTM documents `page` for search, and answers with an `after` cursor as well, so each
      // request sends both and the walk advances whichever the route reads.
      return walkCalls(
        (after) => resource.search({ ...options, pageSize, after, page: page++ }),
        options?.after
      )
    },

    async get(callId) {
      return http.get<CtmCall>(call(callId))
    },

    async transcript(callId) {
      const body = await http.get<CtmTranscript | CtmObject>(call(callId, "/transcription.json"))

      return isTranscript(body) ? body : null
    },

    async recording(callSid) {
      assertNonEmpty(callSid, "callSid")

      return http.download(at(`calls/${pathId(callSid, "callSid")}/recording`))
    },

    async update(callId, input) {
      const result = await http.post<{ readonly call?: CtmCall }>(call(callId, "/modify"), input)

      if (!result?.call) {
        throw new Error("[SixbCtm] CTM answered the call update without the call.")
      }

      return result.call
    },

    async getSale(callId) {
      return http.get<CtmSale>(call(callId, "/sale"))
    },

    async saveSale(callId, input) {
      const body = { ...input, conversion: toFlag(input.conversion) }

      return http.post<CtmObject>(call(callId, "/sale"), body)
    },

    async deleteSale(callId) {
      return http.delete<CtmObject>(call(callId, "/sale"))
    },

    async addComment(callId, input) {
      assertNonEmpty(input.note, "note")

      return http.post<CtmComment>(call(callId, "/add_comment"), input)
    },

    async updateComment(callId, noteId, input) {
      assertPositiveInteger(noteId, "noteId")
      assertNonEmpty(input.note, "note")

      return http.post<CtmComment>(call(callId, "/update_comment"), { ...input, note_id: noteId })
    },

    async deleteComment(callId, noteId) {
      assertPositiveInteger(noteId, "noteId")

      return http.delete<CtmObject>(call(callId, "/delete_comment"), { note_id: noteId })
    },

    async addTag(callId, tag) {
      assertNonEmpty(tag, "tag")

      return http.patch<CtmObject>(withTag(call(callId, "/tag"), tag))
    },

    async removeTag(callId, tag) {
      assertNonEmpty(tag, "tag")

      return http.delete<CtmObject>(withTag(call(callId, "/tag"), tag))
    },

    async markSpam(callId) {
      return http.post<CtmObject>(call(callId, "/spam"))
    },

    async unmarkSpam(callId) {
      return http.post<CtmObject>(call(callId, "/unspam"))
    },
  }

  return resource
}

/** CTM's list parameters. Array filters are written `direction[]=…`, one per value. */
function listQuery(options: CtmCallListOptions | undefined): RestQueryParams {
  return {
    after: options?.after,
    per_page: options?.pageSize,
    start_date: options?.startDate,
    end_date: options?.endDate,
    time_duration: options?.timeDuration,
    start_day: options?.startDay,
    with_time: options?.withTime ? 1 : undefined,
    "direction[]": options?.directions,
    filter: options?.filter,
    contact_number: options?.contactNumber,
    "limit_fields[]": options?.fields,
    order: options?.order,
    stats: options?.stats ? "on" : undefined,
    all: options?.agencyWide ? 1 : undefined,
  }
}

/** The same parameters as a JSON body, where arrays need no brackets, plus the query object. */
function searchBody(options: CtmCallSearchOptions | undefined): Record<string, unknown> {
  const { "direction[]": direction, "limit_fields[]": limitFields, ...rest } = listQuery(options)

  return {
    ...rest,
    page: options?.page,
    direction,
    limit_fields: limitFields,
    query: options?.query,
  }
}

/** The tag goes in the query string, encoded, on both the add and the remove route. */
function withTag(path: string, tag: string): string {
  return `${path}?${new URLSearchParams({ tag })}`
}

/** CTM reads the sale's conversion flag as `1` or `0`. */
function toFlag(value: boolean | undefined): 0 | 1 | undefined {
  return value === undefined ? undefined : value ? 1 : 0
}

function isTranscript(body: CtmTranscript | CtmObject): body is CtmTranscript {
  return isRecord(body) && Array.isArray(body.outline)
}
