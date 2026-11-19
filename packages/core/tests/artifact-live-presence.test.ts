import { describe, expect, test } from "bun:test"
import type { ArtifactFile, Principal } from "../src"
import { changedBoards } from "../src/artifacts/live/presence"
import type { CanvasOutline } from "../src/artifacts/outline"
import { withBoardRenderKeys } from "../src/artifacts/publish/previews"

const alice: Principal = { type: "user", id: "alice" }
const bob: Principal = { type: "user", id: "bob" }

const file = (path: string, digit: string): ArtifactFile => ({
  path,
  file: {
    blobId: `blob_${digit.repeat(64)}`,
    digest: `sha256:${digit.repeat(64)}`,
    sizeBytes: 1,
    fileName: path.split("/").at(-1) ?? path,
    mediaType: "text/html",
  },
})

const outline: CanvasOutline = {
  kind: "canvas",
  items: [
    { id: "welcome", type: "board", file: "boards/welcome.html", w: 390, h: 844 },
    { id: "plan", type: "board", file: "boards/plan.html", w: 390, h: 844 },
  ],
}

/** A version as it is stored: each board named by its render key. */
const version = (author: Principal, files: readonly ArtifactFile[]) => ({
  artifactId: "art_onboarding",
  ...withBoardRenderKeys({ author, outline, files }, "art_onboarding"),
})

describe("the boards an Agent turn changes", () => {
  // Guard proof: compare the render keys each version was stored with in changedBoards. Alice's
  // live edit stored the version before, the turn writes as Bob, and every board's key names its
  // author: the untouched plan is then said to be changing too.
  test("are the ones it rewrote, whoever wrote the version before", () => {
    const before = version(alice, [file("boards/welcome.html", "1"), file("boards/plan.html", "2")])
    const after = version(bob, [file("boards/welcome.html", "3"), file("boards/plan.html", "2")])

    expect(changedBoards(before, after)).toEqual(["welcome"])
    expect(changedBoards(after, after)).toEqual([])
    expect(changedBoards(null, after)).toEqual(["welcome", "plan"])
  })
})

describe("the scenes of a video a turn changes", () => {
  const video = (keys: Readonly<Record<string, string>>) => ({
    artifactId: "art_teaser",
    author: alice,
    files: [],
    outline: {
      kind: "video" as const,
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: 9000,
      scenes: Object.entries(keys).map(([id, renderKey], index) => ({
        id,
        startMs: index * 3000,
        durationMs: 3000,
        renderKey,
      })),
    },
  })

  test("are those whose render key moved, or that are new", () => {
    const before = video({ hook: "k1", demo: "k2" })
    const after = video({ hook: "k1", demo: "k3", outro: "k4" })

    expect(changedBoards(before, after)).toEqual(["demo", "outro"])
    expect(changedBoards(after, after)).toEqual([])
  })
})
