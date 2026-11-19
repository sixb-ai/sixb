import { type ExportArtifactVideoResponse, exportArtifactVideo } from "@sixb/client"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import type { ArtifactVersion } from "../../queries"

// A video's MP4, as its header shows it. The server renders it scene by scene when someone asks,
// and keeps it: the header reads where it stands without asking, asks when the reader exports it,
// and watches it render until it is ready to download. A version the reader has not exported, of
// which the version before it was, offers that one's MP4 as out of date.

/** How often a rendering export is asked about. */
const WATCH_MS = 2_000

/** Where a version's MP4 stands, as the header shows it. */
export type VideoExportView =
  /** Not read yet. */
  | { readonly state: "loading" }
  /** Nobody asked, or nothing is rendered yet; `earlier` is the version before it, exported. */
  | { readonly state: "idle"; readonly earlier?: number }
  | {
      readonly state: "rendering"
      readonly ready: number
      readonly total: number
      readonly assembling: boolean
    }
  | { readonly state: "ready"; readonly durationMs: number; readonly sizeBytes: number }
  | { readonly state: "failed"; readonly reason: string }

/**
 * What the header shows of an answer: the server answers `rendering` for an export nobody asked
 * for as well, so one not asked for here, with nothing rendered, is idle.
 */
export function videoExportView(
  answer: ExportArtifactVideoResponse | undefined,
  asked: boolean,
  /** The version before it, when its MP4 is ready. */
  earlier?: number
): VideoExportView {
  if (!answer) return { state: "loading" }
  if (answer.status === "ready") {
    return { state: "ready", durationMs: answer.durationMs, sizeBytes: answer.sizeBytes }
  }
  if (answer.status === "failed") return { state: "failed", reason: answer.reason }

  const { ready, total, assembling } = answer.progress
  if (!asked && ready === 0 && !assembling) {
    return earlier === undefined ? { state: "idle" } : { state: "idle", earlier }
  }
  return { state: "rendering", ready, total, assembling }
}

/** Where the query cache keeps a version's MP4 answer. */
export function videoExportQueryKey(artifactId: string, version: number): readonly unknown[] {
  return ["artifact-video-export", artifactId, version]
}

/**
 * A version's MP4: where it stands, watched while it renders, and `start` to ask for it, again
 * when it failed. `earlier` is the version before it, read only while this one is idle.
 */
export function useVideoExport(version: Pick<ArtifactVersion, "artifactId" | "version">) {
  const cache = useQueryClient()
  const [asked, setAsked] = useState(false)
  const read = (number: number, render: boolean) => async () =>
    (
      await exportArtifactVideo({
        path: { artifactId: version.artifactId, version: String(number) },
        query: render ? {} : { render: "false" },
        throwOnError: true,
      })
    ).data

  const current = useQuery({
    queryKey: videoExportQueryKey(version.artifactId, version.version),
    // Asked here, a look also asks again, which changes nothing unless its job was lost.
    queryFn: read(version.version, asked),
    refetchInterval: (query) => {
      const answer = query.state.data
      const watching =
        answer?.status === "rendering" &&
        (asked || answer.progress.ready > 0 || answer.progress.assembling)
      return watching ? WATCH_MS : false
    },
  })

  const idle =
    current.data?.status === "rendering" &&
    current.data.progress.ready === 0 &&
    !current.data.progress.assembling &&
    !asked
  const previous = version.version - 1
  const earlier = useQuery({
    queryKey: videoExportQueryKey(version.artifactId, previous),
    queryFn: read(previous, false),
    enabled: idle && previous >= 1,
    staleTime: 60_000,
  })

  const start = useCallback(async () => {
    setAsked(true)
    const failed = current.data?.status === "failed"
    const answer = (
      await exportArtifactVideo({
        path: { artifactId: version.artifactId, version: String(version.version) },
        query: failed ? { retry: "true" } : {},
        throwOnError: true,
      })
    ).data
    cache.setQueryData(videoExportQueryKey(version.artifactId, version.version), answer)
  }, [cache, current.data?.status, version.artifactId, version.version])

  const view = videoExportView(
    current.data,
    asked,
    earlier.data?.status === "ready" ? previous : undefined
  )
  return { view, start, error: current.error }
}
