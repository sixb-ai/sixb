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
