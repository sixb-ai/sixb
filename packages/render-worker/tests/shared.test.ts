import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import type { Server } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { serve } = createRequire(import.meta.url)("../src/shared.cjs") as {
  readonly serve: (root: string) => Promise<Server>
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("the server a render opens its files from", () => {
  // Reproduce by dropping the media entries from TYPES in shared.cjs: each is served with no type.
  test("serves video, sound, and captions with their types", async () => {
    const root = mkdtempSync(join(tmpdir(), "sixb-render-serve-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const server = await serve(root)
    cleanups.push(() => server.close())
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.")

    for (const [file, type] of [
      ["clip.mp4", "video/mp4"],
      ["clip.webm", "video/webm"],
      ["clip.mov", "video/quicktime"],
      ["theme.mp3", "audio/mpeg"],
      ["voice.wav", "audio/wav"],
      ["captions.vtt", "text/vtt; charset=utf-8"],
    ] as const) {
      writeFileSync(join(root, file), "bytes")
      const response = await fetch(`http://127.0.0.1:${address.port}/${file}`)
      expect(response.headers.get("content-type"), file).toBe(type)
      await response.arrayBuffer()
    }
  })
})
