import { rename, rm } from "node:fs/promises"

/**
 * Write a snapshot to a file, for a branch on another machine to import. It is written beside the
 * file first and renamed once complete, so the path never holds part of a snapshot.
 */
export async function writeSnapshotFile(
  path: string,
  snapshot: AsyncIterable<Uint8Array>
): Promise<{ readonly bytes: number }> {
  const partial = `${path}.partial`
  const sink = Bun.file(partial).writer({ highWaterMark: 4 * 1024 * 1024 })
  let bytes = 0

  try {
    for await (const chunk of snapshot) {
      sink.write(chunk)
      bytes += chunk.length
      if (bytes % (16 * 1024 * 1024) < chunk.length) await sink.flush()
    }
    await sink.end()
    await rename(partial, path)
  } catch (error) {
    await Promise.resolve(sink.end()).catch(() => undefined)
    await rm(partial, { force: true })
    throw error
  }

  return { bytes }
}

/** A snapshot file's bytes, as an importer reads them. */
export async function* readSnapshotFile(path: string): AsyncGenerator<Uint8Array> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`[Sixb] No snapshot at '${path}': take one first.`)
  }

  yield* file.stream()
}
