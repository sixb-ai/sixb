import { type ExportArtifactVideoResponse, exportArtifactVideo } from "@sixb/client"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import type { ArtifactVersion } from "../../queries"

// A video's MP4, as its header shows it. The server renders it scene by scene when someone asks,
// and keeps it: the header reads where it stands without asking, asks when the reader exports it,
// and watches it render until it is ready to download. A version the reader has not exported, of
// which the version before it was, offers that one's MP4 as out of date. The open version changes
// under its number at each write: what the header knows of it is the revision's it read.

/** How often a rendering export is asked about. */
const WATCH_MS = 2_000

/** Where a version's MP4 stands, as the header shows it. */
export type VideoExportView =
  /** Not read yet. */
  | { readonly state: "loading" }
  /** Not asked for here; `earlier` is the version before it, exported. */
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
 * What the header shows of an answer. The server answers `rendering` for an export nobody asked
 * for as well, its parts rendered for another version counted, as an edit of one scene keeps the
 * others: one not asked for here is idle. Exporting it joins one already rendering.
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

  if (!asked) return earlier === undefined ? { state: "idle" } : { state: "idle", earlier }

  const { ready, total, assembling } = answer.progress
  return { state: "rendering", ready, total, assembling }
}

/**
 * Where the query cache keeps a version's MP4 answer: by its revision too, as the open version's
 * content changes under its number. A version before it is frozen, and its number names it.
 */
export function videoExportQueryKey(
  artifactId: string,
  version: number,
  revision?: number
): readonly unknown[] {
  return ["artifact-video-export", artifactId, version, revision ?? "frozen"]
}

/**
 * A version's MP4: where it stands, watched while it renders, and `start` to ask for it, again
 * when it failed. `earlier` is the version before it, read only while this one is idle.
 */
export function useVideoExport(
  version: Pick<ArtifactVersion, "artifactId" | "version" | "revision">
) {
  const cache = useQueryClient()
  // Which version the reader exported, as it read: the header stays as another version opens in
  // it, or as a write changes this one.
  const [exported, setExported] = useState<string | null>(null)
  const marker = `${version.artifactId}@${version.version}#${version.revision}`
  const asked = exported === marker
  const read = (number: number, render: boolean) => async () =>
    (
      await exportArtifactVideo({
        path: { artifactId: version.artifactId, version: String(number) },
        query: render ? {} : { render: "false" },
        throwOnError: true,
      })
    ).data

  const current = useQuery({
    queryKey: videoExportQueryKey(version.artifactId, version.version, version.revision),
    // Asked here, a look also asks again, which changes nothing unless its job was lost.
    queryFn: read(version.version, asked),
    refetchInterval: (query) =>
      asked && query.state.data?.status === "rendering" ? WATCH_MS : false,
  })

  const idle = current.data?.status === "rendering" && !asked
  const previous = version.version - 1
  const earlier = useQuery({
    queryKey: videoExportQueryKey(version.artifactId, previous),
    queryFn: read(previous, false),
    enabled: idle && previous >= 1,
    staleTime: 60_000,
  })

  const start = useCallback(async () => {
    setExported(marker)
    const failed = current.data?.status === "failed"
    const answer = await exportArtifactVideo({
      path: { artifactId: version.artifactId, version: String(version.version) },
      query: failed ? { retry: "true" } : {},
      throwOnError: true,
    }).catch((error: unknown) => {
      // Not asked after all: the header offers to export it again.
      setExported((current) => (current === marker ? null : current))
      throw error
    })
    cache.setQueryData(
      videoExportQueryKey(version.artifactId, version.version, version.revision),
      answer.data
    )
  }, [cache, current.data?.status, marker, version.artifactId, version.version, version.revision])

  const view = videoExportView(
    current.data,
    asked,
    earlier.data?.status === "ready" ? previous : undefined
  )
  return { view, start, error: current.error }
}
