import { getArtifactMedia } from "@sixb/client"
import { useQuery } from "@tanstack/react-query"
import { apiFileUrl } from "../../../file-source"
import type { TranscriptWord } from "./transcript"

// What the editor reads of a recording of the video: how long it is, its filmstrip, its sound's
// peaks, its cuts and its transcript, as Sixb derives them once the version holds it. A recording
// the reader just imported is in the live document before a version holds it, and its parts are
// derived after: until then it reads as processing, asked again every few seconds.

/** How often what is still being derived is asked for again. */
const PENDING_POLL_MS = 4_000

/** The filmstrip: thumbnails at a fixed interval, laid out in one picture, row by row. */
export interface Filmstrip {
  readonly url: string
  readonly intervalMs: number
  readonly count: number
  readonly columns: number
  /** One thumbnail's size, in pixels. */
  readonly width: number
  readonly height: number
}

/** Where a part of a recording stands for the editor. */
export type PartState = "ready" | "processing" | "unavailable"

export interface MediaParts {
  /** Read, or still being read or derived. */
  readonly processing: boolean
  readonly durationMs?: number
  readonly filmstrip?: Filmstrip
  readonly waveform?: string
  readonly cuts: readonly number[]
  readonly transcript: PartState
  readonly transcriptUrl?: string
  /** Why the transcript will not come, as the server says it. */
  readonly transcriptReason?: string
}

const NOTHING: MediaParts = { processing: true, cuts: [], transcript: "processing" }

/** Where a recording's parts are read from: the open version of the video, and its path. */
export interface MediaTarget {
  readonly artifactId: string
  readonly version: number
}

/** What is derived of a recording of the video, as it comes. */
export function useMediaParts(target: MediaTarget | null, path: string | undefined): MediaParts {
  const query = useQuery({
    queryKey: ["artifact-media", target?.artifactId, target?.version, path, "editor"],
    queryFn: async ({ signal }): Promise<MediaParts> => {
      if (!target || !path) return NOTHING
      const { data, response } = await getArtifactMedia({
        path: { artifactId: target.artifactId, version: String(target.version) },
        query: { path },
        signal,
      })
      // Not in the version yet: imported, and saved in a moment.
      if (!data || !response.ok) return NOTHING

      const { probe, filmstrip, waveform, cuts, transcript } = data.parts
      const pending = Object.values(data.parts).some((part) => part.status === "pending")
      return {
        processing: pending && probe.status !== "ready",
        ...(probe.status === "ready" ? { durationMs: probe.durationMs } : {}),
        ...(filmstrip.status === "ready"
          ? {
              filmstrip: {
                url: apiFileUrl(filmstrip.url),
                intervalMs: filmstrip.intervalMs,
                count: filmstrip.count,
                columns: filmstrip.columns,
                width: filmstrip.width,
                height: filmstrip.height,
              },
            }
          : {}),
        ...(waveform.status === "ready" ? { waveform: apiFileUrl(waveform.url) } : {}),
        cuts: cuts.status === "ready" ? cuts.atMs : [],
        transcript:
          transcript.status === "ready"
            ? "ready"
            : transcript.status === "pending"
              ? "processing"
              : "unavailable",
        ...(transcript.status === "ready" ? { transcriptUrl: apiFileUrl(transcript.url) } : {}),
        ...(transcript.status === "unavailable" || transcript.status === "failed"
          ? { transcriptReason: transcript.reason }
          : {}),
      }
    },
    enabled: !!target && !!path,
    staleTime: 30_000,
    retry: false,
    refetchInterval: (state) => {
      const data = state.state.data
      return !data || data.processing || data.transcript === "processing" || !data.filmstrip
        ? PENDING_POLL_MS
        : false
    },
  })
  return query.data ?? NOTHING
}

/** A sound's peaks, from 0 to 100, `peaksPerSecond` of them a second. */
export interface Peaks {
  readonly peaksPerSecond: number
  readonly peaks: readonly number[]
}

/** The peaks a waveform's file holds, once read. */
export function usePeaks(url: string | undefined): Peaks | undefined {
  return useQuery({
    queryKey: ["artifact-media-peaks", url],
    queryFn: async ({ signal }): Promise<Peaks> => {
      const body = await readJson(url ?? "", signal)
      const peaks = Array.isArray(body.peaks) ? body.peaks.filter(isNumber) : []
      const peaksPerSecond = isNumber(body.peaksPerSecond) ? body.peaksPerSecond : 50
      return { peaksPerSecond, peaks }
    },
    enabled: !!url,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  }).data
}

/** The words a transcript's file holds, in spoken order, once read. */
export function useTranscriptWords(url: string | undefined): {
  readonly words: readonly TranscriptWord[] | undefined
  readonly failed: boolean
} {
  const query = useQuery({
    queryKey: ["artifact-media-transcript", url],
    queryFn: async ({ signal }): Promise<readonly TranscriptWord[]> => {
      const body = await readJson(url ?? "", signal)
      const words = Array.isArray(body.words) ? body.words : []
      return words.flatMap((word: unknown) => {
        if (typeof word !== "object" || word === null) return []
        const { text, startMs, endMs } = word as Record<string, unknown>
        if (typeof text !== "string" || !isNumber(startMs) || !isNumber(endMs)) return []
        return [{ text: text.trim(), startMs, endMs: Math.max(endMs, startMs) }]
      })
    },
    enabled: !!url,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  })
  return { words: query.data, failed: query.isError }
}

async function readJson(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, { credentials: "include", signal })
  if (!response.ok) throw new Error(`[Sixb] ${url} answered ${response.status}.`)
  const body: unknown = await response.json()
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * A scene's still, a picture of its middle, once the export snapshots it. Until then the address
 * answers nothing, and whoever shows it falls back on a frame of the scene's footage.
 */
export function sceneStillUrl(target: MediaTarget, scene: string): string {
  return apiFileUrl(
    `/api/artifacts/${encodeURIComponent(target.artifactId)}/versions/${target.version}/scenes/${encodeURIComponent(scene)}/still`
  )
}
