import { getArtifactMedia } from "@sixb/client"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { apiFileUrl, type FileSource } from "./file-source"
import { fileView } from "./file-view"
import { type ArtifactVersion, versionFileSource } from "./queries"

// A video or a sound of an artifact plays from the light proxy Sixb derives of it once it is
// ready, under the poster it picked, and from the original until then. Each is read once, when the
// file opens or its card nears the screen: a player that swapped its source midway would stop.

/** What a media of an artifact plays and shows as, where Sixb derived it. */
export interface DerivedMedia {
  /** What plays in its place: light, and it seeks at once. */
  readonly proxy?: string
  /** A picture of a representative moment, not a black first frame. */
  readonly poster?: string
  /** Its sound's peaks, which a waveform draws: see `usePeaks`. */
  readonly waveform?: string
}

const NONE: DerivedMedia = {}

/** Where the query cache keeps what is derived of a file. */
export function derivedMediaQueryKey(source: FileSource): readonly unknown[] {
  return ["artifact-media", ...source.queryKey]
}

/**
 * What is derived of `source`, once it is read: `undefined` while it is, `{}` for no file, a file
 * of no artifact, one nothing is derived of yet, or one the server could not answer for. The first
 * answer stays while the caller is mounted, whatever the query cache reads again.
 */
export function useDerivedMedia(
  source: FileSource | null,
  enabled = true
): DerivedMedia | undefined {
  const file = source?.artifactFile
  const [first, setFirst] = useState<DerivedMedia>()
  const query = useQuery({
    queryKey: source ? derivedMediaQueryKey(source) : ["artifact-media"],
    queryFn: async ({ signal }): Promise<DerivedMedia> => {
      if (!file) return NONE

      const { data } = await getArtifactMedia({
        path: { artifactId: file.artifactId, version: String(file.version) },
        query: { path: file.path },
        throwOnError: true,
        signal,
      })
      const { proxy, poster, waveform } = data.parts
      return {
        ...(proxy.status === "ready" ? { proxy: apiFileUrl(proxy.url) } : {}),
        ...(poster.status === "ready" ? { poster: apiFileUrl(poster.url) } : {}),
        ...(waveform.status === "ready" ? { waveform: apiFileUrl(waveform.url) } : {}),
      }
    },
    enabled: enabled && file !== undefined,
    // Asked again when the file opens again: by then, what was pending may be ready.
    staleTime: 30_000,
    retry: false,
  })

  if (!file) return NONE

  const answer = query.isError ? NONE : query.data
  // Read again on a return to the app, or by another card, a proxy now ready would swap the
  // source of a player midway.
  if (first === undefined && answer !== undefined) setFirst(answer)
  return first ?? answer
}

/**
 * The poster Sixb derived of a video version's first recording, its first video file, read once
 * `enabled`: what its card and chapters show until its scenes' stills are snapshotted, a few
 * seconds after it is published, or for good in a project that snapshots nothing.
 */
export function useVideoRecordingPoster(
  version: ArtifactVersion,
  enabled: boolean
): string | undefined {
  const recording = useMemo(() => {
    const file = version.files.find((each) => fileView(each.file) === "video")
    return file ? versionFileSource(version, file.path) : null
  }, [version])
  return useDerivedMedia(recording, enabled)?.poster
}
