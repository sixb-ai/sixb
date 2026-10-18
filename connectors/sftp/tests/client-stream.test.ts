import { expect, test } from "bun:test"
import { Readable } from "node:stream"
import type { SFTPWrapper, ReadStream as Ssh2ReadStream } from "ssh2"
import { createSftpClient } from "../src/client"

function fixture(closeError?: Error) {
  let sent = false
  let destroyed = false
  let finishClose: (() => void) | undefined
  const closed = new Promise<void>((resolve) => {
    finishClose = resolve
  })
  const source = new Readable({
    read() {
      if (!sent) {
        sent = true
        this.push(Buffer.from("chunk"))
      }
    },
    destroy(error, callback) {
      destroyed = true
      // Model ssh2's closeStream: cb(closeError || originalError).
      callback(closeError ?? error)
      finishClose?.()
    },
  }) as Ssh2ReadStream
  const sftp = {
    createReadStream() {
      queueMicrotask(() => source.emit("open"))
      return source
    },
  } as unknown as SFTPWrapper
  return {
    client: createSftpClient(sftp, { readAheadRequests: 1 }),
    source,
    closed,
    destroyed: () => destroyed,
  }
}

// Negative control: restore the old nodeStream.destroy(abortError(signal)) listener. ssh2's
// simulated CLOSE failure then replaces the requested abort reason and this test fails.
test("SFTP abort preserves its reason even when closing the remote handle fails", async () => {
  const f = fixture(new Error("Failure"))
  const abort = new AbortController()
  const reader = (await f.client.open("/file", { signal: abort.signal })).getReader()
  expect((await reader.read()).done).toBe(false)
  const reason = new Error("stop sftp read")
  abort.abort(reason)
  expect(await reader.read().catch((error: unknown) => error)).toBe(reason)
  await f.closed
  expect(f.destroyed()).toBe(true)
})

test("SFTP stream still propagates remote read errors without an abort", async () => {
  const f = fixture()
  const reader = (
    await f.client.open("/file", { signal: new AbortController().signal })
  ).getReader()
  expect((await reader.read()).done).toBe(false)
  const failure = new Error("remote read failed")
  f.source.destroy(failure)
  expect(await reader.read().catch((error: unknown) => error)).toBe(failure)
})

test("canceling the SFTP consumer still closes the remote handle", async () => {
  const f = fixture()
  const reader = (
    await f.client.open("/file", { signal: new AbortController().signal })
  ).getReader()
  expect((await reader.read()).done).toBe(false)
  await reader.cancel()
  await f.closed
  expect(f.destroyed()).toBe(true)
})
