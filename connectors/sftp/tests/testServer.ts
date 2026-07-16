import { mkdirSync } from "node:fs"
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Attributes, FileEntry, SFTPWrapper, Server as SshServer } from "ssh2"
import { Server, utils } from "ssh2"

const USERNAME = "demo"
const PASSWORD = "demo"

type OpenFileHandle = {
  kind: "file"
  handle: Awaited<ReturnType<typeof open>>
}

type OpenDirectoryHandle = {
  kind: "directory"
  path: string
  sent: boolean
}

type OpenHandle = OpenFileHandle | OpenDirectoryHandle

export interface TestSftpServer {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
  readonly rootDir: string
  configureReads(behavior?: TestSftpReadBehavior): void
  readMetrics(): TestSftpReadMetrics
  waitForIdle(): Promise<void>
  close(): Promise<void>
}

export type TestSftpReadBehavior = {
  readonly delayMs?: (offset: number) => number
  readonly failAtOffset?: number
  readonly maxResponseBytes?: number
}

export type TestSftpReadMetrics = {
  readonly maxConcurrentRequests: number
  readonly offsets: readonly number[]
  readonly totalRequests: number
}

export async function startTestSftpServer(): Promise<TestSftpServer> {
  const hostKey = utils.generateKeyPairSync("ed25519").private
  const rootDir = await mkdtemp(join(tmpdir(), "sixb-sftp-"))
  mkdirSync(join(rootDir, "files"), { recursive: true })
  let activeConnections = 0
  let idleWaiters: Array<() => void> = []
  let readBehavior: TestSftpReadBehavior = {}
  let activeReadRequests = 0
  let maxConcurrentReadRequests = 0
  let readOffsets: number[] = []
  const resolveIdleWaiters = () => {
    if (activeConnections !== 0 || activeReadRequests !== 0) {
      return
    }

    for (const resolveIdle of idleWaiters) {
      resolveIdle()
    }
    idleWaiters = []
  }
  const waitForIdle = () => {
    if (activeConnections === 0 && activeReadRequests === 0) {
      return Promise.resolve()
    }

    return new Promise<void>((resolveIdle) => {
      idleWaiters.push(resolveIdle)
    })
  }

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    activeConnections += 1

    client
      .on("authentication", (context) => {
        if (
          context.method === "password" &&
          context.username === USERNAME &&
          context.password === PASSWORD
        ) {
          context.accept()
          return
        }

        context.reject()
      })
      .on("ready", () => {
        client.on("session", (acceptSession) => {
          const session = acceptSession()

          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp()
            bindSftpHandlers(sftp, rootDir, {
              behavior: () => readBehavior,
              finishRequest() {
                activeReadRequests -= 1
                resolveIdleWaiters()
              },
              startRequest(offset) {
                activeReadRequests += 1
                maxConcurrentReadRequests = Math.max(maxConcurrentReadRequests, activeReadRequests)
                readOffsets.push(offset)
              },
            })
          })
        })
      })
      .on("close", () => {
        activeConnections -= 1
        resolveIdleWaiters()
      })
      .on("end", () => {
        // Bun can leave ssh2's accepted socket half-open after the peer ends
        // a connection with an errored SFTP read still settling. The ssh2
        // server connection does not expose its transport publicly, so the
        // test server closes that transport explicitly.
        const transport = (client as unknown as { _sock?: { destroy(): void } })._sock
        transport?.destroy()
      })
  })

  const port = await listen(server)

  return {
    host: "127.0.0.1",
    port,
    username: USERNAME,
    password: PASSWORD,
    rootDir,
    configureReads(behavior = {}) {
      if (activeReadRequests !== 0) {
        throw new Error("[SixbSftpTest] Cannot reconfigure active read requests.")
      }
      readBehavior = behavior
      maxConcurrentReadRequests = 0
      readOffsets = []
    },
    readMetrics() {
      return {
        maxConcurrentRequests: maxConcurrentReadRequests,
        offsets: [...readOffsets],
        totalRequests: readOffsets.length,
      }
    },
    waitForIdle,
    async close() {
      await waitForIdle()

      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error)
            return
          }

          resolveClose()
        })
      })

      await rm(rootDir, { force: true, recursive: true })
    },
  }
}

