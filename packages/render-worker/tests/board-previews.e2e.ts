import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  type ArtifactFile,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { createTestSixb } from "@sixb/core/testing"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { renderBoardPreviews } from "../src/board-previews"

// A canvas's boards pictured in a real headless Chromium, through Playwright for Node as the agent
// image ships it: at /opt/sixb/js/node_modules/playwright, or where SIXB_PLAYWRIGHT points (with
// SIXB_CHROMIUM naming a browser when Playwright has none of its own). Without either it skips.
//
//   SIXB_PLAYWRIGHT=<dir>/node_modules/playwright-core \
//   bun test ./packages/render-worker/tests/board-previews.e2e.ts
const IMAGE_PLAYWRIGHT = "/opt/sixb/js/node_modules/playwright"
const playwright =
  process.env.SIXB_PLAYWRIGHT ?? (existsSync(IMAGE_PLAYWRIGHT) ? IMAGE_PLAYWRIGHT : "")

/** A WebP's width and height, from its first chunk: lossy, lossless, or extended. */
function webpSize(bytes: Buffer): [number, number] {
  const chunk = bytes.subarray(12, 16).toString("latin1")
  if (chunk === "VP8 ") return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff]
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21)
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1]
  }
  return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1]
}

describe.skipIf(!playwright)("a canvas's boards pictured in a browser", () => {
  test(
    "in every theme and size, but none whose page did not load whole",
    async () => {
      // Reproduce the themes by sending only the first in picture.cjs: there is no dark picture of
      // any board. Reproduce the partial board by picturing every board: Pricing's picture,
      // unstyled for its missing stylesheet, is kept under its key and shown to every reader.
      const blobStorage = new InMemoryBlobStorage()
      const storage = new InMemoryStorage()
      const host = new SixbHost({
        id: "previews",
        ontology: [],
        storage,
        blobStorage,
        sandboxes: new LocalSandboxFactory({
          isolation: "none",
          env: {
            SIXB_PLAYWRIGHT: playwright,
            ...(process.env.SIXB_CHROMIUM ? { SIXB_CHROMIUM: process.env.SIXB_CHROMIUM } : {}),
          },
        }),
        queues: new InMemoryQueues(),
        broker: new InMemoryBroker(),
        lakeStorage: new InMemoryLakeStorage(),
      })
      const sixb = createTestSixb(host, {
        authorization: {
          principal: { type: "user", id: "alice" },
          groupIds: [],
          roleIds: [],
          grants: emptyGrantIndex(),
        },
      })
      const put = async (path: string, body: string): Promise<ArtifactFile> => ({
        path,
        file: await blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
      })
      const page = (head: string) =>
        `<!doctype html><html><head>${head}</head><body><main><h1>Plans</h1></main></body></html>`
      const { version } = await sixb.artifacts.create({
        kind: "canvas",
        title: "Pricing",
        files: [
          await put(
            "canvas.json",
            JSON.stringify({
              items: [
                { id: "plans", type: "board", file: "plans.html", x: 0, y: 0, w: 1280, h: 800 },
                {
                  id: "pricing",
                  type: "board",
                  file: "pricing.html",
                  x: 1400,
                  y: 0,
                  w: 390,
                  h: 844,
                },
              ],
            })
          ),
          await put("plans.html", page("")),
          await put("pricing.html", page('<link rel="stylesheet" href="missing.css">')),
        ],
      })

      await renderBoardPreviews({
        host,
        job: {
          id: "job",
          projectId: "previews",
          createdAt: new Date().toISOString(),
          availableAt: new Date().toISOString(),
          attempt: 1,
          type: "artifact.previews.requested",
          payload: {
            artifactId: version.artifactId,
            version: version.version,
            updatedAt: version.updatedAt.toISOString(),
          },
        },
        signal: AbortSignal.timeout(110_000),
      })

      const outline = version.outline
      if (outline.kind !== "canvas") throw new Error("Expected a canvas.")
      const keyOf = (id: string) => {
        const item = outline.items.find((each) => each.id === id)
        return item?.type === "board" ? (item.renderKey ?? "") : ""
      }
      const kept = await storage.artifacts.listBoardPreviews({
        projectId: "previews",
        renderKeys: [keyOf("plans"), keyOf("pricing")],
      })
      expect(kept.every((preview) => preview.renderKey === keyOf("plans"))).toBe(true)
      expect(kept.map(({ theme, size }) => `${theme} ${size}`).sort()).toEqual([
        "dark full",
        "dark small",
        "light full",
        "light small",
      ])

      const bytes = async (theme: string, size: string) => {
        const preview = kept.find((each) => each.theme === theme && each.size === size)
        if (!preview) throw new Error(`No ${size} picture in ${theme} mode.`)
        return Buffer.from(
          await new Response(await blobStorage.open(preview.file.blobId)).arrayBuffer()
        )
      }
      expect((await bytes("light", "full")).equals(await bytes("dark", "full"))).toBe(false)
      for (const theme of ["light", "dark"]) {
        const small = await bytes(theme, "small")
        expect(small.subarray(8, 12).toString("latin1")).toBe("WEBP")
        // A laptop's board, shrunk to 480 pixels wide, its aspect kept.
        expect(webpSize(small)).toEqual([480, 300])
      }
    },
    { timeout: 120_000 }
  )
})
