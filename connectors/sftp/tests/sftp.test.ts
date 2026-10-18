import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type SftpClient, type SftpOptions, sftp } from "../src"
import { startTestSftpServer } from "./testServer"

describe("sftp connector", () => {
  let server: Awaited<ReturnType<typeof startTestSftpServer>>

  // Never settles: a held read is released only when its connection closes.
  const heldUntilDisconnect = () => new Promise<void>(() => {})

  beforeAll(async () => {
    server = await startTestSftpServer()
  })

  afterAll(async () => {
    await server.close()
  })

  beforeEach(async () => {
    await rm(join(server.rootDir, "files"), { force: true, recursive: true })
    await mkdir(join(server.rootDir, "files"), { recursive: true })
    server.configureReads()
  })

  // Waiting for the server to see every connection close also proves each test's disconnect.
  afterEach(async () => {
    await server.waitForIdle()
  })

  async function connect(options?: SftpOptions) {
    const adapter = sftp(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.password,
      },
      options
    )
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    return { adapter, client }
  }

  async function withClient(
    run: (client: SftpClient) => Promise<void>,
    options?: SftpOptions
  ): Promise<void> {
    const { adapter, client } = await connect(options)

    try {
      await run(client)
    } finally {
      await adapter.disconnect?.(client)
    }
  }

  test("lists and stats remote files", async () => {
    await writeFile(join(server.rootDir, "files", "hello.txt"), "hello")
    const { adapter, client } = await connect()

    try {
      const entries = await client.list("/files")
      const stats = await client.stat("/files/hello.txt")

      expect(adapter.type).toBe("sftp")
      expect(entries.map((entry) => entry.filename)).toContain("hello.txt")
      expect(stats.isFile()).toBe(true)
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("reads, writes, renames, and deletes remote files", async () => {
    await withClient(async (client) => {
      await client.write("/files/report.txt", "alpha")
      expect((await client.read("/files/report.txt")).toString("utf8")).toBe("alpha")

      await client.rename("/files/report.txt", "/files/report-final.txt")
      expect(await client.exists("/files/report.txt")).toBe(false)
      expect(await client.exists("/files/report-final.txt")).toBe(true)

      await client.delete("/files/report-final.txt")
      expect(await client.exists("/files/report-final.txt")).toBe(false)
    })
  })

  test("opens remote files as web streams", async () => {
    await writeFile(join(server.rootDir, "files", "stream.txt"), "streamed over sftp")

    await withClient(async (client) => {
      const stream = await client.open("/files/stream.txt")
      expect(await new Response(stream).text()).toBe("streamed over sftp")
      await expect(client.open("/files/missing.txt")).rejects.toThrow()
    })
  })

  test("opens remote files with bounded read-ahead", async () => {
    const content = Buffer.alloc(256 * 1024 + 17)
    for (let index = 0; index < content.length; index += 1) {
      content[index] = index % 251
    }
    await writeFile(join(server.rootDir, "files", "read-ahead.bin"), content)
    await writeFile(join(server.rootDir, "files", "empty-read-ahead.bin"), Buffer.alloc(0))
    // The first range is answered only after the three ranges prefetched behind it.
    server.configureReads({
      holdUntil: (offset) => (offset === 0 ? server.readsFinished(3) : undefined),
    })

    await withClient(
      async (client) => {
        const stream = await client.open("/files/read-ahead.bin")
        expect(Buffer.from(await new Response(stream).arrayBuffer())).toEqual(content)
        expect(server.readMetrics().maxConcurrentRequests).toBeGreaterThan(1)
        expect(server.readMetrics().maxConcurrentRequests).toBeLessThanOrEqual(4)
        expect(
          (await new Response(await client.open("/files/empty-read-ahead.bin")).arrayBuffer())
            .byteLength
        ).toBe(0)
        await expect(client.open("/files/missing-read-ahead.bin")).rejects.toThrow()
      },
      { readAheadRequests: 4 }
    )
  })

  test("fills short SFTP responses without gaps or duplicate bytes", async () => {
    const content = Buffer.alloc(96 * 1024 + 31)
    for (let index = 0; index < content.length; index += 1) {
      content[index] = index % 239
    }
    await writeFile(join(server.rootDir, "files", "short-reads.bin"), content)
    server.configureReads({ maxResponseBytes: 4 * 1024 + 3 })

    await withClient(
      async (client) => {
        const stream = await client.open("/files/short-reads.bin")
        expect(Buffer.from(await new Response(stream).arrayBuffer())).toEqual(content)
        expect(server.readMetrics().totalRequests).toBeGreaterThan(4)
      },
      { readAheadRequests: 4 }
    )
  })

  test("surfaces a read-ahead request failure without returning partial success", async () => {
    await writeFile(join(server.rootDir, "files", "failed-read.bin"), Buffer.alloc(128 * 1024, 1))
    server.configureReads({ failAtOffset: 32 * 1024 })

    await withClient(
      async (client) => {
        const stream = await client.open("/files/failed-read.bin")
        const error = await new Response(stream).arrayBuffer().catch((cause: unknown) => cause)
        expect(error).toBeInstanceOf(Error)
      },
      { readAheadRequests: 4 }
    )
  })

  test("aborts read-ahead while requests are in flight", async () => {
    await writeFile(join(server.rootDir, "files", "abort-read-ahead.bin"), Buffer.alloc(256 * 1024))
    const abort = new AbortController()
    const aborted = new Promise<void>((resolve) => {
      abort.signal.addEventListener("abort", () => resolve(), { once: true })
    })
    // Every range is still in flight when the abort lands; the server answers them right after.
    server.configureReads({ holdUntil: () => aborted })

    await withClient(
      async (client) => {
        const reader = (
          await client.open("/files/abort-read-ahead.bin", { signal: abort.signal })
        ).getReader()
        const firstRead = reader.read()
        const reason = new Error("stop read-ahead")
        abort.abort(reason)

        expect(await firstRead.catch((error: unknown) => error)).toBe(reason)
      },
      { readAheadRequests: 4 }
    )
  })

  test("aborts read-ahead before returning a queued chunk", async () => {
    await writeFile(
      join(server.rootDir, "files", "abort-queued-read-ahead.bin"),
      Buffer.alloc(256 * 1024)
    )
    server.configureReads({
      holdUntil: (offset) => (offset === 0 ? server.readsFinished(3) : undefined),
    })
    const abort = new AbortController()

    await withClient(
      async (client) => {
        const reader = (
          await client.open("/files/abort-queued-read-ahead.bin", { signal: abort.signal })
        ).getReader()
        const firstRead = await reader.read()
        expect(firstRead.done).toBe(false)

        // Later prefetched ranges finish before the held first range. Yield so the stream's
        // automatic pull can enqueue the next range while the consumer is paused between reads.
        await new Promise((resolve) => setTimeout(resolve, 0))
        const reason = new Error("stop queued read-ahead")
        abort.abort(reason)

        expect(await reader.read().catch((error: unknown) => error)).toBe(reason)
      },
      { readAheadRequests: 4 }
    )
  })

  test("cancels read-ahead and closes its remote handle", async () => {
    await writeFile(
      join(server.rootDir, "files", "cancel-read-ahead.bin"),
      Buffer.alloc(256 * 1024)
    )
    server.configureReads({ holdUntil: heldUntilDisconnect })

    await withClient(
      async (client) => {
        const reader = (await client.open("/files/cancel-read-ahead.bin")).getReader()
        expect(server.openFileCount()).toBe(1)

        await reader.cancel("consumer stopped")
        expect(server.openFileCount()).toBe(0)
      },
      { readAheadRequests: 4 }
    )
  })

  test("disconnects while a read-ahead stream is active", async () => {
    await writeFile(
      join(server.rootDir, "files", "disconnect-read-ahead.bin"),
      Buffer.alloc(256 * 1024)
    )
    server.configureReads({ holdUntil: heldUntilDisconnect })
    const { adapter, client } = await connect({ readAheadRequests: 4 })
    const reader = (await client.open("/files/disconnect-read-ahead.bin")).getReader()
    const firstRead = reader.read()

    await adapter.disconnect?.(client)

    expect(await firstRead.catch((error: unknown) => error)).toBeInstanceOf(Error)
    await server.waitForIdle()
    Bun.gc(true)
    await Bun.sleep(0)
  })

  test("validates read-ahead configuration before connecting", () => {
    const connection = {
      host: "127.0.0.1",
      username: "demo",
      password: "demo",
    }

    expect(() => sftp(connection, { readAheadRequests: 1 })).not.toThrow()
    expect(() => sftp(connection, { readAheadRequests: 64 })).not.toThrow()
    expect(() => sftp(connection, { readAheadRequests: 0 })).toThrow(
      "readAheadRequests must be an integer between 1 and 64"
    )
    expect(() => sftp(connection, { readAheadRequests: 65 })).toThrow(
      "readAheadRequests must be an integer between 1 and 64"
    )
    expect(() => sftp(connection, { readAheadRequests: 1.5 })).toThrow(
      "readAheadRequests must be an integer between 1 and 64"
    )
  })

  test("rejects an open canceled before it starts", async () => {
    const abort = new AbortController()
    abort.abort(new Error("already canceled"))

    await withClient(async (client) => {
      await expect(
        client.open("/files/never-opened.bin", { signal: abort.signal })
      ).rejects.toThrow("already canceled")
    })
  })

  test("creates and removes directories", async () => {
    await withClient(async (client) => {
      await client.mkdir("/files/archive")
      expect(await client.exists("/files/archive")).toBe(true)

      await client.rmdir("/files/archive")
      expect(await client.exists("/files/archive")).toBe(false)
    })
  })

  test("requests directory modes and changes them explicitly", async () => {
    await withClient(async (client) => {
      await client.mkdir("/files/private", { mode: 0o700 })
      expect((await client.stat("/files/private")).mode & 0o7777).toBe(0o700)

      await client.chmod("/files/private", 0o770)
      expect((await client.stat("/files/private")).mode & 0o7777).toBe(0o770)
    })
  })

  test("ensures deep directories idempotently", async () => {
    await withClient(async (client) => {
      await client.ensureDir("/files/archive/2026/06/reports")
      await client.ensureDir("/files/archive/2026/06/reports")

      const stats = await client.stat("/files/archive/2026/06/reports")
      expect(stats.isDirectory()).toBe(true)
    })
  })

  test("ensureDir applies a mode only to missing segments", async () => {
    await withClient(async (client) => {
      await client.mkdir("/files/archive", { mode: 0o700 })
      await client.ensureDir("/files/archive/2026/reports", { mode: 0o755 })

      expect((await client.stat("/files/archive")).mode & 0o7777).toBe(0o700)
      expect((await client.stat("/files/archive/2026")).mode & 0o7777).toBe(0o755)
      expect((await client.stat("/files/archive/2026/reports")).mode & 0o7777).toBe(0o755)
    })
  })

  test("rejects invalid directory modes before sending SFTP requests", async () => {
    await withClient(async (client) => {
      expect(() => client.mkdir("/files/negative", { mode: -1 })).toThrow(
        "mkdir mode must be an integer between 0o0000 and 0o7777"
      )
      expect(() => client.ensureDir("/files/fractional", { mode: 0.5 })).toThrow(
        "ensureDir mode must be an integer between 0o0000 and 0o7777"
      )
      expect(() => client.chmod("/files", 0o10000)).toThrow(
        "chmod mode must be an integer between 0o0000 and 0o7777"
      )

      expect(await client.exists("/files/negative")).toBe(false)
      expect(await client.exists("/files/fractional")).toBe(false)
    })
  })

  test("ensureDir fails when a parent segment is a file", async () => {
    await withClient(async (client) => {
      await client.write("/files/archive", "not a directory")

      await expect(client.ensureDir("/files/archive/2026")).rejects.toThrow(
        "exists and is not a directory"
      )
    })
  })
})
