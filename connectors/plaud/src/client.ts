import type { PlaudHttp } from "./http"
import { createNotesResource } from "./resources/notes"
import { createRecordingsResource } from "./resources/recordings"
import { createTranscriptsResource } from "./resources/transcripts"
import { createUsersResource } from "./resources/users"
import type { PlaudClient } from "./types"

export function createPlaudClient(http: PlaudHttp): PlaudClient {
  return {
    users: createUsersResource(http),
    recordings: createRecordingsResource(http),
    transcripts: createTranscriptsResource(http),
    notes: createNotesResource(http),
  }
}
