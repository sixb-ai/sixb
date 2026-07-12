import { describe, expect, test } from "bun:test"
import { blobIdFromDigest, computeBlobDigest } from "../blob-storage"
import type { BlobStorage } from "../blob-storage/types"

export interface BlobStorageContractSuiteOptions<TStorage extends BlobStorage = BlobStorage> {
  /** Factory that produces an isolated storage instance for each test case. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  /** Optional cleanup invoked after every test case. */
  readonly teardown?: (storage: TStorage) => void | Promise<void>
}

/** Runs the shared content, streaming, size-validation, and cancellation contract. */
export function runBlobStorageContractSuite<TStorage extends BlobStorage>(
  label: string,
  options: BlobStorageContractSuiteOptions<TStorage>
): void {
  const encoder = new TextEncoder()

  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await body(storage)
    } finally {
      await options.teardown?.(storage)
    }
  }

  describe(label, () => {
    test("streams bodies into stable content-addressed references", async () => {
      await withStorage(async (storage) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("streamed "))
            controller.enqueue(encoder.encode("body"))
            controller.close()
          },
        })

        const fileRef = await storage.put({
          body,
          expectedSizeBytes: 13,
          fileName: "report.bin",
          mediaType: "application/octet-stream",
          logicalPath: "reports/report.bin",
        })

        expect(fileRef.sizeBytes).toBe(13)
        expect(fileRef.blobId).toBe(blobIdFromDigest(fileRef.digest))
        expect(fileRef.fileName).toBe("report.bin")
        expect(fileRef.mediaType).toBe("application/octet-stream")
        expect(fileRef.logicalPath).toBe("reports/report.bin")
        expect(await new Response(await storage.open(fileRef.blobId)).text()).toBe("streamed body")
      })
    })

    test("rejects an expected size mismatch without publishing a blob", async () => {
      await withStorage(async (storage) => {
        const bytes = encoder.encode("wrong size")
        const blobId = blobIdFromDigest(computeBlobDigest(bytes))

        await expect(
          storage.put({ body: bytes, expectedSizeBytes: bytes.byteLength + 1 })
        ).rejects.toThrow(
          `Blob size mismatch: expected ${bytes.byteLength + 1} bytes, received ${bytes.byteLength}.`
        )
        await expect(storage.stat(blobId)).resolves.toBeNull()
      })
    })

    test("rejects invalid expected sizes", async () => {
      await withStorage(async (storage) => {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.close()
          },
        })

        await expect(storage.put({ body, expectedSizeBytes: -1 })).rejects.toThrow(
          "expectedSizeBytes must be a non-negative safe integer"
        )
      })
    })

    test("cancels an active body without publishing partial bytes", async () => {
      await withStorage(async (storage) => {
        const abort = new AbortController()
        let bodyCancelled = false
        const firstChunk = encoder.encode("partial")
        const blobId = blobIdFromDigest(computeBlobDigest(firstChunk))
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(firstChunk)
          },
          cancel() {
            bodyCancelled = true
          },
        })

        const put = storage.put({ body, signal: abort.signal })
        abort.abort(new Error("cancel blob put"))

        await expect(put).rejects.toThrow("cancel blob put")
        expect(bodyCancelled).toBe(true)
        await expect(storage.stat(blobId)).resolves.toBeNull()
      })
    })
  })
}
