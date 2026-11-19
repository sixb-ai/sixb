import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"

// A sound's waveform, from the peaks Sixb derives of every video and sound: a JSON file of its
// loudness, `peaksPerSecond` values a second. The video editor draws it along a clip, and the sound
// player behind its track.

/** A sound's peaks, from 0 to 100, `peaksPerSecond` of them a second. */
export interface Peaks {
  readonly peaksPerSecond: number
  readonly peaks: readonly number[]
  /** The loudest of them, which a waveform scales to. */
  readonly loudest: number
}

/** The peaks a waveform's file holds, once read. */
export function usePeaks(url: string | undefined): Peaks | undefined {
  return useQuery({
    queryKey: ["artifact-media-peaks", url],
    queryFn: async ({ signal }): Promise<Peaks> => {
      const body = await readMediaPart(url ?? "", signal)
      const peaks = Array.isArray(body.peaks) ? body.peaks.filter(isNumber) : []
      const peaksPerSecond = isNumber(body.peaksPerSecond) ? body.peaksPerSecond : 50
      const loudest = peaks.reduce((max, peak) => Math.max(max, peak), 1)
      return { peaksPerSecond, peaks, loudest }
    },
    enabled: !!url,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  }).data
}

/** A part Sixb derived of a media that is JSON, such as its peaks or its transcript, once read. */
export async function readMediaPart(
  url: string,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const response = await fetch(url, { credentials: "include", signal })
  if (!response.ok) throw new Error(`[Sixb] ${url} answered ${response.status}.`)
  const body: unknown = await response.json()
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * A sound's peaks along `width` pixels at `zoom` pixels a second, from `fromMs` into its file: a
 * clip's on the video editor's timeline, or a whole file's behind its player's track.
 */
export function Waveform({
  url,
  fromMs,
  width,
  zoom,
  compact,
}: {
  readonly url: string
  readonly fromMs: number
  readonly width: number
  readonly zoom: number
  /** Under footage, a thin band at its foot. */
  readonly compact: boolean
}) {
  const peaks = usePeaks(url)
  if (!peaks) return null
  const bars = barsOf(peaks, fromMs, width, zoom)
  return (
    <svg
      aria-hidden="true"
      className={cn("absolute inset-x-0 bottom-0 w-full", compact ? "h-1/3" : "h-full")}
      viewBox={`0 0 ${Math.max(1, width)} 100`}
      preserveAspectRatio="none"
    >
      <path
        d={bars.map((bar, index) => `M${index * 2 + 1} ${50 - bar / 2}V${50 + bar / 2}`).join("")}
        stroke="currentColor"
        strokeOpacity={compact ? 0.5 : 0.7}
        strokeWidth={1.2}
      />
    </svg>
  )
}

/**
 * One bar every two pixels: the loudest peak under each, scaled to the file's loudest, so a quiet
 * recording still shows where it speaks and pauses.
 */
function barsOf(peaks: Peaks, fromMs: number, width: number, zoom: number): number[] {
  const bars: number[] = []
  const perPixel = peaks.peaksPerSecond / zoom
  const scale = 100 / peaks.loudest
  for (let x = 0; x < width; x += 2) {
    const first = Math.floor((fromMs / 1000) * peaks.peaksPerSecond + x * perPixel)
    const last = Math.max(first + 1, Math.floor(first + 2 * perPixel))
    let loudest = 0
    for (let index = first; index < last; index += 1) {
      loudest = Math.max(loudest, peaks.peaks[index] ?? 0)
    }
    bars.push(Math.max(2, loudest * scale * 0.9))
  }
  return bars
}