function bindSftpHandlers(
  sftp: SFTPWrapper,
  rootDir: string,
  readControl: {
    readonly behavior: () => TestSftpReadBehavior
    readonly finishRequest: () => void
    readonly startRequest: (offset: number) => void
  }
): void {
  const handles = new Map<number, OpenHandle>()
  let nextHandle = 1

  const createHandle = (value: OpenHandle) => {
    const id = nextHandle++
    handles.set(id, value)
    const handle = Buffer.alloc(4)
    handle.writeUInt32BE(id, 0)
    return handle
  }

  const getHandle = (handle: Buffer): OpenHandle | null => {
    if (handle.length !== 4) {
      return null
    }

    return handles.get(handle.readUInt32BE(0)) ?? null
  }

  const deleteHandle = (handle: Buffer) => {
    if (handle.length !== 4) {
      return
    }

    handles.delete(handle.readUInt32BE(0))
  }

  sftp
    .on("REALPATH", (reqid, path) => {
      const resolvedPath = normalizeRemotePath(path)
      sftp.name(reqid, [
        {
          filename: resolvedPath,
          longname: resolvedPath,
          attrs: emptyAttributes(),
        },
      ])
    })
    .on("STAT", async (reqid, path) => {
      await respondWithStats(sftp, reqid, () => stat(resolveRemotePath(rootDir, path)))
    })
    .on("LSTAT", async (reqid, path) => {
      await respondWithStats(sftp, reqid, () => lstat(resolveRemotePath(rootDir, path)))
    })
    .on("FSTAT", async (reqid, handle) => {
      const entry = getHandle(handle)
      if (!entry || entry.kind !== "file") {
        sftp.status(reqid, utils.sftp.STATUS_CODE.FAILURE)
        return
      }

      await respondWithStats(sftp, reqid, () => entry.handle.stat())
    })
    .on("OPEN", async (reqid, filename, flags) => {
      const mode = utils.sftp.flagsToString(flags)
      if (!mode) {
        sftp.status(reqid, utils.sftp.STATUS_CODE.FAILURE)
        return
      }

      try {
        const fileHandle = await open(resolveRemotePath(rootDir, filename), mode)
        sftp.handle(reqid, createHandle({ kind: "file", handle: fileHandle }))
      } catch (error) {
        sftp.status(reqid, mapErrorToStatus(error))
      }
    })
    .on("READ", async (reqid, handle, offset, length) => {
      readControl.startRequest(offset)
      try {
        const entry = getHandle(handle)
        if (!entry || entry.kind !== "file") {
          sftp.status(reqid, utils.sftp.STATUS_CODE.FAILURE)
          return
        }

        const behavior = readControl.behavior()
        const delayMs = behavior.delayMs?.(offset) ?? 0
        if (delayMs > 0) {
          await delay(delayMs)
        }
        if (behavior.failAtOffset === offset) {
          sftp.status(reqid, utils.sftp.STATUS_CODE.FAILURE)
          return
        }

        const responseBytes = Math.min(length, behavior.maxResponseBytes ?? length)
        const buffer = Buffer.alloc(responseBytes)
        const { bytesRead } = await entry.handle.read(buffer, 0, responseBytes, offset)

        if (bytesRead === 0) {
          sftp.status(reqid, utils.sftp.STATUS_CODE.EOF)
          return
        }

        sftp.data(reqid, buffer.subarray(0, bytesRead))
      } catch (error) {
        sftp.status(reqid, mapErrorToStatus(error))
      } finally {
        readControl.finishRequest()
      }
    })
    .on("WRITE", async (reqid, handle, offset, data) => {
      const entry = getHandle(handle)
      if (!entry || entry.kind !== "file") {
        sftp.status(reqid, utils.sftp.STATUS_CODE.FAILURE)
        return
      }

      try {
        await entry.handle.write(data, 0, data.length, offset)
        sftp.status(reqid, utils.sftp.STATUS_CODE.OK)
      } catch (error) {
        sftp.status(reqid, mapErrorToStatus(error))
      }
    })
    .on("CLOSE", async (reqid, handle) => {
      const entry = getHandle(handle)
      if (!entry) {
        sftp.status(reqid, utils.sftp.STATUS_CODE.FAILURE)
        return
      }

      deleteHandle(handle)

      try {
        if (entry.kind === "file") {
          await entry.handle.close()
        }

        sftp.status(reqid, utils.sftp.STATUS_CODE.OK)
      } catch (error) {
        sftp.status(reqid, mapErrorToStatus(error))
      }
    })
    .on("OPENDIR", async (reqid, path) => {
      try {
        await stat(resolveRemotePath(rootDir, path))
        sftp.handle(
          reqid,
          createHandle({ kind: "directory", path: resolveRemotePath(rootDir, path), sent: false })
        )
      } catch (error) {
        sftp.status(reqid, mapErrorToStatus(error))
      }
    })
    .on("READDIR", async (reqid, handle) => {
      const entry = getHandle(handle)
      if (!entry || entry.kind !== "directory") {
        sftp.status(reqid, utils.sftp.STATUS_CODE.FAILURE)
        return
      }

      if (entry.sent) {
        sftp.status(reqid, utils.sftp.STATUS_CODE.EOF)
        return
      }

      try {
        const names = await readDirectoryEntries(entry.path)
        entry.sent = true
        sftp.name(reqid, names)
      } catch (error) {
        sftp.status(reqid, mapErrorToStatus(error))
      }
    })
    .on("REMOVE", async (reqid, path) => {
      try {
        await unlink(resolveRemotePath(rootDir, path))
        sftp.status(reqid, utils.sftp.STATUS_CODE.OK)
      } catch (error) {
        sftp.status(reqid, mapErrorToStatus(error))
      }
    })
    .on("RENAME", async (reqid, oldPath, newPath) => {
      try {
        await rename(resolveRemotePath(rootDir, oldPath), resolveRemotePath(rootDir, newPath))
        sftp.status(reqid, utils.sftp.STATUS_CODE.OK)
      } catch (error) {
        sftp.status(reqid, mapErrorToStatus(error))
      }
    })
    .on("MKDIR", async (reqid, path) => {
      try {
        await mkdir(resolveRemotePath(rootDir, path))
        sftp.status(reqid, utils.sftp.STATUS_CODE.OK)
      } catch (error) {
        sftp.status(reqid, mapErrorToStatus(error))
      }
    })
    .on("RMDIR", async (reqid, path) => {
      try {
        await rmdir(resolveRemotePath(rootDir, path))
        sftp.status(reqid, utils.sftp.STATUS_CODE.OK)
      } catch (error) {
        sftp.status(reqid, mapErrorToStatus(error))
      }
    })
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs))
}

