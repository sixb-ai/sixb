import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import type { Server } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The script as a render's sandbox runs it: a copy, required from where it was written. Required
// from `src`, it would be the text module the worker bundles once any test imported the worker's
// sandbox helpers, which import it as text, in the same process.
const scripts = mkdtempSync(join(tmpdir(), "sixb-render-scripts-"))
copyFileSync(join(import.meta.dir, "../src/shared.cjs"), join(scripts, "shared.cjs"))
const { serve } = createRequire(join(scripts, "shared.cjs"))("./shared.cjs") as {
  readonly serve: (root: string) => Promise<Server>
}
afterAll(() => rmSync(scripts, { recursive: true, force: true }))

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
      ["clip.mkv", "video/x-matroska"],
      ["theme.mp3", "audio/mpeg"],
      ["voice.wav", "audio/wav"],
      ["voice.oga", "audio/ogg"],
      ["voice.weba", "audio/webm"],
      ["captions.vtt", "text/vtt; charset=utf-8"],
      ["captions.srt", "application/x-subrip; charset=utf-8"],
    ] as const) {
      writeFileSync(join(root, file), "bytes")
      const response = await fetch(`http://127.0.0.1:${address.port}/${file}`)
      expect(response.headers.get("content-type"), file).toBe(type)
      await response.arrayBuffer()
    }
  })
})
