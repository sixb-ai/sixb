import { isSixbApiError } from "@sixb/client"
import type { FrameCall } from "@sixb/core/artifacts"
import { type QueryClient, useQueries } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import {
  type ArtifactVersion,
  artifactQueryKey,
  artifactQueryOptions,
  fetchArtifactQuery,
  type QueriedVersion,
  useArtifactQueryLiveUpdates,
} from "./queries"

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

/**
 * Calls `onChange` with a query the frame's page read once its rows are new: the objects it reads
 * changed, or the reader refreshed. The frame observes what its page read, as a live sheet does,
 * so those queries are read again with the version's other views.
 *
 * Rows read again the same keep their reference in the cache, so nothing is called for them; and
 * the rows the page was answered with are where each query starts.
 */
export function useQueryChanges(
  version: QueriedVersion,
  names: readonly string[],
  onChange: (name: string) => void
): void {
  const results = useQueries({
    queries: names.map((name) => ({
      ...artifactQueryOptions(version, name),
      // The page was answered already, refusal or not: a frame's observer reads nothing more.
      retryOnMount: false,
    })),
  })
  useArtifactQueryLiveUpdates(names.length > 0)

  const seen = useRef(new Map<string, unknown>())
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    names.forEach((name, index) => {
      const rows = results[index]?.data
      if (rows === undefined) return

      const key = JSON.stringify(artifactQueryKey(version.artifactId, version.version, name))
      const known = seen.current.has(key)
      const before = seen.current.get(key)
      seen.current.set(key, rows)

      if (known && before !== rows) onChangeRef.current(name)
    })
  })
}
