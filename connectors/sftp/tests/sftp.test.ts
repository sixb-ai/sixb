import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
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
    await server.waitForIdle()
  })
})
