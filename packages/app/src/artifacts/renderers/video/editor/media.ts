import { type GetArtifactMediaResponse, getArtifactMedia } from "@sixb/client"
import { useQueries, useQuery } from "@tanstack/react-query"
import { apiFileUrl } from "../../../file-source"
import type { ArtifactVersion } from "../../../queries"
import { readMediaPart } from "../../../waveform"
import { importKind } from "./import"
import { readTranscript, type Transcript } from "./transcript"

// What the editor reads of a recording of the video: how long it is, its filmstrip, its sound's
// peaks, its cuts and its transcript, as Sixb derives them once the version holds it. A recording
// the reader just imported is in the live document before a version holds it, and its parts are
// derived after: until then it reads as processing. What is still being derived is asked for
// again every few seconds, and nothing more once every part is ready or will not come.

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
  /** Some part is still being derived, and is asked for again. */
  readonly pending: boolean
  /** Why the recording cannot be read at all, as the server says it. */
  readonly failed?: string
  readonly durationMs?: number
  readonly filmstrip?: Filmstrip
  readonly waveform?: string
  readonly cuts: readonly number[]
  readonly transcript: PartState
  readonly transcriptUrl?: string
  /** Why the transcript will not come, as the server says it. */
  readonly transcriptReason?: string
  /** What the project lacks for the transcript to come, when that is why. */
  readonly transcriptLacks?: "sandboxes" | "sandbox_tools" | "transcription_model"
}

/** A recording not read yet: imported, and saved in a moment. */
const NOTHING: MediaParts = {
  processing: true,
  pending: true,
  cuts: [],
  transcript: "processing",
}

/** A file with nothing derived of it, such as a picture: nothing to wait for. */
const UNDERIVED: MediaParts = {
  processing: false,
  pending: false,
  cuts: [],
  transcript: "unavailable",
}

/** Where a recording's parts are read from: the open version of the video, and the files it holds. */
export interface MediaTarget {
  readonly artifactId: string
  readonly version: number
  /** A recording not among them is imported, and not saved yet. */
  readonly files: ArtifactVersion["files"]
}

/** What is derived of a recording of the video, as it comes. */
export function useMediaParts(target: MediaTarget | null, path: string | undefined): MediaParts {
  const asked = askMediaParts(target, path)
  const query = useQuery(asked.query)
  return asked.read(query.data)
}

/** What is derived of each of these recordings, as it comes, in their order. */
export function useMediaPartsOf(target: MediaTarget, paths: readonly string[]): MediaParts[] {
  const unique = [...new Set(paths)]
  const asked = unique.map((path) => askMediaParts(target, path))
  const queries = useQueries({ queries: asked.map((each) => each.query) })
  return paths.map((path) => {
    const index = unique.indexOf(path)
    return asked[index]?.read(queries[index]?.data) ?? NOTHING
  })
}

/** How a recording's parts are asked for, and read once they come. */
function askMediaParts(target: MediaTarget | null, path: string | undefined) {
  const held = target && path ? target.files.find((file) => file.path === path) : undefined
  // Only videos and sounds have parts: a picture has none to read.
  const kind = held ? importKind({ type: held.file.mediaType ?? "", name: held.path }) : null
  const recording = kind === "video" || kind === "audio"

  return {
    query: {
      queryKey: [
        "artifact-media",
        target?.artifactId,
        target?.version,
        path,
        held?.file.digest,
        "editor",
      ],
      queryFn: async ({ signal }: { readonly signal: AbortSignal }): Promise<MediaParts> => {
        if (!target || !path) return NOTHING
        const { data, response } = await getArtifactMedia({
          path: { artifactId: target.artifactId, version: String(target.version) },
          query: { path },
          signal,
        })
        // The version holds no recording there: nothing will come of asking again.
        if (!data || !response.ok) return UNDERIVED
        return readMediaParts(data)
      },
      enabled: !!target && !!path && recording,
      staleTime: 30_000,
      retry: false,
      refetchInterval: (state: { readonly state: { readonly data: MediaParts | undefined } }) =>
        pollAgainIn(state.state.data),
    },
    read: (data: MediaParts | undefined): MediaParts =>
      held && !recording ? UNDERIVED : (data ?? NOTHING),
  }
}

/**
 * When a recording's parts are asked for again: while one is still being derived, never once each
 * is ready or will not come, as a sound's filmstrip or a broken recording's every part.
 */
export function pollAgainIn(parts: MediaParts | undefined): number | false {
  return parts?.pending ? PENDING_POLL_MS : false
}

/** What the editor shows of what the server derived of a recording. */
export function readMediaParts(data: GetArtifactMediaResponse): MediaParts {
  const { probe, filmstrip, waveform, cuts, transcript } = data.parts
  const pending = Object.values(data.parts).some((part) => part.status === "pending")
  return {
    processing: pending && probe.status !== "ready",
    pending,
    ...(probe.status === "failed" ? { failed: probe.reason } : {}),
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
    ...(transcript.status === "unavailable" && transcript.lacks
      ? { transcriptLacks: transcript.lacks }
      : {}),
  }
}

/** A recording's transcript, as {@link readTranscript} reads its file, once read. */
export function useTranscript(url: string | undefined): {
  readonly transcript: Transcript | undefined
  readonly failed: boolean
} {
  const query = useQuery(askTranscript(url))
  return { transcript: query.data, failed: query.isError }
}

/** The transcripts of these recordings, as {@link useTranscript} reads each, in their order. */
export function useTranscriptsOf(urls: readonly (string | undefined)[]): {
  readonly transcript: Transcript | undefined
  readonly failed: boolean
}[] {
  const unique = [...new Set(urls)]
  const queries = useQueries({ queries: unique.map(askTranscript) })
  return urls.map((url) => {
    const query = queries[unique.indexOf(url)]
    return { transcript: query?.data, failed: query?.isError ?? false }
  })
}

function askTranscript(url: string | undefined) {
  return {
    queryKey: ["artifact-media-transcript", url],
    queryFn: async ({ signal }: { readonly signal: AbortSignal }): Promise<Transcript> =>
      readTranscript(await readMediaPart(url ?? "", signal)),
    enabled: !!url,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  }
}