async function respondWithStats(
  sftp: SFTPWrapper,
  reqid: number,
  loadStats: () => Promise<Awaited<ReturnType<typeof stat>>>
): Promise<void> {
  try {
    sftp.attrs(reqid, toSftpAttributes(await loadStats()))
  } catch (error) {
    sftp.status(reqid, mapErrorToStatus(error))
  }
}

async function readDirectoryEntries(path: string): Promise<FileEntry[]> {
  const entries = await readdir(path, { withFileTypes: true })

  return Promise.all(
    entries.map(async (entry) => {
      const stats = await lstat(join(path, entry.name))
      return {
        filename: entry.name,
        longname: entry.name,
        attrs: toSftpAttributes(stats),
      }
    })
  )
}

function toSftpAttributes(stats: Awaited<ReturnType<typeof stat>>): Attributes {
  return {
    mode: Number(stats.mode),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    size: Number(stats.size),
    atime: Math.floor(Number(stats.atimeMs) / 1000),
    mtime: Math.floor(Number(stats.mtimeMs) / 1000),
  }
}

function emptyAttributes(): Attributes {
  return {
    mode: 0,
    uid: 0,
    gid: 0,
    size: 0,
    atime: 0,
    mtime: 0,
  }
}

function resolveRemotePath(rootDir: string, remotePath: string): string {
  const normalizedPath = normalizeRemotePath(remotePath)
  const resolvedPath = resolve(rootDir, `.${normalizedPath}`)

  if (resolvedPath !== rootDir && !resolvedPath.startsWith(`${rootDir}/`)) {
    throw new Error("[SixbSftpTest] Remote path escapes test root.")
  }

  return resolvedPath
}

function normalizeRemotePath(path: string): string {
  if (!path || path === ".") {
    return "/"
  }

  return path.startsWith("/") ? path : `/${path}`
}

function mapErrorToStatus(error: unknown): number {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "ENOENT") {
      return utils.sftp.STATUS_CODE.NO_SUCH_FILE
    }

    if (error.code === "EACCES" || error.code === "EPERM") {
      return utils.sftp.STATUS_CODE.PERMISSION_DENIED
    }
  }

  return utils.sftp.STATUS_CODE.FAILURE
}

async function listen(server: SshServer): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()

      if (!address || typeof address === "string") {
        rejectListen(new Error("[SixbSftpTest] Failed to resolve test server address."))
        return
      }

      resolveListen(address.port)
    })

    server.once("error", rejectListen)
  })
}
