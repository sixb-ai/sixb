import { isSixbApiError } from "@sixb/client"
import type { FrameCall } from "@sixb/core/artifacts"
import type { QueryClient } from "@tanstack/react-query"
import { type ArtifactVersion, fetchArtifactQuery } from "./queries"

/**
 * Answers a frame's `sixb.query` call for the version that frame shows, as the signed-in reader:
 * the API runs the query with their rights, and the page gets the route's JSON as it is. It reads
 * through the cache a live sheet of the version reads, so the frames of a version that ask
 * together, a deck's stage and its filmstrip, share one read.
 */
export async function answerQueryCall(
  queries: QueryClient,
  version: Pick<ArtifactVersion, "artifactId" | "version">,
  call: Extract<FrameCall, { readonly method: "query.run" }>
): Promise<unknown> {
  try {
    return await fetchArtifactQuery(queries, version, call.params.name)
  } catch (error) {
    throw new Error(reason(error))
  }
}

/** What the page's promise rejects with: the API's own words when it gave any. */
function reason(error: unknown): string {
  if (isSixbApiError(error)) {
    const body = error.body as { error?: unknown } | null
    if (typeof body?.error === "string") return body.error
  }
  return "[SixbApp] The page's data could not be read. Try again."
}
