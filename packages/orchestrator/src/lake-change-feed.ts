import { createSixbError } from "@sixb/core/internal/errors"
import type { LakeStorage, LatestVersionsSince } from "@sixb/core/lake-storage"

export interface ReadChangeFeedInput {
  readonly lakeStorage: Pick<LakeStorage, "listLatestVersionsSince">
  readonly projectId: string
  readonly cursor: string | null
  readonly datasetIds: readonly string[]
  /** The cursor stopped being a position in this lake: what it vouched for must be read again. */
  readonly onCursorLost: () => void
}

/** Reads the lake's change feed from an in-memory cursor, starting over when the cursor is lost. */
export async function readChangeFeed(input: ReadChangeFeedInput): Promise<LatestVersionsSince> {
  const read = (cursor: string | null) =>
    input.lakeStorage.listLatestVersionsSince({ cursor, datasetIds: input.datasetIds })

  const changes = await read(input.cursor)
  if (changes) return changes

  input.onCursorLost()

  const restarted = await read(null)
  if (restarted) return restarted

  throw createSixbError(
    "internal.unexpected",
    "[SixbOrchestrator] Lake change feed rejected a null cursor.",
    { details: { projectId: input.projectId } }
  )
}
