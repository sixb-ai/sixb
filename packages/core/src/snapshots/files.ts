import { randomUUID } from "node:crypto"
import { rename, rm } from "node:fs/promises"
import { join } from "node:path"

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

/** A snapshot file's bytes, as {@link importSnapshot} reads them. */
export async function* readSnapshotFile(path: string): AsyncGenerator<Uint8Array> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`[Sixb] No snapshot at '${path}': take one first.`)
  }

  yield* file.stream()
}

/**
 * A snapshot written to a file in `directory` first, then read back: production's read closes
 * at export speed, however slowly the consumer goes, as for a load into a branch on the same
 * instance. The file is removed once read, or once the reader stops.
 */
export async function* spoolSnapshot(
  snapshot: AsyncIterable<Uint8Array>,
  directory: string
): AsyncGenerator<Uint8Array> {
  const path = join(directory, `snapshot-${randomUUID()}.sixbsnap`)
  await writeSnapshotFile(path, snapshot)

  try {
    yield* readSnapshotFile(path)
  } finally {
    await rm(path, { force: true })
  }
}
