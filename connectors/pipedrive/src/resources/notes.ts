import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllOffset } from "../pagination"
import type {
  PipedriveNote,
  PipedriveNoteComment,
  PipedriveNoteCommentsOptions,
  PipedriveNoteListOptions,
  PipedriveOffsetPage,
  PipedriveResponse,
} from "../types"

export interface NotesResource {
  /** `GET /notes` */
  list(options?: PipedriveNoteListOptions): Promise<PipedriveOffsetPage<PipedriveNote>>
  listAll(options?: PipedriveNoteListOptions): AsyncIterable<PipedriveNote>
  /** `GET /notes/{id}` */
  get(id: number): Promise<PipedriveResponse<PipedriveNote>>
  /** `GET /notes/{id}/comments` */
  listComments(
    noteId: number,
    options?: PipedriveNoteCommentsOptions
  ): Promise<PipedriveOffsetPage<PipedriveNoteComment>>
  /** `GET /notes/{id}/comments/{commentId}` */
  getComment(noteId: number, commentId: number): Promise<PipedriveResponse<PipedriveNoteComment>>
}

export function notesResource(http: PipedriveHttp): NotesResource {
  const resource: NotesResource = {
    list(options) {
      return http.get("v1", "notes", options)
    },
    listAll(options) {
      return listAllOffset(resource.list, options)
    },
    get(id) {
      return http.get("v1", `notes/${pathPart(id, "note id")}`)
    },
    listComments(noteId, options) {
      return http.get("v1", `notes/${pathPart(noteId, "note id")}/comments`, options)
    },
    getComment(noteId, commentId) {
      return http.get(
        "v1",
        `notes/${pathPart(noteId, "note id")}/comments/${pathPart(commentId, "comment id")}`
      )
    },
  }

  return resource
}
