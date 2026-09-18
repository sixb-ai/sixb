import { describe, expect, test } from "bun:test"
import { computeBlobDigest } from "@sixb/core/blob-storage/server"
import { uploadBlocks } from "../src/block-upload"

const encoder = new TextEncoder()

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("Azure block upload", () => {
  test("accepts 50,000 blocks and cancels unknown-length input at the next block", async () => {
    // Regression check: remove stage's MAX_BLOCKS guard. The oversized stream
    // then succeeds instead of cancelling its producer and rejecting.
    for (const count of [50_000, 50_001]) {
      let cancelled = false
      let staged = 0
      const bytes = new Uint8Array(count).fill(17)
      const upload = uploadBlocks({
        stream: new ReadableStream<Uint8Array>(
          {
            start(controller) {
              controller.enqueue(bytes)
              if (count === 50_000) controller.close()
            },
            pull(controller) {
              controller.close()
            },
            cancel() {
              cancelled = true
            },
          },
          { highWaterMark: 0 }
        ),
        blockSizeBytes: 1,
        concurrency: 2,
        stage: async () => {
          staged++
        },
      })
      if (count === 50_000) {
        const result = await upload
        expect(result.blockIds).toHaveLength(count)
        expect(new Set(result.blockIds).size).toBe(count)
        expect(result.digest).toBe(computeBlobDigest(bytes))
      } else {
        await expect(upload).rejects.toThrow("50,000 blocks")
        expect(cancelled).toBe(true)
      }
      expect(staged).toBe(50_000)
    }
  })

  test("bounds in-flight blocks and preserves source order across out-of-order completion", async () => {
    // Regression check: remove waitForCapacity's active-size wait. This test then
    // observes more than two active uploads before the gates are released.
    const gates = [deferred(), deferred()]
    const started = deferred()
    const bytes = encoder.encode("abcdefghijklmnopq")
    const blocks = new Map<string, Uint8Array>()
    let active = 0
    let maximumActive = 0
    let calls = 0
    const upload = uploadBlocks({
      stream: new Blob([bytes]).stream(),
      blockSizeBytes: 4,
      concurrency: 2,
      stage: async (id, body) => {
        const index = calls++
        blocks.set(id, body.slice())
        active++
        maximumActive = Math.max(maximumActive, active)
        if (index === 1) started.resolve()
        if (gates[index]) await gates[index]!.promise
        active--
      },
    })
    await started.promise
    // Drain producer microtasks while both requests are held at the gates.
    await Bun.sleep(0)
    try {
      expect(calls).toBe(2)
    } finally {
      gates[1]!.resolve()
      gates[0]!.resolve()
    }
    const result = await upload
    expect(maximumActive).toBe(2)
    expect(result.sizeBytes).toBe(bytes.length)
    expect(result.digest).toBe(computeBlobDigest(bytes))
    expect(
      new Uint8Array(
        await new Blob(result.blockIds.map((id) => new Uint8Array(blocks.get(id)!))).arrayBuffer()
      )
    ).toEqual(bytes)
  })

  test("a failed block cancels a stalled producer and aborts other requests", async () => {
    const failure = deferred()
    const started = deferred()
    let cancelled = false
    let otherAborted = false
    let calls = 0
    const upload = uploadBlocks({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("abcdefgh"))
        },
        cancel() {
          cancelled = true
        },
      }),
      blockSizeBytes: 4,
      concurrency: 3,
      stage: async (_id, _bytes, signal) => {
        if (calls++ === 0) {
          await failure.promise
          throw new Error("block failed")
        }
        started.resolve()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              otherAborted = true
              reject(signal.reason)
            },
            { once: true }
          )
        })
      },
    })
    await started.promise
    failure.resolve()
    await expect(upload).rejects.toThrow("block failed")
    expect(cancelled).toBe(true)
    expect(otherAborted).toBe(true)
  })

  test("aborts a stalled reader and preserves the caller's abort reason", async () => {
    const controller = new AbortController()
    const reading = deferred()
    let cancelled = false
    const upload = uploadBlocks({
      stream: new ReadableStream<Uint8Array>({
        pull() {
          reading.resolve()
        },
        cancel() {
          cancelled = true
        },
      }),
      blockSizeBytes: 4,
      concurrency: 2,
      signal: controller.signal,
      stage: async () => {
        throw new Error("must not upload")
      },
    })
    await reading.promise
    controller.abort(new Error("caller cancelled"))
    await expect(upload).rejects.toThrow("caller cancelled")
    expect(cancelled).toBe(true)
  })

  test("pre-abort cancels the input without staging bytes", async () => {
    let cancelled = false
    const controller = new AbortController()
    controller.abort(new Error("already aborted"))
    await expect(
      uploadBlocks({
        stream: new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        }),
        blockSizeBytes: 4,
        concurrency: 2,
        signal: controller.signal,
        stage: async () => {
          throw new Error("must not upload")
        },
      })
    ).rejects.toThrow("already aborted")
    expect(cancelled).toBe(true)
  })

  test("rejects short and long input and waits for failed work to settle", async () => {
    for (const expectedSizeBytes of [3, 10]) {
      let finished = false
      await expect(
        uploadBlocks({
          stream: new Blob(["abcdefgh"]).stream(),
          blockSizeBytes: 4,
          concurrency: 2,
          expectedSizeBytes,
          stage: async () => {
            await Promise.resolve()
            finished = true
          },
        })
      ).rejects.toThrow("size mismatch")
      expect(finished).toBe(expectedSizeBytes === 10)
    }
  })
})
