import { posix } from "node:path"
import type { ArtifactFile } from "../../../storage/artifacts/types"
import { CANVAS_FILE, type Canvas, parseCanvas } from "../../canvas"
import {
  type CanvasBox,
  type CanvasPoint,
  canvasArrowLine,
  canvasEndBox,
  canvasItemBox,
} from "../../canvas-display"
import { ARTIFACT_LIMITS } from "../../limits"
import type { CanvasOutline, CanvasOutlineItem } from "../../outline"
import type { ArtifactWarning } from "../../warnings"
import { type ArtifactBlobStorage, invalidArtifact, readArtifactText } from "../files"
import type { FoundReference } from "../references"
import { readHtmlReferences, refuseFrameAssetPaths } from "./html"

/**
 * Reads a canvas: `canvas.json`, then each board's HTML, which must be one of the version's files.
 * The addresses its embeds show and its boards use are returned to resolve, each at its item's id.
 * Boards that overlap, and notes or text drawn over a board, are warnings: the reader sees a page
 * covered.
 */
export async function validateCanvas(
  blobStorage: ArtifactBlobStorage,
  files: readonly ArtifactFile[]
): Promise<{
  readonly entry: string
  readonly outline: CanvasOutline
  readonly references: readonly FoundReference[]
  readonly warnings: readonly ArtifactWarning[]
}> {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const canvasFile = byPath.get(CANVAS_FILE)
  if (!canvasFile) {
    throw invalidArtifact(
      `A canvas is '${CANVAS_FILE}', listing its items, with the HTML files its boards show beside it.`
    )
  }
  refuseFrameAssetPaths(files, "the canvas")
  const parsed = parseCanvas(
    await readArtifactText(blobStorage, canvasFile, ARTIFACT_LIMITS.maxCanvasBytes)
  )
  if ("error" in parsed) throw invalidArtifact(parsed.error)
  const { canvas } = parsed

  const references: FoundReference[] = []
  for (const item of canvas.items) {
    if (item.type === "embed") references.push({ address: item.src, as: "embed", at: item.id })
    if (item.type !== "board") continue
    const file = byPath.get(posix.normalize(item.file))
    if (!file) {
      throw invalidArtifact(
        `${CANVAS_FILE} board '${item.id}' shows '${item.file}', which is not one of the canvas's files.`
      )
    }
    const rewriter = new HTMLRewriter()
    const { references: found, refusal } = readHtmlReferences(rewriter, () => item.id, item.file)
    rewriter.transform(await readArtifactText(blobStorage, file, ARTIFACT_LIMITS.maxBoardBytes))
    const refused = refusal()
    if (refused) throw invalidArtifact(`Board '${item.id}': ${refused}`)
    references.push(...found)
  }

  return {
    entry: CANVAS_FILE,
    outline: {
      kind: "canvas",
      items: canvas.items.flatMap((item): CanvasOutlineItem[] => {
        const title = item.type === "board" || item.type === "section" ? item.title : undefined
        const named = { id: item.id, ...(title ? { title } : {}) }
        if (item.type === "board") {
          return [
            { ...named, type: "board", file: posix.normalize(item.file), w: item.w, h: item.h },
          ]
        }
        return item.type === "section" ? [{ ...named, type: "section" }] : []
      }),
    },
    references,
    warnings: [...layoutWarnings(canvas), ...crossingArrowWarnings(canvas)],
  }
}

interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * What covers a board on the canvas: another board over it, or a note or a text whose top left
 * corner lands on it. A note's height follows its text, so only its corner is sure; a section
 * holds boards on purpose.
 */
