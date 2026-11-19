import { getArtifactMedia } from "@sixb/client"
import { useQuery } from "@tanstack/react-query"
import { apiFileUrl, type FileSource } from "./file-source"

// A video or a sound of an artifact plays from the light proxy Sixb derives of it once it is
// ready, under the poster it picked, and from the original until then. Each is read once, when the
// file opens or its card nears the screen: a player that swapped its source midway would stop.

/** What a media of an artifact plays and shows as, where Sixb derived it. */
export interface DerivedMedia {
  /** What plays in its place: light, and it seeks at once. */
  readonly proxy?: string
  /** A picture of a representative moment, not a black first frame. */
  readonly poster?: string
}

const NONE: DerivedMedia = {}

/** Where the query cache keeps what is derived of a file. */
export function derivedMediaQueryKey(source: FileSource): readonly unknown[] {
  return ["artifact-media", ...source.queryKey]
}

/**
 * What is derived of `source`, once it is read: `undefined` while it is, `{}` for a file of no
 * artifact, one nothing is derived of yet, or one the server could not answer for.
 */
export function useDerivedMedia(source: FileSource, enabled = true): DerivedMedia | undefined {
  const file = source.artifactFile
  const query = useQuery({
    queryKey: derivedMediaQueryKey(source),
    queryFn: async ({ signal }): Promise<DerivedMedia> => {
      if (!file) return NONE

      const { data } = await getArtifactMedia({
        path: { artifactId: file.artifactId, version: String(file.version) },
        query: { path: file.path },
        throwOnError: true,
        signal,
      })
      const { proxy, poster } = data.parts
      return {
        ...(proxy.status === "ready" ? { proxy: apiFileUrl(proxy.url) } : {}),
        ...(poster.status === "ready" ? { poster: apiFileUrl(poster.url) } : {}),
      }
    },
    enabled: enabled && file !== undefined,
    // Asked again when the file opens again: by then, what was pending may be ready.
    staleTime: 30_000,
    retry: false,
  })

  if (!file) return NONE
  if (query.isError) return NONE
  return query.data
}
