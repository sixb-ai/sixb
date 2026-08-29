import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sftp } from "../src"
import { startTestSftpServer } from "./testServer"

describe("sftp connector", () => {
  let server: Awaited<ReturnType<typeof startTestSftpServer>>

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

  afterEach(async () => {
    await server.waitForIdle()
  })

  test("lists and stats remote files", async () => {
    await writeFile(join(server.rootDir, "files", "hello.txt"), "hello")

    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

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
    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
      await client.write("/files/report.txt", "alpha")
      expect((await client.read("/files/report.txt")).toString("utf8")).toBe("alpha")

      await client.rename("/files/report.txt", "/files/report-final.txt")
      expect(await client.exists("/files/report.txt")).toBe(false)
      expect(await client.exists("/files/report-final.txt")).toBe(true)

      await client.delete("/files/report-final.txt")
      expect(await client.exists("/files/report-final.txt")).toBe(false)
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("opens remote files as web streams", async () => {
    await writeFile(join(server.rootDir, "files", "stream.txt"), "streamed over sftp")
    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
      const stream = await client.open("/files/stream.txt")
      expect(await new Response(stream).text()).toBe("streamed over sftp")
      await expect(client.open("/files/missing.txt")).rejects.toThrow()
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("opens remote files with bounded read-ahead", async () => {
    const content = Buffer.alloc(256 * 1024 + 17)
    for (let index = 0; index < content.length; index += 1) {
      content[index] = index % 251
    }
    await writeFile(join(server.rootDir, "files", "read-ahead.bin"), content)
    await writeFile(join(server.rootDir, "files", "empty-read-ahead.bin"), Buffer.alloc(0))
    server.configureReads({
      delayMs: (offset) => (offset === 0 ? 30 : 5),
    })
    const adapter = sftp(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.password,
      },
      { readAheadRequests: 4 }
    )
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
      const stream = await client.open("/files/read-ahead.bin")
      expect(Buffer.from(await new Response(stream).arrayBuffer())).toEqual(content)
      expect(server.readMetrics().maxConcurrentRequests).toBeGreaterThan(1)
      expect(server.readMetrics().maxConcurrentRequests).toBeLessThanOrEqual(4)
      expect(
        (await new Response(await client.open("/files/empty-read-ahead.bin")).arrayBuffer())
          .byteLength
      ).toBe(0)
      await expect(client.open("/files/missing-read-ahead.bin")).rejects.toThrow()
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("fills short SFTP responses without gaps or duplicate bytes", async () => {
    const content = Buffer.alloc(96 * 1024 + 31)
    for (let index = 0; index < content.length; index += 1) {
      content[index] = index % 239
    }
    await writeFile(join(server.rootDir, "files", "short-reads.bin"), content)
    server.configureReads({ maxResponseBytes: 4 * 1024 + 3 })
    const adapter = sftp(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.password,
      },
      { readAheadRequests: 4 }
    )
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
      const stream = await client.open("/files/short-reads.bin")
      expect(Buffer.from(await new Response(stream).arrayBuffer())).toEqual(content)
      expect(server.readMetrics().totalRequests).toBeGreaterThan(4)
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("surfaces a read-ahead request failure without returning partial success", async () => {
    await writeFile(join(server.rootDir, "files", "failed-read.bin"), Buffer.alloc(128 * 1024, 1))
    server.configureReads({ failAtOffset: 32 * 1024 })
    const adapter = sftp(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.password,
      },
      { readAheadRequests: 4 }
    )
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
      const stream = await client.open("/files/failed-read.bin")
      await expect(new Response(stream).arrayBuffer()).rejects.toThrow()
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("aborts read-ahead while requests are in flight", async () => {
    await writeFile(join(server.rootDir, "files", "abort-read-ahead.bin"), Buffer.alloc(256 * 1024))
    server.configureReads({ delayMs: () => 100 })
    const adapter = sftp(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.password,
      },
      { readAheadRequests: 4 }
    )
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })
    const abort = new AbortController()

    try {
      const reader = (
        await client.open("/files/abort-read-ahead.bin", { signal: abort.signal })
      ).getReader()
      const firstRead = reader.read()
      abort.abort(new Error("stop read-ahead"))

      await expect(firstRead).rejects.toThrow("stop read-ahead")
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("aborts read-ahead before returning a queued chunk", async () => {
    await writeFile(
      join(server.rootDir, "files", "abort-queued-read-ahead.bin"),
      Buffer.alloc(256 * 1024)
    )
    server.configureReads({
      delayMs: (offset) => (offset === 0 ? 30 : 0),
    })
    const adapter = sftp(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.password,
      },
      { readAheadRequests: 4 }
    )
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })
    const abort = new AbortController()

    try {
      const reader = (
        await client.open("/files/abort-queued-read-ahead.bin", { signal: abort.signal })
      ).getReader()
      const firstRead = await reader.read()
      expect(firstRead.done).toBe(false)

      // Later prefetched ranges finish before the delayed first range. Yield so the stream's
      // automatic pull can enqueue the next range while the consumer is paused between reads.
      await new Promise((resolve) => setTimeout(resolve, 0))
      abort.abort(new Error("stop queued read-ahead"))

      await expect(reader.read()).rejects.toThrow("stop queued read-ahead")
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("cancels read-ahead and closes its remote handle", async () => {
    await writeFile(
      join(server.rootDir, "files", "cancel-read-ahead.bin"),
      Buffer.alloc(256 * 1024)
    )
    server.configureReads({ delayMs: () => 25 })
    const adapter = sftp(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.password,
      },
      { readAheadRequests: 4 }
    )
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
      const reader = (await client.open("/files/cancel-read-ahead.bin")).getReader()
      await reader.cancel("consumer stopped")
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("disconnects while a read-ahead stream is active", async () => {
    await writeFile(
      join(server.rootDir, "files", "disconnect-read-ahead.bin"),
      Buffer.alloc(256 * 1024)
    )
    server.configureReads({ delayMs: () => 100 })
    const adapter = sftp(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.password,
      },
      { readAheadRequests: 4 }
    )
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })
    const reader = (await client.open("/files/disconnect-read-ahead.bin")).getReader()
    const firstRead = reader.read()

    await adapter.disconnect?.(client)

    await expect(firstRead).rejects.toThrow()
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

  test("aborts an active remote file stream", async () => {
    await writeFile(join(server.rootDir, "files", "large.bin"), Buffer.alloc(2 * 1024 * 1024, 1))
    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })
    const abort = new AbortController()

    try {
      const reader = (await client.open("/files/large.bin", { signal: abort.signal })).getReader()
      expect((await reader.read()).done).toBe(false)

      abort.abort(new Error("stop sftp read"))

      await expect(reader.read()).rejects.toThrow("stop sftp read")
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("rejects an open canceled before it starts", async () => {
    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })
    const abort = new AbortController()
    abort.abort(new Error("already canceled"))

    try {
      await expect(
        client.open("/files/never-opened.bin", { signal: abort.signal })
      ).rejects.toThrow("already canceled")
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("creates and removes directories", async () => {
    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
      await client.mkdir("/files/archive")
      expect(await client.exists("/files/archive")).toBe(true)

      await client.rmdir("/files/archive")
      expect(await client.exists("/files/archive")).toBe(false)
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("requests directory modes and changes them explicitly", async () => {
    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
      await client.mkdir("/files/private", { mode: 0o700 })
      expect((await client.stat("/files/private")).mode & 0o7777).toBe(0o700)

      await client.chmod("/files/private", 0o770)
      expect((await client.stat("/files/private")).mode & 0o7777).toBe(0o770)
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("ensures deep directories", async () => {
    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
      await client.ensureDir("/files/archive/2026/06/reports")

      const stats = await client.stat("/files/archive/2026/06/reports")
      expect(stats.isDirectory()).toBe(true)
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("ensureDir is idempotent when directories already exist", async () => {
    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
      await client.ensureDir("/files/archive/2026")
      await client.ensureDir("/files/archive/2026")

      const stats = await client.stat("/files/archive/2026")
      expect(stats.isDirectory()).toBe(true)
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("ensureDir applies a mode only to missing segments", async () => {
    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
      await client.mkdir("/files/archive", { mode: 0o700 })
      await client.ensureDir("/files/archive/2026/reports", { mode: 0o755 })

      expect((await client.stat("/files/archive")).mode & 0o7777).toBe(0o700)
      expect((await client.stat("/files/archive/2026")).mode & 0o7777).toBe(0o755)
      expect((await client.stat("/files/archive/2026/reports")).mode & 0o7777).toBe(0o755)
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("rejects invalid directory modes before sending SFTP requests", async () => {
    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
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
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("ensureDir fails when a parent segment is a file", async () => {
    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    try {
      await client.write("/files/archive", "not a directory")

      await expect(client.ensureDir("/files/archive/2026")).rejects.toThrow(
        "exists and is not a directory"
      )
    } finally {
      await adapter.disconnect?.(client)
    }
  })

  test("closes the ssh connection on disconnect", async () => {
    const adapter = sftp({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "files",
      signal: new AbortController().signal,
    })

    await adapter.disconnect?.(client)
  })
})
