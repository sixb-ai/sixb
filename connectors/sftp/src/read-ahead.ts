import type { Callback, SFTPWrapper } from "ssh2"

// The SFTP specification requires servers to support 32 KiB read payloads.
const READ_CHUNK_SIZE_BYTES = 32 * 1024

type ScheduledRead = {
  readonly offset: number
  readonly requestedBytes: number
  readonly result: Promise<ReadResult>
}

type ReadResult = {
  readonly bytes: Uint8Array
}

export async function openSftpReadAheadStream(
  sftpClient: SFTPWrapper,
  path: string,
  readAheadRequests: number,
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const handle = await openSftpHandle(sftpClient, path, signal)
  if (signal?.aborted) {
    await callVoid((callback) => sftpClient.close(handle, callback)).catch(() => {})
    throw abortError(signal)
  }
  const source = new SftpReadAheadSource(sftpClient, handle, readAheadRequests, signal)

  return new ReadableStream<Uint8Array>({
    start() {
      source.start()
    },
    pull(controller) {
      return source.pull(controller)
    },
    cancel(reason) {
      return source.cancel(reason)
    },
  })
}

class SftpReadAheadSource {
  private readonly pendingReads = new Map<number, ScheduledRead>()
  private readonly abortPromise: Promise<never>
  private rejectAbort: ((reason: unknown) => void) | undefined
  private nextRequestOffset = 0
  private nextOutputOffset = 0
  private terminal = false
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly sftpClient: SFTPWrapper,
    private readonly handle: Buffer,
    private readonly readAheadRequests: number,
    private readonly signal?: AbortSignal
  ) {
    this.abortPromise = new Promise<never>((_resolve, reject) => {
      this.rejectAbort = reject
    })
    void this.abortPromise.catch(() => {})
    this.signal?.addEventListener("abort", this.onAbort, { once: true })
  }

  start(): void {
    this.scheduleWindow()
  }

  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.terminal) {
      return
    }

    try {
      this.signal?.throwIfAborted()
      const scheduled = this.pendingReads.get(this.nextOutputOffset)
      if (!scheduled) {
        throw new Error(
          `[SixbSftp] Missing read-ahead request at remote file offset ${this.nextOutputOffset}.`
        )
      }

      const result = await scheduled.result
      this.signal?.throwIfAborted()
      this.pendingReads.delete(scheduled.offset)

      if (result.bytes.byteLength === 0) {
        await this.finish()
        controller.close()
        return
      }

      this.nextOutputOffset += result.bytes.byteLength
      if (result.bytes.byteLength < scheduled.requestedBytes) {
        // Short responses are valid. Fill the remainder before emitting a later prefetched range.
        this.scheduleRead(this.nextOutputOffset, scheduled.requestedBytes - result.bytes.byteLength)
      } else {
        this.scheduleWindow()
      }

      controller.enqueue(result.bytes)
    } catch (error) {
      this.fail()
      controller.error(error)
    }
  }

  cancel(_reason: unknown): Promise<void> {
    this.terminal = true
    this.cleanupAbortListener()
    this.pendingReads.clear()
    return this.closeHandle()
  }

  private readonly onAbort = (): void => {
    const reason = this.signal ? abortError(this.signal) : new Error("SFTP read aborted.")
    this.rejectAbort?.(reason)
    this.rejectAbort = undefined
    void this.closeHandle().catch(() => {})
  }

  private scheduleWindow(): void {
    while (!this.terminal && this.pendingReads.size < this.readAheadRequests) {
      this.scheduleRead(this.nextRequestOffset, READ_CHUNK_SIZE_BYTES)
      this.nextRequestOffset += READ_CHUNK_SIZE_BYTES
    }
  }

  private scheduleRead(offset: number, requestedBytes: number): void {
    const result = Promise.race([
      readSftpChunk(this.sftpClient, this.handle, offset, requestedBytes),
      this.abortPromise,
    ])
    void result.catch(() => {})
    this.pendingReads.set(offset, { offset, requestedBytes, result })
  }

  private async finish(): Promise<void> {
    this.terminal = true
    try {
      // Reads after the first EOF are speculative. Let them settle before closing the shared handle.
      await Promise.allSettled([...this.pendingReads.values()].map((read) => read.result))
      this.pendingReads.clear()
      this.signal?.throwIfAborted()
      await Promise.race([this.closeHandle(), this.abortPromise])
    } finally {
      this.cleanupAbortListener()
    }
  }

  private fail(): void {
    this.terminal = true
    this.cleanupAbortListener()
    this.pendingReads.clear()
    void this.closeHandle().catch(() => {})
  }

  private closeHandle(): Promise<void> {
    this.closePromise ??= callVoid((callback) => this.sftpClient.close(this.handle, callback))
    return this.closePromise
  }

  private cleanupAbortListener(): void {
    this.signal?.removeEventListener("abort", this.onAbort)
    this.rejectAbort = undefined
  }
}

function openSftpHandle(
  sftpClient: SFTPWrapper,
  path: string,
  signal?: AbortSignal
): Promise<Buffer> {
  signal?.throwIfAborted()

  return new Promise((resolve, reject) => {
    let aborted = false
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    const onAbort = () => {
      aborted = true
      cleanup()
      reject(signal ? abortError(signal) : new Error("SFTP open aborted."))
    }

    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      sftpClient.open(path, "r", (error, handle) => {
        cleanup()
        if (aborted) {
          if (handle) {
            void callVoid((callback) => sftpClient.close(handle, callback)).catch(() => {})
          }
          return
        }
        if (error) {
          reject(error)
          return
        }

        resolve(handle)
      })
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

function readSftpChunk(
  sftpClient: SFTPWrapper,
  handle: Buffer,
  offset: number,
  requestedBytes: number
): Promise<ReadResult> {
  const buffer = Buffer.allocUnsafe(requestedBytes)

  return new Promise((resolve, reject) => {
    sftpClient.read(handle, buffer, 0, requestedBytes, offset, (error, bytesRead) => {
      if (error) {
        reject(error)
        return
      }
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > requestedBytes) {
        reject(
          new Error(
            `[SixbSftp] Invalid read size ${bytesRead} at remote file offset ${offset}; expected 0-${requestedBytes}.`
          )
        )
        return
      }

      resolve({ bytes: buffer.subarray(0, bytesRead) })
    })
  })
}

function callVoid(method: (callback: Callback) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    method((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError")
}
