import { resolveContentBlocks } from "../content"
import type { PlaudHttp } from "../http"
import type { PlaudClient } from "../types"
import { getRecording } from "./recordings"

export function createNotesResource(http: PlaudHttp): PlaudClient["notes"] {
  return {
    async list(id, options) {
      const file = await getRecording(http, id, options)
      return resolveContentBlocks(http, file.note_list, options?.signal)
    },
  }
}
