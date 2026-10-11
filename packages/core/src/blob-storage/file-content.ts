import type { BlobInfo, BlobStorage, FileRef, OpenedFileRef } from "./types"
import { isFileRef } from "./validation"

/**
 * A file is served only through the record that references it: the caller reads that record with
 * its own authority, resolves the FileRef inside it, then checks the FileRef against the stored
 * blob. File content routes and the SDK's `file().open()` share these steps.
 */

/** The FileRef at a JSON Pointer in an authorized record, or null when none is there. */
export function resolveFileRefAtPath(root: unknown, path: string): FileRef | null {
  const value = resolveJsonPointer(root, path)
  return isFileRef(value) ? value : null
}

/** The stored blob a FileRef names, or null when it is absent or no longer matches it. */
export async function statFileRef(
  blobStorage: Pick<BlobStorage, "stat">,
  fileRef: FileRef
): Promise<BlobInfo | null> {
  const stat = await blobStorage.stat(fileRef.blobId)
  return stat &&
    stat.blobId === fileRef.blobId &&
    stat.digest === fileRef.digest &&
    stat.sizeBytes === fileRef.sizeBytes
    ? stat
    : null
}

/**
 * Open a FileRef resolved from an authorized record, or return null when its blob is gone. The
 * blob itself is opened on the body's first read, so a body nobody reads holds nothing.
 */
export async function openFileRef(
  blobStorage: Pick<BlobStorage, "stat" | "open">,
  fileRef: FileRef
): Promise<OpenedFileRef | null> {
  const stat = await statFileRef(blobStorage, fileRef)
  if (!stat) return null
  return { fileRef, body: openOnFirstRead(blobStorage, fileRef.blobId) }
}

function openOnFirstRead(
  blobStorage: Pick<BlobStorage, "open">,
  blobId: string
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reader ??= (await blobStorage.open(blobId)).getReader()
        const { done, value } = await reader.read()
        if (done) controller.close()
        else controller.enqueue(value)
      },
      async cancel(reason) {
        await reader?.cancel(reason)
      },
    },
    // No read-ahead: the first pull waits for the first read.
    { highWaterMark: 0 }
  )
}

/** Escape one segment of a JSON Pointer. */
export function jsonPointerSegment(segment: string | number): string {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1")
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === "") {
    return root
  }

  if (!pointer.startsWith("/")) {
    return undefined
  }

  let current = root
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodeJsonPointerSegment(rawSegment)
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10)
      if (!Number.isInteger(index) || index < 0 || index.toString() !== segment) {
        return undefined
      }
      if (!Object.hasOwn(current, segment)) {
        return undefined
      }
      current = current[index]
      continue
    }

    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return undefined
    }

    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~")
}
