import { describe, expect, test } from "bun:test"
import { encodeBranchCopyPart, readBranchCopy } from "../src/branches/wire"

const lake = {
  credential: "sixb_branch_x",
  sliceId: "slice-1",
  point: "ducklake:9",
  token: "t",
  expiresAt: "2026-11-25T00:00:00.000Z",
}

/** The parts as a network delivers them: in chunks that cut through parts. */
async function* chunked(parts: readonly Uint8Array[], size: number) {
  const bytes = Buffer.concat(parts)
  for (let start = 0; start < bytes.length; start += size) yield bytes.subarray(start, start + size)
}

describe("a branch copy on the wire", () => {
  test("gives the snapshot, then the lake slice that follows it", async () => {
    const copy = readBranchCopy(
      chunked(
        [
          encodeBranchCopyPart("snapshot", new Uint8Array([1, 2, 3])),
          encodeBranchCopyPart("snapshot", new Uint8Array([4])),
          encodeBranchCopyPart("catalog", new Uint8Array([9, 9])),
          encodeBranchCopyPart("catalog", new Uint8Array([8])),
          encodeBranchCopyPart("lake", lake),
          encodeBranchCopyPart("end"),
        ],
        3
      )
    )

    const snapshot: number[] = []
    for await (const chunk of copy.snapshot) snapshot.push(...chunk)
    expect(snapshot).toEqual([1, 2, 3, 4])
    expect(await copy.rest()).toEqual({ lake, catalog: Buffer.from([9, 9, 8]) })
  })

  // Red check: in `readBranchCopy`, end the snapshot quietly when the parts run out, and drop
  // the check of what `readParts` has left.
  test("refuses a copy cut short", async () => {
    const whole = encodeBranchCopyPart("snapshot", new Uint8Array([1, 2, 3]))
    const copy = readBranchCopy(chunked([whole.subarray(0, 6)], 4))

    const refused = await (async () => {
      for await (const _ of copy.snapshot) void _
    })().catch((error: unknown) => error)
    expect(String(refused)).toContain("ended before it was complete")
  })
})