function layoutWarnings(canvas: Canvas): ArtifactWarning[] {
  const boards = canvas.items.flatMap((item) => (item.type === "board" ? [item] : []))
  const warnings: ArtifactWarning[] = []
  boards.forEach((board, index) => {
    for (const other of boards.slice(index + 1)) {
      if (!overlaps(board, other)) continue
      warnings.push({
        code: "canvas_overlap",
        part: board.id,
        message: `Boards '${board.id}' and '${other.id}' overlap, so one covers the other's page: leave 80 pixels between boards in a row and 160 between rows.`,
      })
    }
  })
  for (const item of canvas.items) {
    if (item.type !== "note" && item.type !== "text") continue
    const corner = { x: item.x, y: item.y, w: 1, h: 1 }
    const board = boards.find((candidate) => overlaps(candidate, corner))
    if (!board) continue
    warnings.push({
      code: "canvas_covers_board",
      part: item.id,
      message: `${item.type === "note" ? "Note" : "Text"} '${item.id}' sits on board '${board.id}' and covers its page: put it beside the board, and an arrow to it when it is about the board.`,
    })
  }
  return warnings
}

/** The most arrows warned of one by one, and items named for one arrow. */
const MAX_CROSSING_ARROWS = 12
const MAX_CROSSED_ITEMS = 3

/**
 * Arrows drawn across other items: the straight line the app draws, from the edge of one end's box
 * to the edge of the other's, through a board, a note, a shape, a text, or an embed. Sections hold
 * what their arrows join, so an arrow crosses them on purpose. A row that wraps to the next is the
 * usual cause: its last item's arrow runs back across the row to the next one's first.
 */
function crossingArrowWarnings(canvas: Canvas): ArtifactWarning[] {
  const boxes = new Map(
    canvas.items.flatMap((item) => {
      const box = canvasItemBox(item)
      return box ? [[item.id, box] as const] : []
    })
  )
  const crossable = canvas.items.filter((item) => item.type !== "arrow" && item.type !== "section")

  const crossing = canvas.items.flatMap((arrow) => {
    if (arrow.type !== "arrow") return []
    const from = canvasEndBox(arrow.from, boxes)
    const to = canvasEndBox(arrow.to, boxes)
    if (!from || !to) return []

    const { start, end } = canvasArrowLine(from, to)
    const crossed = crossable.filter((item) => {
      const box = boxes.get(item.id)
      return item.id !== arrow.from && item.id !== arrow.to && box && crosses(start, end, box)
    })
    return crossed.length === 0 ? [] : [{ arrow, crossed }]
  })

  const warnings: ArtifactWarning[] = crossing
    .slice(0, MAX_CROSSING_ARROWS)
    .map(({ arrow, crossed }) => {
      const named = crossed.slice(0, MAX_CROSSED_ITEMS).map((item) => `${item.type} '${item.id}'`)
      const more = crossed.length - named.length
      return {
        code: "canvas_arrow_crosses",
        part: arrow.id,
        message: `Arrow '${arrow.id}' is drawn across ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}: join neighbours in a row with arrows, and let a sequence that wraps to the next row read on without one.`,
      }
    })
  const more = crossing.length - warnings.length
  if (more > 0) {
    warnings.push({
      code: "canvas_arrow_crosses",
      message: `${more} more arrow${more === 1 ? " is" : "s are"} drawn across other items.`,
    })
  }
  return warnings
}

/** Whether the segment from `start` to `end` passes through the inside of a box. */
function crosses(start: CanvasPoint, end: CanvasPoint, box: CanvasBox): boolean {
  // Liang-Barsky: clip the segment to the box, and see whether anything of it is left inside.
  const dx = end.x - start.x
  const dy = end.y - start.y
  let enter = 0
  let leave = 1
  const edges: readonly (readonly [number, number])[] = [
    [-dx, start.x - box.x],
    [dx, box.x + box.width - start.x],
    [-dy, start.y - box.y],
    [dy, box.y + box.height - start.y],
  ]
  for (const [direction, room] of edges) {
    if (direction === 0) {
      if (room <= 0) return false
      continue
    }
    const at = room / direction
    if (direction < 0) enter = Math.max(enter, at)
    else leave = Math.min(leave, at)
    if (enter >= leave) return false
  }
  return true
}
