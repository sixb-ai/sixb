import { type SerializedExpandedObject, serializeExpandedObject } from "../objects/serialize"
import type {
  ArtifactFacetsQueryResult,
  ArtifactObjectsQueryResult,
  ArtifactQueryResult,
} from "./queries"

export type SerializedArtifactQueryResult =
  | (Omit<ArtifactObjectsQueryResult, "objects"> & {
      readonly objects: readonly SerializedExpandedObject[]
    })
  | ArtifactFacetsQueryResult

/**
 * An artifact query's result as `GET /api/artifacts/:id/versions/:v/queries/:name` answers it, and
 * as a page's `sixb.query` resolves: its rows as the query route serializes them, or its facets.
 * The route and the Agent's layout check both serve it, so a page reads the same JSON in either.
 */
export function serializeArtifactQueryResult(
  result: ArtifactQueryResult
): SerializedArtifactQueryResult {
  return result.kind === "objects"
    ? { ...result, objects: result.objects.map(serializeExpandedObject) }
    : result
}
