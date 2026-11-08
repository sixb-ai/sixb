import { client, getArtifactVersion } from "@sixb/client"
import { BOARD_PREVIEW_WAIT_MS } from "@sixb/core/artifacts"
import { type Query, useQuery } from "@tanstack/react-query"
import type { ArtifactVersion } from "../../queries"

/**
 * Whether a board's picture can be shown: `ready`, `pending` while it is rendered, `none` when
 * none will come and the board shows its outline.
 */
export type BoardPreviewStatus = "ready" | "pending" | "none"

export type BoardPreviews = Readonly<Record<string, BoardPreviewStatus>>

const NO_PREVIEWS: BoardPreviews = {}

/** The first look again for pictures still rendered, and the longest between two. */
const FIRST_CHECK_MS = 2_000
const LONGEST_CHECK_MS = 30_000

/**
 * How long to wait before asking the version again which pictures are ready: never when none is
 * pending or the version is past the server's wait, else a little longer each time it is asked.
 */
export function nextPreviewCheck(
  previews: BoardPreviews,
  version: Pick<ArtifactVersion, "createdAt">,
  checks: number,
  now: number
): number | false {
  if (!Object.values(previews).includes("pending")) return false

  if (now - Date.parse(version.createdAt) >= BOARD_PREVIEW_WAIT_MS) return false

  return Math.min(LONGEST_CHECK_MS, FIRST_CHECK_MS * 1.5 ** checks)
}

/**
 * A canvas version's boards and whether each one's picture is ready, asked again while some are
 * rendered, as {@link nextPreviewCheck} says. Its own query, so the viewer's version stays as it
 * was read. Without a version, a canvas drawn on its own, no board has a picture.
 */
export function useBoardPreviews(version: ArtifactVersion | undefined): BoardPreviews {
  const query = useQuery({
    queryKey: ["artifact-board-previews", version?.artifactId, version?.version],
    queryFn: async () => {
      if (!version) return NO_PREVIEWS

      const { data } = await getArtifactVersion({
        path: { artifactId: version.artifactId, version: String(version.version) },
        throwOnError: true,
      })
      return data.boardPreviews ?? NO_PREVIEWS
    },
    initialData: version?.boardPreviews ?? NO_PREVIEWS,
    enabled: version !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchInterval: (current: Query<BoardPreviews>) =>
      version
        ? nextPreviewCheck(
            current.state.data ?? NO_PREVIEWS,
            version,
            current.state.dataUpdateCount,
            Date.now()
          )
        : false,
  })

  return query.data
}

/** The widest a board's small picture is, in device pixels: 480, a third of a laptop's screen. */
export const SMALL_PREVIEW_WIDTH = 480

/** A board's picture at its own size, or one at most {@link SMALL_PREVIEW_WIDTH} wide. */
export type BoardPreviewSize = "small" | "full"

/**
 * The picture a board's tile shows, from how wide it is on screen: the small one while that
 * covers it pixel for pixel, the full one past it, so a canvas fitted to a hundred boards holds a
 * hundred small pictures, not a hundred screens.
 */
export function boardPreviewSize(screenWidth: number, pixelRatio: number): BoardPreviewSize {
  return screenWidth * pixelRatio <= SMALL_PREVIEW_WIDTH ? "small" : "full"
}

/**
 * Where a board's picture is, in the reader's mode, at a size: the server picks the mode a canvas
 * pins, and the full size is its default.
 */
export function boardPreviewUrl(
  version: Pick<ArtifactVersion, "artifactId" | "version">,
  board: string,
  mode: "light" | "dark",
  size: BoardPreviewSize = "full"
): string {
  const artifact = `/api/artifacts/${encodeURIComponent(version.artifactId)}`
  const path = `${artifact}/versions/${version.version}/boards/${encodeURIComponent(board)}/preview`
  const url = new URL(path, client.getConfig().baseUrl || window.location.origin)
  url.searchParams.set("theme", mode)
  if (size === "small") url.searchParams.set("size", "small")
  return url.toString()
}
