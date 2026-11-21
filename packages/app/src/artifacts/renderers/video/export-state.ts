import { type ExportArtifactVideoResponse, exportArtifactVideo, isSixbApiError } from "@sixb/client"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import type { ArtifactVersion } from "../../queries"

// A video's MP4, as its header shows it. The server renders it scene by scene when someone asks,
// and keeps it: the header reads where it stands without asking, asks when the reader exports it,
// and watches it render until it is ready to download, wherever it was asked for. A version no one
// exported, of which the version before it was, offers that one's MP4 as out of date. The open
// version changes under its number at each write: what the header knows of it is the revision's
// it read.
//
// Why an export failed is the reader's to hear once they asked, in words of their own: the
// server's reason, which names a scene or what the project's sandboxes lack, is a developer's.

/** How often a rendering export is asked about. */
const WATCH_MS = 2_000

/** Where a version's MP4 stands, as the header shows it. */
export type VideoExportView =
  /** Not read yet. */
  | { readonly state: "loading" }
  /** Not asked for; `earlier` is the version before it, exported. */
  | { readonly state: "idle"; readonly earlier?: number }
  | {
      readonly state: "rendering"
      readonly ready: number
      readonly total: number
      readonly assembling: boolean
    }
  | { readonly state: "ready"; readonly durationMs: number; readonly sizeBytes: number }
  /** Asked for here, and it failed: asking again may render it. */
  | { readonly state: "failed" }
  /** Asked for here, and the project cannot render videos: asking again cannot help. */
  | { readonly state: "unavailable" }

/**
 * What the header shows of an answer. The server answers `idle` for an export no one asked for,
 * and `rendering` for one someone asked for, here or on another device: the header shows it
 * rendering. One that failed, which the server keeps until someone asks again, is idle until the
 * reader asks here: exporting it asks anew.
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
  if (answer.status === "idle" || (answer.status === "failed" && !asked)) {
    return earlier === undefined ? { state: "idle" } : { state: "idle", earlier }
  }

  if (answer.status === "failed") return { state: answer.lacks ? "unavailable" : "failed" }

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

/** A version's MP4 as the header has it: where it stands, and `start` to ask for it. */
export type VideoExport = ReturnType<typeof useVideoExport>

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

  const currentKey = videoExportQueryKey(version.artifactId, version.version, version.revision)
  const current = useQuery({
    queryKey: currentKey,
    // Asked here, or watched while it renders wherever it was asked, a look also asks again: that
    // changes nothing unless its job was lost, which it then asks for anew. Whoever reads the
    // artifact may ask, as they may read where it stands.
    queryFn: () => {
      const watching =
        cache.getQueryData<ExportArtifactVideoResponse>(currentKey)?.status === "rendering"
      return read(version.version, asked || watching)()
    },
    refetchInterval: (query) => (query.state.data?.status === "rendering" ? WATCH_MS : false),
  })

  const idle = videoExportView(current.data, asked).state === "idle"
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
      // A project without sandboxes cannot render: the header says so, as for missing tools.
      if (isSixbApiError(error) && error.code === "video_unavailable") {
        return { data: { status: "failed", reason: error.message, lacks: "sandboxes" } as const }
      }
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
