import { posix } from "node:path"
import type { ArtifactFile } from "../../../storage/artifacts/types"
import { CANVAS_FILE, parseCanvas } from "../../canvas"
import { ARTIFACT_LIMITS } from "../../limits"
import type { CanvasOutline, CanvasOutlineItem } from "../../outline"
import { type ArtifactBlobStorage, invalidArtifact, readArtifactText } from "../files"
import type { FoundReference } from "../references"
import { readHtmlReferences, refuseFrameAssetPaths } from "./html"

/**
 * Reads a canvas: `canvas.json`, then each board's HTML, which must be one of the version's files.
 * The addresses its embeds show and its boards use are returned to resolve, each at its item's id.
 */
export async function validateCanvas(
  blobStorage: ArtifactBlobStorage,
  files: readonly ArtifactFile[]
): Promise<{
  readonly entry: string
  readonly outline: CanvasOutline
  readonly references: readonly FoundReference[]
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
  }
}
